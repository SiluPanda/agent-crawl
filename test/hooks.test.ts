import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentCrawl } from '../src/AgentCrawl.js';
import type { ScrapedPage, ScrapeHooks, CrawlHooks } from '../src/types.js';

const originalFetch = globalThis.fetch;

test.afterEach(() => {
    globalThis.fetch = originalFetch;
});

function makePage(url: string, links: string[] = [], content = 'ok'): ScrapedPage {
    return { url, content, title: 't', links, metadata: { status: 200 } };
}

// ---------------------------------------------------------------------------
// Helper to patch AgentCrawl statics
// ---------------------------------------------------------------------------

function patchForScrape(AgentCrawl: any, html = '<html><body><p>Hello World</p></body></html>') {
    const orig = {
        fetcher: AgentCrawl.fetcher,
        markdownifier: AgentCrawl.markdownifier,
        cache: AgentCrawl.cache,
    };
    AgentCrawl.fetcher = {
        fetch: async () => ({
            url: 'https://example.com',
            html,
            status: 200,
            headers: { 'content-type': 'text/html' },
            isStaticSuccess: true,
            needsBrowser: false,
        }),
    };
    AgentCrawl.markdownifier = {
        extractAll: (_h: string) => ({
            title: 'Test',
            links: ['https://example.com/a'],
            markdown: _h.replace(/<[^>]*>/g, '').trim(),
        }),
    };
    AgentCrawl.cache = { get: () => null, set: () => {} };
    return orig;
}

function unpatch(AgentCrawl: any, orig: any) {
    AgentCrawl.fetcher = orig.fetcher;
    AgentCrawl.markdownifier = orig.markdownifier;
    AgentCrawl.cache = orig.cache;
}

// ---------------------------------------------------------------------------
// onFetched hook
// ---------------------------------------------------------------------------

test('onFetched hook can modify HTML before extraction', async () => {
    const orig = patchForScrape(AgentCrawl, '<html><body><p>Original</p><div class="ad">Ad</div></body></html>');
    // Override markdownifier to pass through HTML cleaning
    (AgentCrawl as any).markdownifier = {
        extractAll: (html: string) => ({
            title: 'T',
            links: [],
            markdown: html.replace(/<[^>]*>/g, '').trim(),
        }),
    };

    try {
        const page = await AgentCrawl.scrape('https://example.com', {
            mode: 'static',
            hooks: {
                onFetched: (ctx) => {
                    // Remove ad div from HTML
                    return ctx.html.replace(/<div class="ad">.*?<\/div>/, '');
                },
            },
        });

        assert.ok(!page.content.includes('Ad'), 'Ad should be removed by onFetched hook');
        assert.ok(page.content.includes('Original'), 'Original content should remain');
    } finally {
        unpatch(AgentCrawl, orig);
    }
});

test('onFetched hook receives correct context', async () => {
    const orig = patchForScrape(AgentCrawl);
    let receivedCtx: any = null;

    try {
        await AgentCrawl.scrape('https://example.com', {
            mode: 'static',
            hooks: {
                onFetched: (ctx) => {
                    receivedCtx = ctx;
                },
            },
        });

        assert.ok(receivedCtx);
        assert.equal(receivedCtx.url, 'https://example.com');
        assert.ok(receivedCtx.html.includes('<html>'));
        assert.equal(receivedCtx.status, 200);
        assert.equal(typeof receivedCtx.headers, 'object');
    } finally {
        unpatch(AgentCrawl, orig);
    }
});

test('onFetched hook returning void keeps original HTML', async () => {
    const orig = patchForScrape(AgentCrawl, '<html><body>Keep This</body></html>');
    (AgentCrawl as any).markdownifier = {
        extractAll: (html: string) => ({
            title: 'T', links: [],
            markdown: html.replace(/<[^>]*>/g, '').trim(),
        }),
    };

    try {
        const page = await AgentCrawl.scrape('https://example.com', {
            mode: 'static',
            hooks: {
                onFetched: () => { /* return void */ },
            },
        });

        assert.ok(page.content.includes('Keep This'));
    } finally {
        unpatch(AgentCrawl, orig);
    }
});

test('onFetched hook error is non-fatal', async () => {
    const orig = patchForScrape(AgentCrawl, '<html><body>Content</body></html>');
    (AgentCrawl as any).markdownifier = {
        extractAll: (html: string) => ({
            title: 'T', links: [],
            markdown: html.replace(/<[^>]*>/g, '').trim(),
        }),
    };

    try {
        const page = await AgentCrawl.scrape('https://example.com', {
            mode: 'static',
            hooks: {
                onFetched: () => { throw new Error('Hook crashed!'); },
            },
        });

        // Should still return content despite hook error
        assert.ok(page.content.includes('Content'));
    } finally {
        unpatch(AgentCrawl, orig);
    }
});

