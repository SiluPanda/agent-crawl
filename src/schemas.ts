import { z } from 'zod';

/** Schema for a single CSS extraction field definition (supports nesting). */
const CssFieldSchema: z.ZodType = z.object({
    selector: z.string().max(500),
    type: z.enum(['text', 'attribute', 'html']).optional(),
    attribute: z.string().max(200).optional(),
    all: z.boolean().optional(),
    fields: z.record(
        z.string().max(200),
        z.union([
            z.string().max(500),
            z.lazy((): z.ZodType => CssFieldSchema),
        ]),
    ).optional(),
});

/** Reusable dir validator: rejects path traversal via ".." segments */
const safeDir = z.string().max(500).refine(
    (dir) => !dir.split(/[\\/]/).some(s => s === '..'),
    { message: 'Path traversal ("..") not allowed in directory paths' },
);

export const ScrapeOptionsSchema = z.object({
    url: z.string().url().max(8192),
    mode: z.enum(['static', 'hybrid', 'browser']).default('hybrid'),
    waitFor: z.string().max(500).optional().describe('CSS selector to wait for (browser mode only, max 500 chars)'),
    extractMainContent: z.boolean().default(false).describe('Extract only main content using Readability-like algorithm'),
    optimizeTokens: z.boolean().default(true).describe('Optimize markdown output for token efficiency'),
    stealth: z.boolean().default(false).describe('Apply best-effort browser stealth hardening (browser mode only)'),
    stealthLevel: z.enum(['basic', 'balanced']).default('balanced').describe('Stealth profile level when stealth is enabled'),
    maxResponseBytes: z.number().int().min(1).max(50 * 1024 * 1024).optional().describe('Maximum static fetch response size in bytes (best-effort, max 50MB)'),
    cache: z.union([
        z.boolean(),
        z.object({
            enabled: z.boolean().optional(),
            dir: safeDir.optional(),
            ttlMs: z.number().int().min(1).max(7 * 24 * 60 * 60_000).optional(),
            maxEntries: z.number().int().min(1).max(100_000).optional(),
        }),
    ]).optional().describe('Opt-in disk cache for processed scrape results'),
    httpCache: z.union([
        z.boolean(),
        z.object({
            enabled: z.boolean().optional(),
            dir: safeDir.optional(),
            ttlMs: z.number().int().min(1).max(7 * 24 * 60 * 60_000).optional(),
            maxEntries: z.number().int().min(1).max(100_000).optional(),
        }),
    ]).optional().describe('Opt-in disk HTTP cache for static fetches (ETag/Last-Modified)'),
    chunking: z.union([
        z.boolean(),
        z.object({
            enabled: z.boolean().optional(),
            maxTokens: z.number().int().min(1).max(100_000).optional(),
            overlapTokens: z.number().int().min(0).max(50_000).optional(),
        }),
    ]).optional().describe('Opt-in token-aware chunking with citation anchors'),
    proxy: z.object({
        url: z.string().url().max(2000),
        username: z.string().max(200).optional(),
        password: z.string().max(200).optional(),
    }).optional().describe('Proxy server configuration'),
    headers: z.record(
        z.string().max(200),
        z.string().max(8192),
    ).refine(obj => Object.keys(obj).length <= 50, 'Maximum 50 custom headers')
     .optional().describe('Custom request headers (e.g., Authorization)'),
    cookies: z.array(z.object({
        name: z.string().max(200),
        value: z.string().max(4096),
        domain: z.string().max(500).optional(),
        path: z.string().max(500).optional(),
    })).max(100).optional().describe('Cookies to inject into requests (max 100)'),
    extraction: z.union([
        z.object({
            type: z.literal('css'),
            schema: z.record(
                z.string().max(200),
                z.union([
                    z.string().max(500),
                    z.lazy((): z.ZodType => CssFieldSchema),
                ]),
            ).refine(obj => Object.keys(obj).length <= 100, 'Maximum 100 top-level fields'),
        }),
        z.object({
            type: z.literal('regex'),
            patterns: z.record(
                z.string().max(200),
                z.string().max(2000),
            ).refine(obj => Object.keys(obj).length <= 100, 'Maximum 100 patterns'),
        }),
    ]).optional().describe('Opt-in structured data extraction (CSS or regex)'),
    jsCode: z.union([
        z.string().max(51200),
        z.array(z.string().max(51200)).max(10),
    ]).optional().describe('JavaScript to execute after page load (forces browser mode, max 50KB per script, max 10 scripts)'),
    screenshot: z.boolean().optional().describe('Capture full-page screenshot as base64 PNG (forces browser mode)'),
    pdf: z.boolean().optional().describe('Capture page as base64 PDF (forces browser mode)'),
});

export const CrawlOptionsSchema = ScrapeOptionsSchema.extend({
    maxDepth: z.number().int().min(0).max(100).default(1),
    maxPages: z.number().int().min(1).max(100_000).default(10),
    concurrency: z.number().int().min(1).max(50).default(2),
    perHostConcurrency: z.number().int().min(1).max(50).optional().describe('Maximum concurrent requests per host (defaults to concurrency)'),
    minDelayMs: z.number().int().min(0).max(60_000).optional().describe('Minimum delay between requests to the same host (ms)'),
    includePatterns: z.array(z.string().max(2000)).max(100).optional().describe('Only crawl URLs matching any of these patterns'),
    excludePatterns: z.array(z.string().max(2000)).max(100).optional().describe('Do not crawl URLs matching any of these patterns'),
    robots: z.union([
        z.boolean(),
        z.object({
            enabled: z.boolean().optional(),
            userAgent: z.string().max(200).optional(),
            respectCrawlDelay: z.boolean().optional(),
        }),
    ]).optional().describe('Opt-in robots.txt compliance'),
    sitemap: z.union([
        z.boolean(),
        z.object({
            enabled: z.boolean().optional(),
            maxUrls: z.number().int().min(1).max(100_000).optional(),
        }),
    ]).optional().describe('Opt-in sitemap seeding'),
    crawlState: z.union([
        z.boolean(),
        z.object({
            enabled: z.boolean().optional(),
            dir: safeDir.optional(),
            id: z.string().max(128).regex(/^[a-zA-Z0-9_-]*$/, 'ID must be alphanumeric, hyphens, or underscores').optional(),
            resume: z.boolean().optional(),
            flushEvery: z.number().int().min(1).max(1000).optional(),
            persistPages: z.boolean().optional(),
        }),
    ]).optional().describe('Opt-in resumable crawl state persistence'),
});

export type ScrapeOptions = z.infer<typeof ScrapeOptionsSchema>;
export type CrawlOptions = z.infer<typeof CrawlOptionsSchema>;
