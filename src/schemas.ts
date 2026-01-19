import { z } from 'zod';

export const ScrapeOptionsSchema = z.object({
    url: z.string().url(),
    mode: z.enum(['static', 'hybrid', 'browser']).default('hybrid').optional(),
    output: z.enum(['markdown', 'json']).default('markdown').optional(),
    waitFor: z.string().optional().describe('CSS selector to wait for (browser mode only)'),
    extractMainContent: z.boolean().default(false).optional().describe('Extract only main content using Readability-like algorithm'),
    optimizeTokens: z.boolean().default(true).optional().describe('Optimize markdown output for token efficiency'),
});

export const CrawlOptionsSchema = ScrapeOptionsSchema.extend({
    maxDepth: z.number().int().min(1).default(1).optional(),
    maxPages: z.number().int().min(1).default(10).optional(),
    concurrency: z.number().int().min(1).default(2).optional(),
});

export type ScrapeOptions = z.infer<typeof ScrapeOptionsSchema>;
export type CrawlOptions = z.infer<typeof CrawlOptionsSchema>;