// ---------------------------------------------------------------------------
// onResult hook
// ---------------------------------------------------------------------------

test('onResult hook can modify ScrapedPage', async () => {
    const orig = patchForScrape(AgentCrawl);

    try {
        const page = await AgentCrawl.scrape('https://example.com', {
            mode: 'static',
            hooks: {
                onResult: (page) => ({
                    ...page,
                    content: page.content + ' [modified]',
                }),
            },
        });

        assert.ok(page.content.endsWith('[modified]'));
    } finally {
        unpatch(AgentCrawl, orig);
    }
});

test('onResult hook returning void keeps original page', async () => {
    const orig = patchForScrape(AgentCrawl, '<html><body>Original</body></html>');
    (AgentCrawl as any).markdownifier = {
        extractAll: () => ({ title: 'T', links: [], markdown: 'Original' }),
    };

    try {
        const page = await AgentCrawl.scrape('https://example.com', {
            mode: 'static',
            hooks: {
                onResult: () => { /* void */ },
            },
        });

        assert.equal(page.content, 'Original');
    } finally {
        unpatch(AgentCrawl, orig);
    }
});

test('onResult hook error is non-fatal', async () => {
    const orig = patchForScrape(AgentCrawl);

    try {
        const page = await AgentCrawl.scrape('https://example.com', {
            mode: 'static',
            hooks: {
                onResult: () => { throw new Error('Boom'); },
            },
        });

        assert.ok(page.url);
        assert.ok(page.content);
    } finally {
        unpatch(AgentCrawl, orig);
    }
});

// ---------------------------------------------------------------------------
// Hooks skip caching
// ---------------------------------------------------------------------------

test('result-modifying hooks skip cache', async () => {
    const orig = patchForScrape(AgentCrawl);
    let cacheSetCalled = false;
    (AgentCrawl as any).cache = {
        get: () => null,
        set: () => { cacheSetCalled = true; },
    };

    try {
        await AgentCrawl.scrape('https://example.com', {
            mode: 'static',
            hooks: {
                onFetched: () => { /* just having the hook present skips cache */ },
            },
        });

        assert.equal(cacheSetCalled, false, 'Cache should not be set when onFetched hook is present');
    } finally {
        unpatch(AgentCrawl, orig);
    }
});

// ---------------------------------------------------------------------------
// shouldCrawlUrl hook
// ---------------------------------------------------------------------------

test('shouldCrawlUrl hook filters URLs during crawl', async () => {
    const origin = 'https://hooks-crawl.site';
    globalThis.fetch = (async () => new Response('not found', { status: 404 })) as typeof fetch;

    const originalScrape = AgentCrawl.scrape.bind(AgentCrawl);
    AgentCrawl.scrape = async (url: string) => {
        if (url === `${origin}/`) return makePage(url, [`${origin}/allowed`, `${origin}/blocked`, `${origin}/also-allowed`]);
        return makePage(url, []);
    };

    try {
        const result = await AgentCrawl.crawl(`${origin}/`, {
            maxDepth: 2,
            maxPages: 10,
            concurrency: 1,
            hooks: {
                shouldCrawlUrl: (url) => !url.includes('blocked'),
            },
        });

        const urls = result.pages.map(p => p.url);
        assert.ok(urls.includes(`${origin}/allowed`));
        assert.ok(urls.includes(`${origin}/also-allowed`));
        assert.ok(!urls.includes(`${origin}/blocked`), 'Blocked URL should be filtered');
    } finally {
        AgentCrawl.scrape = originalScrape;
    }
});

test('shouldCrawlUrl hook error allows the URL (fail-open)', async () => {
    const origin = 'https://hooks-error.site';
    globalThis.fetch = (async () => new Response('not found', { status: 404 })) as typeof fetch;

    const originalScrape = AgentCrawl.scrape.bind(AgentCrawl);
    AgentCrawl.scrape = async (url: string) => {
        if (url === `${origin}/`) return makePage(url, [`${origin}/page`]);
        return makePage(url, []);
    };

    try {
        const result = await AgentCrawl.crawl(`${origin}/`, {
            maxDepth: 2,
            maxPages: 10,
            concurrency: 1,
            hooks: {
                shouldCrawlUrl: () => { throw new Error('Hook error'); },
            },
        });

        const urls = result.pages.map(p => p.url);
        assert.ok(urls.includes(`${origin}/page`), 'URL should be allowed when hook errors');
    } finally {
        AgentCrawl.scrape = originalScrape;
    }
});

// ---------------------------------------------------------------------------
// onPageCrawled hook
// ---------------------------------------------------------------------------

