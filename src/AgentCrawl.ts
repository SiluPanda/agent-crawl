import { SmartFetcher } from './core/SmartFetcher.js';
import { Markdownifier } from './cleaners/Markdownifier.js';
import { BrowserManager, BrowserPageOptions } from './core/BrowserManager.js';
import { CacheManager } from './core/CacheManager.js';
import { ScrapeConfig, ScrapedPage, CrawlConfig, CrawlResult, StealthLevel, DiskCacheConfig, HttpCacheConfig, ChunkingConfig, CrawlStateConfig, ExtractionConfig } from './types.js';
import { extractCss, extractRegex } from './core/Extractor.js';
import { normalizeUrl, safeHttpUrl, sanitizeUrlForLog, isPrivateHost } from './core/UrlUtils.js';
import { fetchRobotsTxt, isAllowedByRobots, RobotsTxt } from './core/Robots.js';
import { HostScheduler } from './core/HostScheduler.js';
import { DiskKv } from './core/DiskKv.js';
import { chunkMarkdown } from './core/Chunker.js';
import { createHash, randomBytes } from 'node:crypto';
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
    extraction?: ExtractionConfig;
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
    private static diskCacheInstances = new Map<string, DiskKv<any>>();
    private static readonly MAX_CACHE_INSTANCES = 50;

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
        // Use \0 as separator — can't appear in URLs or CSS selectors, preventing
        // cache key collisions when field values contain the separator character.
        const parts = [
            url,
            config.mode,
            config.extractMainContent ? '1' : '0',
            config.optimizeTokens ? '1' : '0',
            config.stealth ? '1' : '0',
            config.stealthLevel,
            config.waitFor || '',
        ];
        return parts.join('\0');
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
            extraction: config.extraction,
        };
    }

    /** Reject directory traversal in user-supplied dir configs. */
    private static safeCacheDir(dir: string): string {
        // Reject path traversal via .. segments
        const segments = dir.split(/[\\/]/);
        if (segments.some(s => s === '..')) {
            throw new Error(`Path traversal not allowed in cache dir: ${dir.slice(0, 100)}`);
        }
        return dir;
    }

    private static diskCacheFromConfig<T>(cfg: boolean | DiskCacheConfig | undefined, subdir: string): DiskKv<T> | null {
        if (!cfg) return null;
        const c = typeof cfg === 'boolean' ? {} : cfg;
        const enabled = c.enabled ?? true;
        if (!enabled) return null;
        const dir = this.safeCacheDir(c.dir ?? '.cache/agent-crawl');
        const ttlMs = c.ttlMs ?? 5 * 60_000;
        const maxEntries = c.maxEntries ?? 1000;
        const fullDir = path.join(dir, subdir);
        // Reuse instances with the same config to avoid redundant mkdir and pruning resets
        const cacheKey = `${fullDir}:${ttlMs}:${maxEntries}`;
        let instance = this.diskCacheInstances.get(cacheKey) as DiskKv<T> | undefined;
        if (!instance) {
            // Evict oldest entry if map is at capacity to prevent unbounded growth
            if (this.diskCacheInstances.size >= this.MAX_CACHE_INSTANCES) {
                const oldestKey = this.diskCacheInstances.keys().next().value;
                if (oldestKey) this.diskCacheInstances.delete(oldestKey);
            }
            instance = new DiskKv<T>({ dir: fullDir, ttlMs, maxEntries });
            this.diskCacheInstances.set(cacheKey, instance);
        }
        return instance;
    }

    private static crawlStatePath(startUrl: string, cfg: CrawlStateConfig): string {
        const dir = this.safeCacheDir(cfg.dir ?? '.cache/agent-crawl/state');
        const rawId = cfg.id ?? createHash('sha256').update(startUrl).digest('hex').slice(0, 16);
        // Sanitize id to prevent path traversal — allow only alphanumeric, hyphens, underscores
        const id = rawId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 128);
        return path.join(dir, `${id}.json`);
    }

    private static readonly MAX_ERROR_LENGTH = 500;

    private static toErrorPage(
        url: string,
        error: string,
        status = 0,
        headers: Record<string, string> = {}
    ): ScrapedPage {
        return {
            url: url.length > 2048 ? url.slice(0, 2048) : url,
            content: '',
            title: '',
            metadata: {
                status,
                error: error.length > this.MAX_ERROR_LENGTH
                    ? error.slice(0, this.MAX_ERROR_LENGTH) + '...'
                    : error,
                responseHeaders: headers,
            },
        };
    }

    private static readonly MAX_URL_LENGTH = 8192;

    static async scrape(url: string, config: ScrapeConfig = {}): Promise<ScrapedPage> {
        // Reject excessively long URLs before any processing
        if (url.length > this.MAX_URL_LENGTH) {
            return this.toErrorPage(url.slice(0, 200), `URL too long (${url.length} chars, max ${this.MAX_URL_LENGTH})`);
        }

        // Validate URL upfront before any cache I/O or network activity
        try {
            const parsed = new URL(url);
            if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
                return this.toErrorPage(url, `Non-HTTP protocol not supported: ${parsed.protocol}`);
            }
            // SSRF defense-in-depth: reject private/internal hosts before any I/O
            if (isPrivateHost(parsed.hostname)) {
                return this.toErrorPage(url, 'Request to private/internal host blocked');
            }
        } catch {
            return this.toErrorPage(url, 'Invalid URL');
        }

        const normalizedConfig = this.normalizeScrapeConfig(config);
        const { mode, waitFor, extractMainContent, optimizeTokens, stealth, stealthLevel, maxResponseBytes, cache, httpCache, chunking, extraction } = normalizedConfig;

        // Normalize URL for cache key to avoid duplicate scrapes for equivalent URLs
        const normalizedUrl = this.normalizeUrlForDedupe(url);

        // Check Cache first to avoid unnecessary network requests
        const cacheKey = this.getCacheKey(normalizedUrl, normalizedConfig);
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
            console.log(`Switching to Browser for ${sanitizeUrlForLog(url)}...`);
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
                const rawMsg = e instanceof Error ? e.message : String(e);
                // Strip filesystem paths from Playwright errors before exposing to caller
                const msg = rawMsg.replace(/(?:\/[\w.-]+){2,}/g, '[path]');
                const logMsg = rawMsg.length > 500 ? rawMsg.slice(0, 500) + '...' : rawMsg;
                console.error(`Browser scrape failed for ${sanitizeUrlForLog(url)}: ${logMsg}`);
                return this.toErrorPage(url, `Browser scrape failed: ${msg}`, 0, headers);
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

        // Run structured data extraction if configured
        let extractedData: Record<string, unknown> | undefined;
        if (extraction) {
            try {
                if (extraction.type === 'css') {
                    extractedData = extractCss(html, finalUrl, extraction);
                } else if (extraction.type === 'regex') {
                    extractedData = extractRegex(extracted.markdown, extraction);
                }
            } catch {
                // Extraction errors are non-fatal — the page still returns with content
            }
        }

        const result: ScrapedPage = {
            url: finalUrl,
            content: extracted.markdown,
            title: extracted.title,
            links: extracted.links,
            extracted: extractedData,
            metadata: (() => {
                // Place response headers under a dedicated key to prevent
                // server-controlled header names from overwriting reserved fields
                const metadata: Record<string, any> = {
                    status,
                    contentLength: extracted.markdown.length,
                    structured: extracted.structured,
                    responseHeaders: headers,
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
    /** Coerce to a finite number or return the fallback. Prevents NaN propagation from unvalidated config. */
    private static finiteOr(value: number | undefined, fallback: number): number {
        if (value === undefined || value === null) return fallback;
        const n = Number(value);
        return Number.isFinite(n) ? n : fallback;
    }

    static async crawl(startUrl: string, config: CrawlConfig = {}): Promise<CrawlResult> {
        const maxDepth = Math.min(Math.max(0, this.finiteOr(config.maxDepth, 1)), 100);
        const maxPages = Math.min(Math.max(1, this.finiteOr(config.maxPages, 10)), 100_000);
        const concurrency = Math.min(Math.max(1, this.finiteOr(config.concurrency, 2)), 50);
        const perHostConcurrency = Math.min(Math.max(1, this.finiteOr(config.perHostConcurrency, concurrency)), concurrency);
        const includePatterns = config.includePatterns ?? [];
        const excludePatterns = config.excludePatterns ?? [];

        const robotsCfg = typeof config.robots === 'boolean' ? { enabled: config.robots } : (config.robots ?? {});
        const robotsEnabled = robotsCfg.enabled === true;
        const robotsUserAgent = robotsCfg.userAgent ?? 'agent-crawl';
        const respectCrawlDelay = robotsCfg.respectCrawlDelay ?? true;

        const sitemapCfg = typeof config.sitemap === 'boolean' ? { enabled: config.sitemap } : (config.sitemap ?? {});
        const sitemapEnabled = sitemapCfg.enabled === true;
        const sitemapMaxUrls = this.finiteOr(sitemapCfg.maxUrls, 1000);

        const stateCfg0 = typeof config.crawlState === 'boolean' ? { enabled: config.crawlState } : (config.crawlState ?? {});
        const stateEnabled = stateCfg0.enabled === true;
        const stateCfg: CrawlStateConfig = {
            enabled: true,
            dir: stateCfg0.dir,
            id: stateCfg0.id,
            resume: stateCfg0.resume ?? true,
            flushEvery: Math.max(1, this.finiteOr(stateCfg0.flushEvery, 10)),
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
            extraction: config.extraction,
        };

        // Reject excessively long start URLs before any processing
        if (startUrl.length > this.MAX_URL_LENGTH) {
            return {
                pages: [],
                totalPages: 0,
                maxDepthReached: 0,
                errors: [{ url: startUrl.slice(0, 200), error: `URL too long (${startUrl.length} chars, max ${this.MAX_URL_LENGTH})` }],
            };
        }

        // Normalize start URL and get base origin for same-origin filtering
        let baseOrigin: string;
        try {
            const parsed = new URL(startUrl);
            if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
                return {
                    pages: [],
                    totalPages: 0,
                    maxDepthReached: 0,
                    errors: [{ url: startUrl, error: `Non-HTTP protocol not supported: ${parsed.protocol}` }],
                };
            }
            // SSRF: reject private/internal hosts upfront with a clear error
            if (isPrivateHost(parsed.hostname)) {
                return {
                    pages: [],
                    totalPages: 0,
                    maxDepthReached: 0,
                    errors: [{ url: startUrl, error: 'Crawling private/internal hosts is not allowed' }],
                };
            }
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

        let robots: RobotsTxt | null = null;
        if (robotsEnabled) {
            robots = await fetchRobotsTxt(baseOrigin, robotsUserAgent);
        }
        const robotsCrawlDelayMs = (respectCrawlDelay && robots?.rules.crawlDelayMs) ? robots.rules.crawlDelayMs : 0;
        const effectiveMinDelay = Math.max(this.finiteOr(config.minDelayMs, 0), robotsCrawlDelayMs);
        const scheduler = new HostScheduler(perHostConcurrency, effectiveMinDelay);

        const matchesPatterns = (url: string): boolean => {
            const included = includePatterns.length === 0
                ? true
                : includePatterns.some((p) => url.includes(p));
            if (!included) return false;
            if (excludePatterns.some((p) => url.includes(p))) return false;
            return true;
        };

        const MAX_QUEUED_URL_LENGTH = 8192;
        const shouldQueue = (absoluteUrl: string): boolean => {
            if (absoluteUrl.length > MAX_QUEUED_URL_LENGTH) return false;
            const u = safeHttpUrl(absoluteUrl, { allowPrivate: false });
            if (!u) return false;
            // Same-origin check via parsed origin, NOT string prefix
            // (startsWith is fooled by userinfo: example.com@evil.com)
            if (u.origin !== baseOrigin) return false;
            if (!matchesPatterns(absoluteUrl)) return false;
            if (robotsEnabled && robots && !isAllowedByRobots(absoluteUrl, robots)) return false;
            return true;
        };

        // Cap queue and set sizes to prevent memory exhaustion on link-heavy sites
        const maxQueueSize = Math.min(Math.max(maxPages * 20, 10_000), 500_000);
        const maxVisitedSize = maxQueueSize * 2;

        const visited = new Set<string>();
        const queued = new Set<string>();
        const pages: ScrapedPage[] = [];
        const errors: Array<{ url: string; error: string }> = [];
        const maxErrors = maxPages * 2; // Cap errors to prevent unbounded growth
        let maxDepthReached = 0;

        const MAX_STATE_BYTES = 100 * 1024 * 1024; // 100MB cap for state file
        const MAX_RESTORED_CONTENT_LENGTH = 5 * 1024 * 1024; // 5MB cap per restored page content
        let queue: Array<{ url: string; depth: number }> = [];
        const statePath = stateEnabled ? this.crawlStatePath(startUrl, stateCfg) : null;
        // Clean up stale .tmp files from crashed writes in the state directory
        if (stateEnabled && statePath) {
            try {
                const stateDir = path.dirname(statePath);
                const dirEntries = await fs.readdir(stateDir).catch(() => [] as string[]);
                for (const entry of dirEntries) {
                    if (entry.endsWith('.tmp')) {
                        const tmpPath = path.join(stateDir, entry);
                        try {
                            const st = await fs.stat(tmpPath);
                            if (Date.now() - st.mtimeMs > 5 * 60_000) {
                                await fs.unlink(tmpPath).catch(() => {});
                            }
                        } catch { /* already deleted */ }
                    }
                }
            } catch { /* state dir may not exist yet */ }
        }
        if (stateEnabled && stateCfg.resume && statePath) {
            try {
                const stat = await fs.stat(statePath);
                if (stat.size > MAX_STATE_BYTES) {
                    console.warn('[AgentCrawl] State file too large, skipping resume');
                    throw new Error('State file too large');
                }
                const raw = await fs.readFile(statePath, 'utf-8');
                const parsed = JSON.parse(raw) as any;
                if (
                    parsed?.version === 1 &&
                    Array.isArray(parsed?.queue) &&
                    Array.isArray(parsed?.visited) &&
                    Array.isArray(parsed?.queued)
                ) {
                    for (const u of parsed.visited) {
                        if (typeof u === 'string' && u.length <= MAX_QUEUED_URL_LENGTH && visited.size < maxVisitedSize) visited.add(u);
                    }
                    // Skip loading parsed.queued into the queued set — stale entries
                    // would permanently block organic link discovery.
                    // The re-validation loop below adds valid items to both queue and queued.
                    if (stateCfg.persistPages && Array.isArray(parsed.pages)) {
                        const MAX_RESTORED_LINKS_PER_PAGE = 1000; // Cap per-page link validation to prevent DoS
                        for (const p of parsed.pages) {
                            if (pages.length >= maxPages) break;
                            if (
                                p && typeof p === 'object' && !Array.isArray(p) &&
                                typeof p.url === 'string' && p.url.length <= MAX_QUEUED_URL_LENGTH &&
                                typeof p.content === 'string' && p.content.length <= MAX_RESTORED_CONTENT_LENGTH &&
                                (p.title === undefined || (typeof p.title === 'string' && p.title.length <= 10_000)) &&
                                (p.links === undefined || (Array.isArray(p.links) && p.links.length <= 10_000)) &&
                                (p.metadata === undefined || (typeof p.metadata === 'object' && !Array.isArray(p.metadata)))
                            ) {
                                // Trim links to cap and validate only the first N to prevent DoS from huge link arrays
                                if (Array.isArray(p.links) && p.links.length > MAX_RESTORED_LINKS_PER_PAGE) {
                                    p.links = p.links.slice(0, MAX_RESTORED_LINKS_PER_PAGE);
                                }
                                // Validate link types (only check the capped subset)
                                if (Array.isArray(p.links) && !p.links.every((l: unknown) => typeof l === 'string' && l.length <= MAX_QUEUED_URL_LENGTH)) {
                                    p.links = p.links.filter((l: unknown) => typeof l === 'string' && l.length <= MAX_QUEUED_URL_LENGTH);
                                }
                                // Re-validate URL origin matches the crawl base origin
                                try {
                                    const pageOrigin = new URL(p.url).origin;
                                    if (pageOrigin !== baseOrigin) continue;
                                } catch { continue; }
                                pages.push(p as ScrapedPage);
                            }
                        }
                    }
                    if (Array.isArray(parsed.errors)) {
                        for (const e of parsed.errors) {
                            if (errors.length >= maxErrors) break;
                            if (e && typeof e.url === 'string' && e.url.length <= MAX_QUEUED_URL_LENGTH
                                && typeof e.error === 'string' && e.error.length <= 1000) {
                                errors.push(e);
                            }
                        }
                    }
                    maxDepthReached = typeof parsed.maxDepthReached === 'number' && Number.isFinite(parsed.maxDepthReached) && parsed.maxDepthReached >= 0
                        ? Math.min(parsed.maxDepthReached, maxDepth) : 0;
                    for (const item of parsed.queue) {
                        if (typeof item?.url === 'string' && typeof item?.depth === 'number'
                            && Number.isFinite(item.depth) && item.depth >= 0) {
                            // Re-validate restored items against current robots.txt, patterns, and origin
                            if (!visited.has(item.url) && shouldQueue(item.url) && item.depth <= maxDepth) {
                                queue.push(item);
                                queued.add(item.url);
                            }
                        }
                    }
                }
            } catch (e) {
                const stateErr = e instanceof Error ? e.message : String(e);
                console.warn(`[AgentCrawl] Failed to resume crawl state: ${stateErr.length > 200 ? stateErr.slice(0, 200) + '...' : stateErr}`);
            }
        }

        // BFS queue: { url, depth } — use index cursor instead of shift() for O(1) dequeue
        let queueHead = 0;
        const normalizedStartUrl = this.normalizeUrlForDedupe(startUrl);
        if (shouldQueue(normalizedStartUrl)) {
            if (!queued.has(normalizedStartUrl) && !visited.has(normalizedStartUrl)) {
                queue.push({ url: normalizedStartUrl, depth: 0 });
            }
        } else if (!visited.has(normalizedStartUrl)) {
            // Start URL failed pattern/robots filters — report so the caller knows
            errors.push({ url: normalizedStartUrl, error: 'Start URL excluded by includePatterns, excludePatterns, or robots.txt' });
        }
        queued.add(normalizedStartUrl);

        if (sitemapEnabled) {
            const sitemapUrl = `${baseOrigin}/sitemap.xml`;
            try {
                const res = await this.fetcher.fetch(sitemapUrl, { retries: 0, timeout: 10000, maxResponseBytes: 2_000_000, httpCache: config.httpCache });
                if (res.status >= 200 && res.status < 300 && res.html) {
                    const decodeXmlEntities = (s: string) =>
                        s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
                    const locs = Array.from(res.html.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)).map((m) => decodeXmlEntities(m[1]));
                    for (const loc of locs.slice(0, sitemapMaxUrls)) {
                        if ((queue.length - queueHead) >= maxQueueSize) break;
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

        let persistingState = false;
        const persistState = async () => {
            if (!stateEnabled || !statePath) return;
            if (persistingState) return; // Prevent concurrent writes
            persistingState = true;
            try {
                await fs.mkdir(path.dirname(statePath), { recursive: true }).catch(() => {});
                const tmp = `${statePath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
                const payload = {
                    version: 1,
                    startUrl,
                    baseOrigin,
                    queue: queue.slice(queueHead),
                    visited: Array.from(visited),
                    queued: Array.from(queued),
                    pages: stateCfg.persistPages ? pages : [],
                    errors,
                    maxDepthReached,
                    updatedAt: Date.now(),
                };
                let json: string;
                try {
                    json = JSON.stringify(payload);
                } catch {
                    return;
                }
                if (json.length > MAX_STATE_BYTES) {
                    payload.pages = [];
                    try { json = JSON.stringify(payload); } catch { return; }
                }
                try {
                    await fs.writeFile(tmp, json, 'utf-8');
                    await fs.rename(tmp, statePath);
                } catch {
                    await fs.unlink(tmp).catch(() => {});
                }
            } finally {
                persistingState = false;
            }
        };

        let batches = 0;
        while (queueHead < queue.length && pages.length < maxPages) {
            // Take a batch of URLs up to concurrency limit
            const batch: Array<{ url: string; depth: number }> = [];
            while (batch.length < concurrency && queueHead < queue.length && (pages.length + batch.length) < maxPages) {
                const item = queue[queueHead++];
                queued.delete(item.url);

                // Skip if already visited
                if (visited.has(item.url)) {
                    continue;
                }

                // Mark as visited even when over maxDepth to prevent re-queuing waste
                visited.add(item.url);

                if (item.depth > maxDepth) {
                    continue;
                }
                batch.push(item);
            }

            if (batch.length === 0) continue;

            // Process batch concurrently
            const results = await Promise.allSettled(
                batch.map(async ({ url, depth }) => {
                    let host: string;
                    try {
                        host = new URL(url).host;
                    } catch {
                        throw new Error(`Malformed URL in queue: ${url.slice(0, 100)}`);
                    }
                    const page = await scheduler.run(host, async () => this.scrape(url, scrapeConfig));
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
                        if (pages.length >= maxPages) continue;
                        pages.push(page);
                        maxDepthReached = Math.max(maxDepthReached, depth);

                        // Add discovered links to queue (if not at max depth)
                        if (depth < maxDepth && page.links) {
                            for (const link of page.links) {
                                if ((queue.length - queueHead) >= maxQueueSize) break;
                                if (visited.size >= maxVisitedSize) break;
                                const normalizedLink = this.normalizeUrlForDedupe(link);
                                // Only add same-origin links that aren't visited or already queued
                                if (shouldQueue(normalizedLink) && !visited.has(normalizedLink) && !queued.has(normalizedLink)) {
                                    queue.push({ url: normalizedLink, depth: depth + 1 });
                                    queued.add(normalizedLink);
                                }
                            }
                        }
                    } else {
                        if (errors.length < maxErrors) {
                            const errMsg = page.metadata?.error || 'Unknown error';
                            errors.push({ url, error: typeof errMsg === 'string' && errMsg.length > this.MAX_ERROR_LENGTH ? errMsg.slice(0, this.MAX_ERROR_LENGTH) + '...' : String(errMsg) });
                        }
                    }
                } else {
                    if (errors.length < maxErrors) {
                        const rawMsg = result.reason?.message || 'Failed to scrape';
                        errors.push({ url, error: rawMsg.length > this.MAX_ERROR_LENGTH ? rawMsg.slice(0, this.MAX_ERROR_LENGTH) + '...' : rawMsg });
                    }
                }
            }

            batches++;

            // Compact the queue array periodically to release consumed entries.
            // Use slice (creates new array for GC) instead of splice (O(n) in-place shift).
            if (queueHead > 10_000) {
                queue = queue.slice(queueHead);
                queueHead = 0;
            }

            if (stateEnabled && (batches % stateCfg.flushEvery! === 0)) {
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
        await this.browserManager.close(true);
    }
}
