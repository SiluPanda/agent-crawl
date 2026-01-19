import zodToJsonSchema from 'zod-to-json-schema';
import { ScrapeOptionsSchema, CrawlOptionsSchema } from '../schemas.js';

/**
 * Creates a function definition for the OpenAI SDK.
 * Uses zod-to-json-schema for generating the JSON schema.
 */
export const asOpenAITool = () => {
    return {
        type: 'function' as const,
        function: {
            name: 'scrape_web_page',
            description: 'Scrapes a web page and returns optimized markdown content. Automatically handles dynamic content.',
            parameters: zodToJsonSchema(ScrapeOptionsSchema, 'ScrapeOptionsSchema'),
        }
    };
};

/**
 * Creates a crawl function definition for the OpenAI SDK.
 * Uses zod-to-json-schema for generating the JSON schema.
 */
export const asOpenAICrawlTool = () => {
    return {
        type: 'function' as const,
        function: {
            name: 'crawl_website',
            description: 'Crawls a website starting from a URL, recursively following same-origin links. Returns multiple pages as optimized markdown. Supports configurable depth, page limits, and concurrency.',
            parameters: zodToJsonSchema(CrawlOptionsSchema, 'CrawlOptionsSchema'),
        }
    };
};
