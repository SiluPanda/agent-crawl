import { SmartFetcher } from './core/SmartFetcher.js';
import { Markdownifier } from './cleaners/Markdownifier.js';
import { BrowserManager, BrowserPageOptions } from './core/BrowserManager.js';
import { CacheManager } from './core/CacheManager.js';
import { ScrapeConfig, ScrapedPage, CrawlConfig, CrawlResult, StealthLevel } from './types.js';
import { asVercelTool, asVercelCrawlTool } from './adapters/vercel.js';
import { asOpenAITool, asOpenAICrawlTool } from './adapters/openai.js';

interface NormalizedScrapeConfig {
    mode: 'static' | 'hybrid' | 'browser';
    waitFor?: string;
    extractMainContent: boolean;
    optimizeTokens: boolean;
    stealth: boolean;
    stealthLevel: StealthLevel;
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
        };
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
        const { mode, waitFor, extractMainContent, optimizeTokens, stealth, stealthLevel } = normalizedConfig;

        // Check Cache first to avoid unnecessary network requests
        const cacheKey = this.getCacheKey(url, normalizedConfig);
        const cached = this.cache.get(cacheKey);
        if (cached) {
            return cached;
        }

        let html = '';
        let status = 0;
        let headers: Record<string, string> = {};
        let browserUsed = false;
        let staticError: string | null = null;
        let shouldUseBrowserFallback = mode === 'browser';

        // 1. Try Static Fetch (if mode is static or hybrid)
        // This is much faster and cheaper than spinning up a browser
        if (mode === 'static' || mode === 'hybrid') {
            const result = await this.fetcher.fetch(url);
            status = result.status;
            headers = result.headers;

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
        const extracted = this.markdownifier.extractAll(html, url, {
            extractMainContent,
            optimizeTokens,
        });

        const result: ScrapedPage = {
            url,
            content: extracted.markdown,
            title: extracted.title,
            links: extracted.links,
            metadata: (() => {
                const metadata: Record<string, any> = {
                    ...headers,
                    status,
                    contentLength: extracted.markdown.length,
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

        // Cache the result to speed up subsequent requests
        this.cache.set(cacheKey, result);

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

        // Extract scrape-specific config
        const scrapeConfig: ScrapeConfig = {
            mode: config.mode,
            waitFor: config.waitFor,
            extractMainContent: config.extractMainContent,
            optimizeTokens: config.optimizeTokens,
            stealth: config.stealth,
            stealthLevel: config.stealthLevel,
        };

        // Normalize start URL and get base origin for same-origin filtering
        let baseOrigin: string;
        try {
            const parsed = new URL(startUrl);
            baseOrigin = parsed.origin;
            startUrl = parsed.href;
        } catch {
            return {
                pages: [],
                totalPages: 0,
                maxDepthReached: 0,
                errors: [{ url: startUrl, error: 'Invalid start URL' }],
            };
        }

        const visited = new Set<string>();
        const queued = new Set<string>();
        const pages: ScrapedPage[] = [];
        const errors: Array<{ url: string; error: string }> = [];
        let maxDepthReached = 0;

        // BFS queue: { url, depth }
        const queue: Array<{ url: string; depth: number }> = [{ url: startUrl, depth: 0 }];
        queued.add(startUrl);

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
                    const page = await this.scrape(url, scrapeConfig);
                    return { page, depth };
                })
            );

            // Process results
            for (let i = 0; i < results.length; i++) {
                const result = results[i];
                const { url, depth } = batch[i];

                if (result.status === 'fulfilled') {
                    const { page } = result.value;

                    // Successful scrape if no explicit metadata error
                    if (!page.metadata?.error) {
                        pages.push(page);
                        maxDepthReached = Math.max(maxDepthReached, depth);

                        // Add discovered links to queue (if not at max depth)
                        if (depth < maxDepth && page.links) {
                            for (const link of page.links) {
                                // Only add same-origin links that aren't visited or already queued
                                if (link.startsWith(baseOrigin) && !visited.has(link) && !queued.has(link)) {
                                    queue.push({ url: link, depth: depth + 1 });
                                    queued.add(link);
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
        }

        return {
            pages,
            totalPages: pages.length,
            maxDepthReached,
            errors,
        };
    }

    static asVercelTool() {
        return asVercelTool();
    }

    static asVercelCrawlTool() {
        return asVercelCrawlTool();
    }

    static asOpenAITool() {
        return asOpenAITool();
    }

    static asOpenAICrawlTool() {
        return asOpenAICrawlTool();
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
