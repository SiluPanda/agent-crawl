import { SmartFetcher } from './core/SmartFetcher.js';
import { Markdownifier } from './cleaners/Markdownifier.js';
import { BrowserManager } from './core/BrowserManager.js';
import { CacheManager } from './core/CacheManager.js';
import { ScrapeConfig, ScrapedPage, CrawlConfig, CrawlResult } from './types.js';
import { asVercelTool, asVercelCrawlTool } from './adapters/vercel.js';
import { asOpenAITool, asOpenAICrawlTool } from './adapters/openai.js';

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
    private static getCacheKey(url: string, config: ScrapeConfig): string {
        const parts = [
            url,
            config.mode || 'hybrid',
            config.extractMainContent ? 'main' : 'full',
            config.optimizeTokens ? 'optimized' : 'raw',
            config.waitFor || '',
        ];
        return parts.join(':');
    }

    static async scrape(url: string, config: ScrapeConfig = {}): Promise<ScrapedPage> {
        // Default mode is 'hybrid' as per spec (tries static, falls back to browser)
        const mode = config.mode || 'hybrid';

        // Check Cache first to avoid unnecessary network requests
        const cacheKey = this.getCacheKey(url, config);
        const cached = this.cache.get(cacheKey);
        if (cached) {
            return cached;
        }

        let html = '';
        let status = 0;
        let headers: Record<string, string> = {};

        // 1. Try Static Fetch (if mode is static or hybrid)
        // This is much faster and cheaper than spinning up a browser
        if (mode === 'static' || mode === 'hybrid') {
            const result = await this.fetcher.fetch(url);

            if (result.isStaticSuccess) {
                html = result.html;
                status = result.status;
                headers = result.headers;
            } else if (mode === 'static') {
                // If static only and failed, we stop here
                console.warn(`Static fetch failed for ${url} (Status: ${result.status}).`);
                return {
                    url,
                    content: '',
                    title: '',
                    metadata: { error: `Static fetch failed: ${result.status}` }
                };
            }
        }

        // 2. Fallback to Browser (if mode is browser or hybrid fallback needed)
        // Triggered if static fetch failed or detected dynamic content (needsJS)
        if ((mode === 'browser') || (mode === 'hybrid' && !html)) {
            console.log(`Switching to Browser for ${url}...`);
            try {
                const waitForSelector = config.waitFor;
                html = await this.browserManager.getPage(url, waitForSelector);
                status = 200; // Assumed success if no throw
            } catch (e: any) {
                console.error(`Browser scrape failed: ${e.message}`);
                return {
                    url,
                    content: '',
                    title: '',
                    metadata: { error: `Browser scrape failed: ${e.message}` }
                };
            }
        }

        // 3. Extract all content in a single pass (optimized - parses HTML only once)
        // This extracts title, links, and converts to markdown efficiently
        const extracted = this.markdownifier.extractAll(html, url, {
            extractMainContent: config.extractMainContent ?? false,
            optimizeTokens: config.optimizeTokens ?? true, // Default to true as per spec
        });

        const result: ScrapedPage = {
            url,
            content: extracted.markdown,
            title: extracted.title,
            links: extracted.links,
            metadata: {
                status,
                contentLength: extracted.markdown.length,
                ...headers
            }
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
            output: config.output,
            waitFor: config.waitFor,
            extractMainContent: config.extractMainContent,
            optimizeTokens: config.optimizeTokens,
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
        const pages: ScrapedPage[] = [];
        const errors: Array<{ url: string; error: string }> = [];
        let maxDepthReached = 0;

        // BFS queue: { url, depth }
        const queue: Array<{ url: string; depth: number }> = [{ url: startUrl, depth: 0 }];

        while (queue.length > 0 && pages.length < maxPages) {
            // Take a batch of URLs up to concurrency limit
            const batch: Array<{ url: string; depth: number }> = [];
            while (batch.length < concurrency && queue.length > 0 && (pages.length + batch.length) < maxPages) {
                const item = queue.shift()!;
                
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
                    
                    // Check if scrape was successful (has content)
                    if (page.content || !page.metadata?.error) {
                        pages.push(page);
                        maxDepthReached = Math.max(maxDepthReached, depth);

                        // Add discovered links to queue (if not at max depth)
                        if (depth < maxDepth && page.links) {
                            for (const link of page.links) {
                                // Only add same-origin links that haven't been visited
                                if (link.startsWith(baseOrigin) && !visited.has(link)) {
                                    queue.push({ url: link, depth: depth + 1 });
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
}
