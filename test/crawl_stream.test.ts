import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentCrawl } from '../src/AgentCrawl.js';
import type { ScrapedPage } from '../src/types.js';

const originalFetch = globalThis.fetch;

test.afterEach(() => {
    globalThis.fetch = originalFetch;
});

function makePage(url: string, links: string[] = [], content = 'ok'): ScrapedPage {
    return { url, content, title: 't', links, metadata: { status: 200 } };
}

// ---------------------------------------------------------------------------
// crawlStream basic functionality
// ---------------------------------------------------------------------------

test('crawlStream yields pages as async iterator', async () => {
    const origin = 'https://stream-test.site';
    globalThis.fetch = (async () => new Response('not found', { status: 404 })) as typeof fetch;

    const originalScrape = AgentCrawl.scrape.bind(AgentCrawl);
    AgentCrawl.scrape = async (url: string) => {
        if (url === `${origin}/`) return makePage(url, [`${origin}/a`, `${origin}/b`]);
        return makePage(url, []);
    };

    try {
        const pages: ScrapedPage[] = [];
        for await (const page of AgentCrawl.crawlStream(`${origin}/`, {
            maxDepth: 2,
            maxPages: 10,
            concurrency: 1,
        })) {
            pages.push(page);
        }

        assert.equal(pages.length, 3);
        assert.equal(pages[0].url, `${origin}/`);
    } finally {
        AgentCrawl.scrape = originalScrape;
    }
});

test('crawlStream pages arrive incrementally', async () => {
    const origin = 'https://incremental.site';
    globalThis.fetch = (async () => new Response('not found', { status: 404 })) as typeof fetch;

    const originalScrape = AgentCrawl.scrape.bind(AgentCrawl);
    AgentCrawl.scrape = async (url: string) => {
        // Simulate network delay
        await new Promise(r => setTimeout(r, 50));
        if (url === `${origin}/`) return makePage(url, [`${origin}/a`, `${origin}/b`]);
        return makePage(url, []);
    };

    try {
        const timestamps: number[] = [];
        for await (const page of AgentCrawl.crawlStream(`${origin}/`, {
            maxDepth: 2,
            maxPages: 10,
            concurrency: 1,
        })) {
            timestamps.push(Date.now());
        }

        assert.equal(timestamps.length, 3);
        // Pages should arrive incrementally, not all at once
        assert.ok(timestamps[1] - timestamps[0] >= 30, 'Pages should arrive with delay between them');
    } finally {
        AgentCrawl.scrape = originalScrape;
    }
});

test('crawlStream can be broken out of early', async () => {
    const origin = 'https://early-break.site';
    globalThis.fetch = (async () => new Response('not found', { status: 404 })) as typeof fetch;

    let scrapeCount = 0;
    const originalScrape = AgentCrawl.scrape.bind(AgentCrawl);
    AgentCrawl.scrape = async (url: string) => {
        scrapeCount++;
        const links = Array.from({ length: 5 }, (_, i) => `${origin}/page${scrapeCount}-${i}`);
        return makePage(url, links);
    };

    try {
        const pages: ScrapedPage[] = [];
        for await (const page of AgentCrawl.crawlStream(`${origin}/`, {
            maxDepth: 3,
            maxPages: 100,
            concurrency: 1,
        })) {
            pages.push(page);
            if (pages.length >= 3) break; // Early termination
        }

        assert.equal(pages.length, 3);
        // Should have scraped only a few pages, not all 100
        assert.ok(scrapeCount < 20, `Scraped ${scrapeCount} pages, expected early termination`);
    } finally {
        AgentCrawl.scrape = originalScrape;
    }
});

