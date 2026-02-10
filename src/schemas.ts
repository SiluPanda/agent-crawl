import { z } from 'zod';

export const ScrapeOptionsSchema = z.object({
    url: z.string().url(),
    mode: z.enum(['static', 'hybrid', 'browser']).default('hybrid'),
    waitFor: z.string().optional().describe('CSS selector to wait for (browser mode only)'),
    extractMainContent: z.boolean().default(false).describe('Extract only main content using Readability-like algorithm'),
    optimizeTokens: z.boolean().default(true).describe('Optimize markdown output for token efficiency'),
    stealth: z.boolean().default(false).describe('Apply best-effort browser stealth hardening (browser mode only)'),
    stealthLevel: z.enum(['basic', 'balanced']).default('balanced').describe('Stealth profile level when stealth is enabled'),
    maxResponseBytes: z.number().int().min(1).optional().describe('Maximum static fetch response size in bytes (best-effort)'),
    cache: z.union([
        z.boolean(),
        z.object({
            enabled: z.boolean().optional(),
            dir: z.string().optional(),
            ttlMs: z.number().int().min(1).optional(),
            maxEntries: z.number().int().min(1).optional(),
        }),
    ]).optional().describe('Opt-in disk cache for processed scrape results'),
    httpCache: z.union([
        z.boolean(),
        z.object({
            enabled: z.boolean().optional(),
            dir: z.string().optional(),
            ttlMs: z.number().int().min(1).optional(),
            maxEntries: z.number().int().min(1).optional(),
        }),
    ]).optional().describe('Opt-in disk HTTP cache for static fetches (ETag/Last-Modified)'),
    chunking: z.union([
        z.boolean(),
        z.object({
            enabled: z.boolean().optional(),
            maxTokens: z.number().int().min(1).optional(),
            overlapTokens: z.number().int().min(0).optional(),
        }),
    ]).optional().describe('Opt-in token-aware chunking with citation anchors'),
});

export const CrawlOptionsSchema = ScrapeOptionsSchema.extend({
    maxDepth: z.number().int().min(1).default(1),
    maxPages: z.number().int().min(1).default(10),
    concurrency: z.number().int().min(1).default(2),
    perHostConcurrency: z.number().int().min(1).optional().describe('Maximum concurrent requests per host (defaults to concurrency)'),
    minDelayMs: z.number().int().min(0).optional().describe('Minimum delay between requests to the same host (ms)'),
    includePatterns: z.array(z.string()).optional().describe('Only crawl URLs matching any of these patterns'),
    excludePatterns: z.array(z.string()).optional().describe('Do not crawl URLs matching any of these patterns'),
    robots: z.union([
        z.boolean(),
        z.object({
            enabled: z.boolean().optional(),
            userAgent: z.string().optional(),
            respectCrawlDelay: z.boolean().optional(),
        }),
    ]).optional().describe('Opt-in robots.txt compliance'),
    sitemap: z.union([
        z.boolean(),
        z.object({
            enabled: z.boolean().optional(),
            maxUrls: z.number().int().min(1).optional(),
        }),
    ]).optional().describe('Opt-in sitemap seeding'),
    crawlState: z.union([
        z.boolean(),
        z.object({
            enabled: z.boolean().optional(),
            dir: z.string().optional(),
            id: z.string().optional(),
            resume: z.boolean().optional(),
            flushEvery: z.number().int().min(1).optional(),
            persistPages: z.boolean().optional(),
        }),
    ]).optional().describe('Opt-in resumable crawl state persistence'),
});

export type ScrapeOptions = z.infer<typeof ScrapeOptionsSchema>;
export type CrawlOptions = z.infer<typeof CrawlOptionsSchema>;
