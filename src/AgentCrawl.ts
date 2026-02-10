import { SmartFetcher } from './core/SmartFetcher.js';
import { Markdownifier } from './cleaners/Markdownifier.js';
import { BrowserManager, BrowserPageOptions } from './core/BrowserManager.js';
import { CacheManager } from './core/CacheManager.js';
import { ScrapeConfig, ScrapedPage, CrawlConfig, CrawlResult, StealthLevel, DiskCacheConfig, HttpCacheConfig, ChunkingConfig, CrawlStateConfig } from './types.js';
import { normalizeUrl, safeHttpUrl } from './core/UrlUtils.js';
import { fetchRobotsTxt, isAllowedByRobots, RobotsTxt } from './core/Robots.js';
import { HostScheduler } from './core/HostScheduler.js';
import { DiskKv } from './core/DiskKv.js';
import { chunkMarkdown } from './core/Chunker.js';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

interface NormalizedScrapeConfig {
    mode: 'static' | 'hybrid' | 'browser';
    waitFor?: string;
    extractMainContent: boolean;
    optimizeTokens: boolean;
    stealth: boolean;
    stealthLevel: StealthLevel;
    maxResponseBytes?: number;
    cache?: boolean | DiskCacheConfig;
    httpCache?: boolean | HttpCacheConfig;
    chunking?: boolean | ChunkingConfig;
}

/**
 * The main facade for the Cassini library.
 * Orchestrates fetching, cleaning, and caching of web content.
 * Provides static methods for easy integration.
 */
export class AgentCrawl {
    private static fetcher = new SmartFetcher();
    private static markdownifier = new Markdownifier();
    private static browserManager = BrowserManager.getInstance();
    private static cache = new CacheManager();

    private static normalizeUrlForDedupe(input: string): string {
        try {
            return normalizeUrl(input);
        } catch {
            // Best-effort fallback; also strip hash if present.
            return input.split('#')[0];
        }
    }

    /**
     * Generate a cache key from URL and config
     */
    private static getCacheKey(url: string, config: NormalizedScrapeConfig): string {
        const parts = [
            url,
            config.mode,
            config.extractMainContent ? 'main' : 'full',
            config.optimizeTokens ? 'optimized' : 'raw',
            config.stealth ? 'stealth' : 'no-stealth',
            config.stealthLevel,
            config.waitFor || '',
        ];
        return parts.join(':');
    }

    private static normalizeScrapeConfig(config: ScrapeConfig = {}): NormalizedScrapeConfig {
        const waitFor = config.waitFor?.trim();
        const stealth = config.stealth ?? false;
        return {
            mode: config.mode ?? 'hybrid',
            waitFor: waitFor || undefined,
            extractMainContent: config.extractMainContent ?? false,
            optimizeTokens: config.optimizeTokens ?? true,
            stealth,
            stealthLevel: stealth ? (config.stealthLevel ?? 'balanced') : 'balanced',
            maxResponseBytes: config.maxResponseBytes,
            cache: config.cache,
            httpCache: config.httpCache,
            chunking: config.chunking,
        };
    }

    private static diskCacheFromConfig<T>(cfg: boolean | DiskCacheConfig | undefined, subdir: string): DiskKv<T> | null {
        if (!cfg) return null;
        const c = typeof cfg === 'boolean' ? {} : cfg;
        const enabled = c.enabled ?? true;
        if (!enabled) return null;
        const dir = c.dir ?? '.cache/agent-crawl';
        const ttlMs = c.ttlMs ?? 5 * 60_000;
        const maxEntries = c.maxEntries ?? 1000;
        return new DiskKv<T>({ dir: path.join(dir, subdir), ttlMs, maxEntries });
    }

    private static crawlStatePath(startUrl: string, cfg: CrawlStateConfig): string {
        const dir = cfg.dir ?? '.cache/agent-crawl/state';
        const id = cfg.id ?? createHash('sha256').update(startUrl).digest('hex').slice(0, 16);
        return path.join(dir, `${id}.json`);
    }

    private static toErrorPage(
        url: string,
        error: string,
        status = 0,
        headers: Record<string, string> = {}
    ): ScrapedPage {
        return {
            url,
            content: '',
            title: '',
            metadata: {
                ...headers,
                status,
                error,
            },
        };
    }