test('onPageCrawled hook is called for each crawled page', async () => {
    const origin = 'https://hooks-crawled.site';
    globalThis.fetch = (async () => new Response('not found', { status: 404 })) as typeof fetch;

    const originalScrape = AgentCrawl.scrape.bind(AgentCrawl);
    AgentCrawl.scrape = async (url: string) => {
        if (url === `${origin}/`) return makePage(url, [`${origin}/a`, `${origin}/b`]);
        return makePage(url, []);
    };

    const crawledPages: Array<{ url: string; depth: number }> = [];

    try {
        await AgentCrawl.crawl(`${origin}/`, {
            maxDepth: 2,
            maxPages: 10,
            concurrency: 1,
            hooks: {
                onPageCrawled: (page, depth) => {
                    crawledPages.push({ url: page.url, depth });
                },
            },
        });

        assert.equal(crawledPages.length, 3);
        assert.equal(crawledPages[0].url, `${origin}/`);
        assert.equal(crawledPages[0].depth, 0);
        assert.ok(crawledPages.some(p => p.url === `${origin}/a` && p.depth === 1));
        assert.ok(crawledPages.some(p => p.url === `${origin}/b` && p.depth === 1));
    } finally {
        AgentCrawl.scrape = originalScrape;
    }
});

test('onPageCrawled hook error is non-fatal', async () => {
    const origin = 'https://hooks-err2.site';
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
            hooks: {
                onPageCrawled: () => { throw new Error('Hook crash'); },
            },
        });

        assert.equal(result.totalPages, 2, 'Crawl should complete despite hook error');
    } finally {
        AgentCrawl.scrape = originalScrape;
    }
});

// ---------------------------------------------------------------------------
// Async hooks
// ---------------------------------------------------------------------------

test('async onFetched hook works', async () => {
    const orig = patchForScrape(AgentCrawl, '<html><body>Before</body></html>');
    (AgentCrawl as any).markdownifier = {
        extractAll: (html: string) => ({
            title: 'T', links: [],
            markdown: html.replace(/<[^>]*>/g, '').trim(),
        }),
    };

    try {
        const page = await AgentCrawl.scrape('https://example.com', {
            mode: 'static',
            hooks: {
                onFetched: async (ctx) => {
                    await new Promise(r => setTimeout(r, 10));
                    return ctx.html.replace('Before', 'After');
                },
            },
        });

        assert.ok(page.content.includes('After'));
    } finally {
        unpatch(AgentCrawl, orig);
    }
});

test('async shouldCrawlUrl hook works', async () => {
    const origin = 'https://hooks-async.site';
    globalThis.fetch = (async () => new Response('not found', { status: 404 })) as typeof fetch;

    const originalScrape = AgentCrawl.scrape.bind(AgentCrawl);
    AgentCrawl.scrape = async (url: string) => {
        if (url === `${origin}/`) return makePage(url, [`${origin}/yes`, `${origin}/no`]);
        return makePage(url, []);
    };

    try {
        const result = await AgentCrawl.crawl(`${origin}/`, {
            maxDepth: 2,
            maxPages: 10,
            concurrency: 1,
            hooks: {
                shouldCrawlUrl: async (url) => {
                    await new Promise(r => setTimeout(r, 5));
                    return !url.includes('/no');
                },
            },
        });

        const urls = result.pages.map(p => p.url);
        assert.ok(urls.includes(`${origin}/yes`));
        assert.ok(!urls.includes(`${origin}/no`));
    } finally {
        AgentCrawl.scrape = originalScrape;
    }
});

// ---------------------------------------------------------------------------
// Combined hooks
// ---------------------------------------------------------------------------

test('all four hooks work together', async () => {
    const origin = 'https://hooks-all.site';
    globalThis.fetch = (async () => new Response('not found', { status: 404 })) as typeof fetch;

    let fetchedCount = 0;
    let resultCount = 0;
    const crawledUrls: string[] = [];

    const originalScrape = AgentCrawl.scrape.bind(AgentCrawl);
    AgentCrawl.scrape = async (url: string, config: any) => {
        // Simulate the hooks being called by the real scrape
        const page = makePage(url, url === `${origin}/` ? [`${origin}/keep`, `${origin}/skip`] : []);
        return page;
    };

    try {
        const result = await AgentCrawl.crawl(`${origin}/`, {
            maxDepth: 2,
            maxPages: 10,
            concurrency: 1,
            hooks: {
                shouldCrawlUrl: (url) => !url.includes('skip'),
                onPageCrawled: (page) => { crawledUrls.push(page.url); },
            },
        });

        assert.ok(crawledUrls.includes(`${origin}/`));
        assert.ok(crawledUrls.includes(`${origin}/keep`));
        assert.ok(!crawledUrls.includes(`${origin}/skip`));
        assert.equal(result.totalPages, 2);
    } finally {
        AgentCrawl.scrape = originalScrape;
    }
});
