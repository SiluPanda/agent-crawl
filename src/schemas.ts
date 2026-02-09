import { z } from 'zod';

export const ScrapeOptionsSchema = z.object({
    url: z.string().url(),
    mode: z.enum(['static', 'hybrid', 'browser']).default('hybrid'),
    waitFor: z.string().optional().describe('CSS selector to wait for (browser mode only)'),
    extractMainContent: z.boolean().default(false).describe('Extract only main content using Readability-like algorithm'),
    optimizeTokens: z.boolean().default(true).describe('Optimize markdown output for token efficiency'),
    stealth: z.boolean().default(false).describe('Apply best-effort browser stealth hardening (browser mode only)'),
    stealthLevel: z.enum(['basic', 'balanced']).default('balanced').describe('Stealth profile level when stealth is enabled'),
});

export const CrawlOptionsSchema = ScrapeOptionsSchema.extend({
    maxDepth: z.number().int().min(1).default(1),
    maxPages: z.number().int().min(1).default(10),
    concurrency: z.number().int().min(1).default(2),
});

export type ScrapeOptions = z.infer<typeof ScrapeOptionsSchema>;
export type CrawlOptions = z.infer<typeof CrawlOptionsSchema>;