    static async scrape(url: string, config: ScrapeConfig = {}): Promise<ScrapedPage> {
        const normalizedConfig = this.normalizeScrapeConfig(config);
        const { mode, waitFor, extractMainContent, optimizeTokens, stealth, stealthLevel, maxResponseBytes, cache, httpCache, chunking } = normalizedConfig;

        // Check Cache first to avoid unnecessary network requests
        const cacheKey = this.getCacheKey(url, normalizedConfig);
        const cached = this.cache.get(cacheKey);
        if (cached) {
            return cached;
        }

        const diskCache = this.diskCacheFromConfig<ScrapedPage>(cache, 'scrape');
        if (diskCache) {
            const diskHit = await diskCache.get(cacheKey);
            if (diskHit) {
                this.cache.set(cacheKey, diskHit);
                return diskHit;
            }
        }

        let html = '';
        let status = 0;
        let headers: Record<string, string> = {};
        let finalUrl = url;
        let browserUsed = false;
        let staticError: string | null = null;
        let shouldUseBrowserFallback = mode === 'browser';

        // 1. Try Static Fetch (if mode is static or hybrid)
        // This is much faster and cheaper than spinning up a browser
        if (mode === 'static' || mode === 'hybrid') {
            const result = await this.fetcher.fetch(url, {
                maxResponseBytes,
                httpCache,
            });
            status = result.status;
            headers = result.headers;
            finalUrl = result.finalUrl ?? result.url ?? url;

            if (result.isStaticSuccess) {
                html = result.html;
            } else if (result.needsBrowser && mode === 'hybrid') {
                shouldUseBrowserFallback = true;
            } else if (result.needsBrowser && mode === 'static') {
                staticError = 'Static mode detected dynamic content. Use mode "hybrid" or "browser".';
            } else {
                staticError = result.error || `Static fetch failed${result.status ? `: HTTP ${result.status}` : ''}`;
            }
        }

        // 2. Fallback to Browser (if mode is browser or hybrid fallback needed)
        // Triggered only for browser mode or hybrid dynamic-content fallback.
        if (shouldUseBrowserFallback && !html) {
            console.log(`Switching to Browser for ${url}...`);
            try {
                const browserOptions: BrowserPageOptions = {
                    stealth,
                    stealthLevel,
                };
                const browserResult = await this.browserManager.getPage(url, waitFor, browserOptions);
                browserUsed = true;
                html = browserResult.html;
                status = browserResult.status;
                headers = browserResult.headers;
                finalUrl = browserResult.finalUrl ?? finalUrl;

                if (status < 200 || status >= 300) {
                    return this.toErrorPage(url, `Browser fetch returned HTTP ${status}`, status, headers);
                }
            } catch (e: any) {
                console.error(`Browser scrape failed: ${e.message}`);
                return this.toErrorPage(url, `Browser scrape failed: ${e.message}`, 0, headers);
            }
        }

        if (!html) {
            if (staticError) {
                return this.toErrorPage(url, staticError, status, headers);
            }
            return this.toErrorPage(url, 'No HTML content was fetched', status, headers);
        }

        // 3. Extract all content in a single pass (optimized - parses HTML only once)
        // This extracts title, links, and converts to markdown efficiently
        const extracted = this.markdownifier.extractAll(html, finalUrl, {
            extractMainContent,
            optimizeTokens,
        });

        const result: ScrapedPage = {
            url: finalUrl,
            content: extracted.markdown,
            title: extracted.title,
            links: extracted.links,
            metadata: (() => {
                const metadata: Record<string, any> = {
                    ...headers,
                    status,
                    contentLength: extracted.markdown.length,
                    structured: extracted.structured,
                };

                if (browserUsed) {
                    metadata.stealthApplied = stealth;
                    if (stealth) {
                        metadata.stealthLevel = stealthLevel;
                    }
                }

                return metadata;
            })(),
        };

        const chunkCfg = typeof chunking === 'boolean' ? { enabled: chunking } : (chunking ?? {});
        if (chunkCfg.enabled) {
            const maxTokens = chunkCfg.maxTokens ?? 1200;
            const overlapTokens = chunkCfg.overlapTokens ?? 0;
            result.chunks = chunkMarkdown(result.content, { url: result.url, maxTokens, overlapTokens });
        }

        // Cache the result to speed up subsequent requests
        this.cache.set(cacheKey, result);
        if (diskCache) {
            await diskCache.set(cacheKey, result).catch(() => {});
        }

        return result;
    }

