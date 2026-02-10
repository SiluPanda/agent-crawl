export interface FetchOptions {
    method?: 'GET' | 'POST';
    headers?: Record<string, string>;
    timeout?: number;
    retries?: number;
    maxResponseBytes?: number;
    httpCache?: boolean | HttpCacheConfig;
}

export interface FetchResult {
    url: string;
    finalUrl?: string;
    html: string;
    status: number;
    headers: Record<string, string>;
    isStaticSuccess: boolean;
    needsBrowser: boolean;
    error?: string;
}

export type StealthLevel = 'basic' | 'balanced';

export interface DiskCacheConfig {
    enabled?: boolean; // default: true when object is provided
    dir?: string; // default: ".cache/agent-crawl"
    ttlMs?: number; // default: 5 minutes
    maxEntries?: number; // default: 1000
}

export interface HttpCacheConfig extends DiskCacheConfig {
    // DiskCacheConfig is sufficient for the current implementation.
}

export interface ChunkingConfig {
    enabled?: boolean;
    maxTokens?: number; // approx tokens (chars/4). default: 1200
    overlapTokens?: number; // default: 0
}

export interface ScrapeConfig {
    mode?: 'static' | 'hybrid' | 'browser';
    waitFor?: string; // CSS selector to wait for (browser mode only)
    extractMainContent?: boolean; // Extract only main content using Readability-like algorithm
    optimizeTokens?: boolean; // Optimize markdown output for token efficiency
    stealth?: boolean; // Apply browser anti-bot hardening (browser mode only)
    stealthLevel?: StealthLevel; // Stealth profile intensity
    maxResponseBytes?: number; // Static fetch response limit (bytes)
    cache?: boolean | DiskCacheConfig; // opt-in disk cache for scrape results
    httpCache?: boolean | HttpCacheConfig; // opt-in disk HTTP cache for static fetch
    chunking?: boolean | ChunkingConfig; // opt-in chunking for agent use
}

export interface Citation {
    url: string;
    anchor?: string;
}

export interface ContentChunk {
    id: string;
    text: string;
    approxTokens: number;
    headingPath: string[];
    citation: Citation;
}

export interface ScrapedPage {
    url: string;
    content: string; // Markdown content
    title?: string;
    metadata?: Record<string, any>;
    links?: string[]; // Extracted links from this page
    chunks?: ContentChunk[]; // Optional token-aware chunks (opt-in)
}

export interface RobotsConfig {
    enabled?: boolean;
    userAgent?: string; // default: "agent-crawl"
    respectCrawlDelay?: boolean; // default: true
}

export interface SitemapConfig {
    enabled?: boolean;
    maxUrls?: number; // default: 1000
}

export interface CrawlStateConfig {
    enabled?: boolean;
    dir?: string; // default: ".cache/agent-crawl/state"
    id?: string; // default derived from start URL
    resume?: boolean; // default: true
    flushEvery?: number; // default: 10 batches
    persistPages?: boolean; // default: true
}

export interface CrawlConfig extends ScrapeConfig {
    maxDepth?: number;    // Maximum depth to crawl (default: 1)
    maxPages?: number;    // Maximum number of pages to crawl (default: 10)
    concurrency?: number; // Number of concurrent requests (default: 2)
    perHostConcurrency?: number; // default: concurrency
    minDelayMs?: number; // default: 0
    includePatterns?: string[]; // applied to absolute URL
    excludePatterns?: string[]; // applied to absolute URL
    robots?: boolean | RobotsConfig; // opt-in
    sitemap?: boolean | SitemapConfig; // opt-in
    crawlState?: boolean | CrawlStateConfig; // opt-in resumable crawl state
}

export interface CrawlResult {
    pages: ScrapedPage[];
    totalPages: number;
    maxDepthReached: number;
    errors: Array<{ url: string; error: string }>;
}