test('crawlStream with DFS strategy', async () => {
    const origin = 'https://stream-dfs.site';
    globalThis.fetch = (async () => new Response('not found', { status: 404 })) as typeof fetch;

    const originalScrape = AgentCrawl.scrape.bind(AgentCrawl);
    AgentCrawl.scrape = async (url: string) => {
        if (url === `${origin}/`) return makePage(url, [`${origin}/a`, `${origin}/b`]);
        if (url === `${origin}/b`) return makePage(url, [`${origin}/b/deep`]);
        return makePage(url, []);
    };

    try {
        const urls: string[] = [];
        for await (const page of AgentCrawl.crawlStream(`${origin}/`, {
            maxDepth: 3,
            maxPages: 10,
            concurrency: 1,
            strategy: 'dfs',
        })) {
            urls.push(page.url);
        }

        // DFS: /, /b (LIFO), /b/deep, /a
        assert.equal(urls[0], `${origin}/`);
        assert.equal(urls[1], `${origin}/b`);
        assert.equal(urls[2], `${origin}/b/deep`);
        assert.equal(urls[3], `${origin}/a`);
    } finally {
        AgentCrawl.scrape = originalScrape;
    }
});

test('crawlStream returns empty for invalid start URL', async () => {
    const pages: ScrapedPage[] = [];
    for await (const page of AgentCrawl.crawlStream('http://127.0.0.1/', {
        maxDepth: 1,
        maxPages: 10,
    })) {
        pages.push(page);
    }
    assert.equal(pages.length, 0);
});

// ---------------------------------------------------------------------------
// crawl() still works (refactor didn't break it)
// ---------------------------------------------------------------------------

test('crawl() batch mode still works after refactor', async () => {
    const origin = 'https://batch-check.site';
    globalThis.fetch = (async () => new Response('not found', { status: 404 })) as typeof fetch;

    const originalScrape = AgentCrawl.scrape.bind(AgentCrawl);
    AgentCrawl.scrape = async (url: string) => {
        if (url === `${origin}/`) return makePage(url, [`${origin}/a`]);
        return makePage(url, []);
    };

    try {
        const result = await AgentCrawl.crawl(`${origin}/`, {
            maxDepth: 2,
            maxPages: 10,
            concurrency: 1,
        });

        assert.equal(result.totalPages, 2);
        assert.equal(result.pages[0].url, `${origin}/`);
        assert.equal(result.pages[1].url, `${origin}/a`);
        assert.equal(result.errors.length, 0);
    } finally {
        AgentCrawl.scrape = originalScrape;
    }
});

test('crawl() collects errors from generator', async () => {
    const origin = 'https://error-collect.site';
    globalThis.fetch = (async () => new Response('not found', { status: 404 })) as typeof fetch;

    const originalScrape = AgentCrawl.scrape.bind(AgentCrawl);
    AgentCrawl.scrape = async (url: string) => {
        if (url.includes('bad')) {
            return { url, content: '', metadata: { status: 0, error: 'Failed' } } as ScrapedPage;
        }
        if (url === `${origin}/`) return makePage(url, [`${origin}/good`, `${origin}/bad`]);
        return makePage(url, []);
    };

    try {
        const result = await AgentCrawl.crawl(`${origin}/`, {
            maxDepth: 2,
            maxPages: 10,
            concurrency: 1,
        });

        assert.equal(result.pages.length, 2); // / and /good
        assert.equal(result.errors.length, 1);
        assert.ok(result.errors[0].url.includes('bad'));
    } finally {
        AgentCrawl.scrape = originalScrape;
    }
});

// ---------------------------------------------------------------------------
// crawlStream with hooks
// ---------------------------------------------------------------------------

test('crawlStream works with shouldCrawlUrl hook', async () => {
    const origin = 'https://stream-hooks.site';
    globalThis.fetch = (async () => new Response('not found', { status: 404 })) as typeof fetch;

    const originalScrape = AgentCrawl.scrape.bind(AgentCrawl);
    AgentCrawl.scrape = async (url: string) => {
        if (url === `${origin}/`) return makePage(url, [`${origin}/yes`, `${origin}/no`]);
        return makePage(url, []);
    };

    try {
        const urls: string[] = [];
        for await (const page of AgentCrawl.crawlStream(`${origin}/`, {
            maxDepth: 2,
            maxPages: 10,
            concurrency: 1,
            hooks: {
                shouldCrawlUrl: (url) => !url.includes('/no'),
            },
        })) {
            urls.push(page.url);
        }

        assert.ok(urls.includes(`${origin}/yes`));
        assert.ok(!urls.includes(`${origin}/no`));
    } finally {
        AgentCrawl.scrape = originalScrape;
    }
});