    /**
     * Crawl a website starting from the given URL.
     * Uses BFS traversal with configurable depth, page limit, and concurrency.
     */
    static async crawl(startUrl: string, config: CrawlConfig = {}): Promise<CrawlResult> {
        const maxDepth = config.maxDepth ?? 1;
        const maxPages = config.maxPages ?? 10;
        const concurrency = config.concurrency ?? 2;
        const perHostConcurrency = config.perHostConcurrency ?? concurrency;
        const includePatterns = config.includePatterns ?? [];
        const excludePatterns = config.excludePatterns ?? [];

        const robotsCfg = typeof config.robots === 'boolean' ? { enabled: config.robots } : (config.robots ?? {});
        const robotsEnabled = robotsCfg.enabled === true;
        const robotsUserAgent = robotsCfg.userAgent ?? 'agent-crawl';
        const respectCrawlDelay = robotsCfg.respectCrawlDelay ?? true;

        const sitemapCfg = typeof config.sitemap === 'boolean' ? { enabled: config.sitemap } : (config.sitemap ?? {});
        const sitemapEnabled = sitemapCfg.enabled === true;
        const sitemapMaxUrls = sitemapCfg.maxUrls ?? 1000;

        const stateCfg0 = typeof config.crawlState === 'boolean' ? { enabled: config.crawlState } : (config.crawlState ?? {});
        const stateEnabled = stateCfg0.enabled === true;
        const stateCfg: CrawlStateConfig = {
            enabled: true,
            dir: stateCfg0.dir,
            id: stateCfg0.id,
            resume: stateCfg0.resume ?? true,
            flushEvery: stateCfg0.flushEvery ?? 10,
            persistPages: stateCfg0.persistPages ?? true,
        };

        // Extract scrape-specific config
        const scrapeConfig: ScrapeConfig = {
            mode: config.mode,
            waitFor: config.waitFor,
            extractMainContent: config.extractMainContent,
            optimizeTokens: config.optimizeTokens,
            stealth: config.stealth,
            stealthLevel: config.stealthLevel,
            maxResponseBytes: config.maxResponseBytes,
            cache: config.cache,
            httpCache: config.httpCache,
            chunking: config.chunking,
        };

        // Normalize start URL and get base origin for same-origin filtering
        let baseOrigin: string;
        try {
            const parsed = new URL(startUrl);
            baseOrigin = parsed.origin;
            startUrl = normalizeUrl(parsed.href);
        } catch {
            return {
                pages: [],
                totalPages: 0,
                maxDepthReached: 0,
                errors: [{ url: startUrl, error: 'Invalid start URL' }],
            };
        }

        const scheduler = new HostScheduler(perHostConcurrency, config.minDelayMs ?? 0);
        let robots: RobotsTxt | null = null;
        if (robotsEnabled) {
            robots = await fetchRobotsTxt(baseOrigin, robotsUserAgent);
        }

        const matchesPatterns = (url: string): boolean => {
            const included = includePatterns.length === 0
                ? true
                : includePatterns.some((p) => url.includes(p));
            if (!included) return false;
            if (excludePatterns.some((p) => url.includes(p))) return false;
            return true;
        };

        const shouldQueue = (absoluteUrl: string): boolean => {
            if (!absoluteUrl.startsWith(baseOrigin)) return false;
            const u = safeHttpUrl(absoluteUrl);
            if (!u) return false;
            if (!matchesPatterns(absoluteUrl)) return false;
            if (robotsEnabled && robots && !isAllowedByRobots(absoluteUrl, robots)) return false;
            return true;
        };

        const visited = new Set<string>();
        const queued = new Set<string>();
        const pages: ScrapedPage[] = [];
        const errors: Array<{ url: string; error: string }> = [];
        let maxDepthReached = 0;

        const queue: Array<{ url: string; depth: number }> = [];
        const statePath = stateEnabled ? this.crawlStatePath(startUrl, stateCfg) : null;
        if (stateEnabled && stateCfg.resume && statePath) {
            try {
                const raw = await fs.readFile(statePath, 'utf-8');
                const parsed = JSON.parse(raw) as any;
                if (parsed?.queue && parsed?.visited && parsed?.queued) {
                    for (const u of parsed.visited as string[]) visited.add(u);
                    for (const u of parsed.queued as string[]) queued.add(u);
                    if (stateCfg.persistPages && Array.isArray(parsed.pages)) pages.push(...(parsed.pages as ScrapedPage[]));
                    if (Array.isArray(parsed.errors)) errors.push(...parsed.errors);
                    maxDepthReached = parsed.maxDepthReached ?? 0;
                    // Hydrate queue after sets exist.
                    for (const item of parsed.queue as Array<{ url: string; depth: number }>) {
                        if (typeof item?.url === 'string' && typeof item?.depth === 'number') {
                            // Avoid re-queueing already visited.
                            if (!visited.has(item.url)) {
                                queue.push(item);
                            }
                        }
                    }
                }
            } catch {
                // ignore resume failures
            }
        }

        // BFS queue: { url, depth }
        const normalizedStartUrl = this.normalizeUrlForDedupe(startUrl);
        if (shouldQueue(normalizedStartUrl)) {
            if (!queued.has(normalizedStartUrl) && !visited.has(normalizedStartUrl)) {
                queue.push({ url: normalizedStartUrl, depth: 0 });
            }
        }
        queued.add(normalizedStartUrl);

        if (sitemapEnabled) {
            const sitemapUrl = `${baseOrigin}/sitemap.xml`;
            try {
                const res = await this.fetcher.fetch(sitemapUrl, { retries: 0, timeout: 10000, maxResponseBytes: 2_000_000, httpCache: config.httpCache });
                if (res.status >= 200 && res.status < 300 && res.html) {
                    const locs = Array.from(res.html.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)).map((m) => m[1]);
                    for (const loc of locs.slice(0, sitemapMaxUrls)) {
                        const normalized = this.normalizeUrlForDedupe(loc);
                        if (shouldQueue(normalized) && !queued.has(normalized) && !visited.has(normalized)) {
                            queue.push({ url: normalized, depth: 0 });
                            queued.add(normalized);
                        }
                    }
                }
            } catch {
                // ignore sitemap failures
            }
        }

