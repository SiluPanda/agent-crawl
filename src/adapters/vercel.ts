import { z } from 'zod';
import { AgentCrawl } from '../AgentCrawl.js';
import { ScrapeOptionsSchema, CrawlOptionsSchema } from '../schemas.js';

/**
 * Creates a valid Tool for Vercel AI SDK.
 * Reference: https://sdk.vercel.ai/docs/reference/ai-sdk-core/tool
 */
export const asVercelTool = () => {
    return {
        description: 'A web scraper that can fetch content from URLs and return optimized markdown. Automatically uses browser rendering for dynamic content.',
        parameters: ScrapeOptionsSchema,
        execute: async ({ url, mode, waitFor, extractMainContent, optimizeTokens, stealth, stealthLevel }: z.infer<typeof ScrapeOptionsSchema>) => {
            const page = await AgentCrawl.scrape(url, {
                mode,
                waitFor,
                extractMainContent,
                optimizeTokens,
                stealth,
                stealthLevel,
            });
            return {
                content: page.content,
                title: page.title,
                url: page.url,
                metadata: page.metadata
            };
        },
    };
};

/**
 * Creates a valid Crawl Tool for Vercel AI SDK.
 * Crawls multiple pages starting from a URL with configurable depth and concurrency.
 */
export const asVercelCrawlTool = () => {
    return {
        description: 'A web crawler that recursively fetches pages starting from a URL. Returns multiple pages as optimized markdown. Supports depth limiting, page limits, and concurrent requests.',
        parameters: CrawlOptionsSchema,
        execute: async ({ 
            url, 
            mode, 
            waitFor, 
            extractMainContent, 
            optimizeTokens,
            stealth,
            stealthLevel,
            maxDepth,
            maxPages,
            concurrency 
        }: z.infer<typeof CrawlOptionsSchema>) => {
            const result = await AgentCrawl.crawl(url, {
                mode,
                waitFor,
                extractMainContent,
                optimizeTokens,
                stealth,
                stealthLevel,
                maxDepth,
                maxPages,
                concurrency,
            });
            return {
                pages: result.pages.map(page => ({
                    content: page.content,
                    title: page.title,
                    url: page.url,
                })),
                totalPages: result.totalPages,
                maxDepthReached: result.maxDepthReached,
                errors: result.errors,
            };
        },
    };
};
