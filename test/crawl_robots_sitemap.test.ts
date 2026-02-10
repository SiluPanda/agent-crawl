import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentCrawl } from '../src/AgentCrawl.js';
import type { ScrapedPage } from '../src/types.js';

const originalFetch = globalThis.fetch;

function makePage(url: string, links: string[] = []): ScrapedPage {
    return { url, content: 'ok', title: 't', links, metadata: { status: 200 } };
}

test.afterEach(() => {
    globalThis.fetch = originalFetch;
});

test('crawl respects robots.txt when enabled and seeds from sitemap.xml (mocked HTTP)', async () => {
    const origin = 'https://mock.example';

    // Mock HTTP endpoints used by crawl:
    // - fetchRobotsTxt() uses global fetch to GET /robots.txt
    // - sitemap seeding uses SmartFetcher.fetch() which uses global fetch to GET /sitemap.xml
    globalThis.fetch = (async (input: any) => {
        const url = typeof input === 'string' ? input : String(input?.url ?? input);

        if (url === `${origin}/robots.txt`) {
            return new Response('User-agent: *\nDisallow: /private\nCrawl-delay: 0\n', {
                status: 200,
                headers: { 'content-type': 'text/plain' },
            });
        }

        if (url === `${origin}/sitemap.xml`) {
            return new Response(
                `<?xml version="1.0" encoding="UTF-8"?>\n` +
                `<urlset>\n` +
                `  <url><loc>${origin}/public</loc></url>\n` +
                `  <url><loc>${origin}/private</loc></url>\n` +
                `</urlset>\n`,
                { status: 200, headers: { 'content-type': 'application/xml' } }
            );
        }

        // Any other network access during this test is unexpected.
        return new Response('not found', { status: 404, headers: { 'content-type': 'text/plain' } });
    }) as typeof fetch;

    const originalScrape = AgentCrawl.scrape.bind(AgentCrawl);
    AgentCrawl.scrape = async (url: string) => {
        if (url === `${origin}/` || url === `${origin}`) {
            return makePage(`${origin}/`, [`${origin}/public2`, `${origin}/private`]);
        }
        if (url === `${origin}/public`) {
            return makePage(url, [`${origin}/private`, `${origin}/public2`]);
        }
        if (url === `${origin}/public2`) {
            return makePage(url, []);
        }
        if (url === `${origin}/private`) {
            return makePage(url, []);
        }
        return makePage(url, []);
    };

    try {
        const result = await AgentCrawl.crawl(`${origin}/`, {
            maxDepth: 2,
            maxPages: 10,
            concurrency: 3,
            sitemap: { enabled: true, maxUrls: 50 },
            robots: { enabled: true, userAgent: 'agent-crawl', respectCrawlDelay: true },
        });

        assert.equal(result.errors.length, 0);
        const urls = result.pages.map((p) => p.url);
        assert.ok(urls.includes(`${origin}/public`));
        assert.ok(urls.includes(`${origin}/public2`));
        assert.equal(urls.includes(`${origin}/private`), false);
    } finally {
        AgentCrawl.scrape = originalScrape;
    }
});