        const persistState = async () => {
            if (!stateEnabled || !statePath) return;
            await fs.mkdir(path.dirname(statePath), { recursive: true }).catch(() => {});
            const tmp = `${statePath}.tmp`;
            const payload = {
                version: 1,
                startUrl,
                baseOrigin,
                queue,
                visited: Array.from(visited),
                queued: Array.from(queued),
                pages: stateCfg.persistPages ? pages : [],
                errors,
                maxDepthReached,
                updatedAt: Date.now(),
            };
            await fs.writeFile(tmp, JSON.stringify(payload), 'utf-8');
            await fs.rename(tmp, statePath);
        };

        let batches = 0;
        while (queue.length > 0 && pages.length < maxPages) {
            // Take a batch of URLs up to concurrency limit
            const batch: Array<{ url: string; depth: number }> = [];
            while (batch.length < concurrency && queue.length > 0 && (pages.length + batch.length) < maxPages) {
                const item = queue.shift()!;
                queued.delete(item.url);

                // Skip if already visited or exceeds max depth
                if (visited.has(item.url) || item.depth > maxDepth) {
                    continue;
                }

                visited.add(item.url);
                batch.push(item);
            }

            if (batch.length === 0) continue;

            // Process batch concurrently
            const results = await Promise.allSettled(
                batch.map(async ({ url, depth }) => {
                    const host = new URL(url).host;
                    const delayMs = respectCrawlDelay && robots?.rules.crawlDelayMs ? robots.rules.crawlDelayMs : 0;
                    const effectiveDelay = Math.max(config.minDelayMs ?? 0, delayMs);
                    const localScheduler = effectiveDelay === (config.minDelayMs ?? 0)
                        ? scheduler
                        : new HostScheduler(perHostConcurrency, effectiveDelay);

                    const page = await localScheduler.run(host, async () => this.scrape(url, scrapeConfig));
                    return { page, depth };
                })
            );

            // Process results
            for (let i = 0; i < results.length; i++) {
                const result = results[i];
                const { url, depth } = batch[i];

                if (result.status === 'fulfilled') {
                    const { page } = result.value;
                    const canonicalVisited = this.normalizeUrlForDedupe(page.url);
                    visited.add(canonicalVisited);

                    // Successful scrape if no explicit metadata error
                    if (!page.metadata?.error) {
                        pages.push(page);
                        maxDepthReached = Math.max(maxDepthReached, depth);

                        // Add discovered links to queue (if not at max depth)
                        if (depth < maxDepth && page.links) {
                            for (const link of page.links) {
                                const normalizedLink = this.normalizeUrlForDedupe(link);
                                // Only add same-origin links that aren't visited or already queued
                                if (shouldQueue(normalizedLink) && !visited.has(normalizedLink) && !queued.has(normalizedLink)) {
                                    queue.push({ url: normalizedLink, depth: depth + 1 });
                                    queued.add(normalizedLink);
                                }
                            }
                        }
                    } else {
                        errors.push({ url, error: page.metadata?.error || 'Unknown error' });
                    }
                } else {
                    errors.push({ url, error: result.reason?.message || 'Failed to scrape' });
                }
            }

            batches++;
            if (stateEnabled && (batches % (stateCfg.flushEvery ?? 10) === 0)) {
                await persistState().catch(() => {});
            }
        }

        if (stateEnabled) {
            await persistState().catch(() => {});
        }

        return {
            pages,
            totalPages: pages.length,
            maxDepthReached,
            errors,
        };
    }

    /**
     * Explicitly close the browser instance.
     * Call this when you're done with all scraping/crawling operations
     * to ensure the process can exit immediately.
     */
    static async close(): Promise<void> {
        await this.browserManager.close();
    }
}
