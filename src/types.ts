export interface FetchOptions {
    method?: 'GET' | 'POST';
    headers?: Record<string, string>;
    timeout?: number;
    retries?: number;
}

export interface FetchResult {
    url: string;
    html: string;
    status: number;
    headers: Record<string, string>;
    isStaticSuccess: boolean;
}

export interface ScrapeConfig {
    mode?: 'static' | 'hybrid' | 'browser';
    output?: 'markdown' | 'json';
    waitFor?: string; // CSS selector to wait for (browser mode only)
    extractMainContent?: boolean; // Extract only main content using Readability-like algorithm
    optimizeTokens?: boolean; // Optimize markdown output for token efficiency
}

export interface ScrapedPage {
    url: string;
    content: string; // Markdown or JSON
    title?: string;
    metadata?: Record<string, any>;
    links?: string[]; // Extracted links from this page
}

export interface CrawlConfig extends ScrapeConfig {
    maxDepth?: number;    // Maximum depth to crawl (default: 1)
    maxPages?: number;    // Maximum number of pages to crawl (default: 10)
    concurrency?: number; // Number of concurrent requests (default: 2)
}

export interface CrawlResult {
    pages: ScrapedPage[];
    totalPages: number;
    maxDepthReached: number;
    errors: Array<{ url: string; error: string }>;
}
