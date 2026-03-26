export interface FetchOptions {
    method?: 'GET' | 'POST';
    headers?: Record<string, string>;
    timeout?: number;
    retries?: number;
    maxResponseBytes?: number;
    httpCache?: boolean | HttpCacheConfig;
    proxy?: ProxyConfig;
    cookies?: CookieDef[];
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

/** Defines how to extract a single field via CSS selector. */
export interface CssFieldDef {
    selector: string;
    type?: 'text' | 'attribute' | 'html'; // default: 'text'
    attribute?: string; // required when type is 'attribute'
    all?: boolean; // true → return array of all matches; false (default) → first match
    fields?: Record<string, string | CssFieldDef>; // nested extraction (implies all: true, returns object[])
}

/** Extract structured data from HTML using CSS selectors. */
export interface CssExtractionConfig {
    type: 'css';
    schema: Record<string, string | CssFieldDef>;
}

/** Extract data from page text using regex patterns. All global matches are returned. */
export interface RegexExtractionConfig {
    type: 'regex';
    patterns: Record<string, string>; // key → regex pattern string (matched globally)
}

export type ExtractionConfig = CssExtractionConfig | RegexExtractionConfig;

/** Proxy server configuration for routing requests through a proxy. */
export interface ProxyConfig {
    url: string; // e.g., http://proxy:8080, socks5://proxy:1080
    username?: string;
    password?: string;
}

/** A cookie to inject into requests. */
export interface CookieDef {
    name: string;
    value: string;
    domain?: string; // defaults to target URL hostname
    path?: string; // defaults to "/"
}

/** Context passed to the onFetched hook. */
export interface FetchedContext {
    url: string;
    html: string;
    status: number;
    headers: Record<string, string>;
}

/** Hooks for customizing the scrape lifecycle. */
export interface ScrapeHooks {
    /** Called after HTML is fetched, before markdown conversion. Return modified HTML or void to keep original. */
    onFetched?: (ctx: FetchedContext) => string | void | Promise<string | void>;
    /** Called on the final ScrapedPage before caching/returning. Return modified page or void to keep original. */
    onResult?: (page: ScrapedPage) => ScrapedPage | void | Promise<ScrapedPage | void>;
}

/** Hooks for customizing the crawl lifecycle. Extends scrape hooks. */
export interface CrawlHooks extends ScrapeHooks {
    /** Called before a discovered URL is queued. Return false to skip it. */
    shouldCrawlUrl?: (url: string, depth: number) => boolean | Promise<boolean>;
    /** Called after each page is successfully crawled. */
    onPageCrawled?: (page: ScrapedPage, depth: number) => void | Promise<void>;
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
    extraction?: ExtractionConfig; // opt-in structured data extraction
    proxy?: ProxyConfig; // route requests through a proxy server
    headers?: Record<string, string>; // custom request headers (e.g., Authorization)
    cookies?: CookieDef[]; // cookies to inject into requests
    jsCode?: string | string[]; // JS to execute after page load (forces browser mode)
    screenshot?: boolean; // capture full-page screenshot as base64 PNG (forces browser mode)
    pdf?: boolean; // capture page as base64 PDF (forces browser mode)
    hooks?: ScrapeHooks; // lifecycle hooks for customization
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
    extracted?: Record<string, unknown>; // Structured data from extraction config
    screenshot?: string; // base64-encoded PNG screenshot (opt-in)
    pdf?: string; // base64-encoded PDF (opt-in)
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

export type CrawlStrategy = 'bfs' | 'dfs' | 'bestfirst';

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
    strategy?: CrawlStrategy; // crawl traversal strategy (default: 'bfs')
    priorityKeywords?: string[]; // for bestfirst strategy — URLs containing these score higher
    hooks?: CrawlHooks; // lifecycle hooks for customization (extends ScrapeHooks)
}

export interface CrawlResult {
    pages: ScrapedPage[];
    totalPages: number;
    maxDepthReached: number;
    errors: Array<{ url: string; error: string }>;
}
