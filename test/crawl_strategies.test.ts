import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentCrawl } from '../src/AgentCrawl.js';
import { createCrawlQueue, scoreUrl } from '../src/core/CrawlQueue.js';
import { CrawlOptionsSchema } from '../src/schemas.js';
import type { ScrapedPage } from '../src/types.js';

// ---------------------------------------------------------------------------
// CrawlQueue unit tests
// ---------------------------------------------------------------------------

test('BfsQueue: FIFO ordering', () => {
    const q = createCrawlQueue('bfs');
    q.push({ url: 'a', depth: 0 });
    q.push({ url: 'b', depth: 0 });
    q.push({ url: 'c', depth: 0 });
    assert.equal(q.shift()!.url, 'a');
    assert.equal(q.shift()!.url, 'b');
    assert.equal(q.shift()!.url, 'c');
    assert.equal(q.shift(), undefined);
});

test('DfsQueue: LIFO ordering', () => {
    const q = createCrawlQueue('dfs');
    q.push({ url: 'a', depth: 0 });
    q.push({ url: 'b', depth: 0 });
    q.push({ url: 'c', depth: 0 });
    assert.equal(q.shift()!.url, 'c');
    assert.equal(q.shift()!.url, 'b');
    assert.equal(q.shift()!.url, 'a');
    assert.equal(q.shift(), undefined);
});

test('BestFirstQueue: highest score first', () => {
    const q = createCrawlQueue('bestfirst');
    q.push({ url: 'low', depth: 0, score: 1 });
    q.push({ url: 'high', depth: 0, score: 5 });
    q.push({ url: 'mid', depth: 0, score: 3 });
    assert.equal(q.shift()!.url, 'high');
    assert.equal(q.shift()!.url, 'mid');
    assert.equal(q.shift()!.url, 'low');
    assert.equal(q.shift(), undefined);
});

test('BestFirstQueue: equal scores use insertion order', () => {
    const q = createCrawlQueue('bestfirst');
    q.push({ url: 'first', depth: 0, score: 1 });
    q.push({ url: 'second', depth: 0, score: 1 });
    q.push({ url: 'third', depth: 0, score: 1 });
    // Equal scores — first inserted is first out (splice picks first max)
    assert.equal(q.shift()!.url, 'first');
});

test('BestFirstQueue: undefined score treated as 0', () => {
    const q = createCrawlQueue('bestfirst');
    q.push({ url: 'no-score', depth: 0 });
    q.push({ url: 'with-score', depth: 0, score: 2 });
    assert.equal(q.shift()!.url, 'with-score');
    assert.equal(q.shift()!.url, 'no-score');
});

test('BfsQueue: length tracks correctly', () => {
    const q = createCrawlQueue('bfs');
    assert.equal(q.length, 0);
    q.push({ url: 'a', depth: 0 });
    q.push({ url: 'b', depth: 0 });
    assert.equal(q.length, 2);
    q.shift();
    assert.equal(q.length, 1);
    q.shift();
    assert.equal(q.length, 0);
});

test('DfsQueue: length tracks correctly', () => {
    const q = createCrawlQueue('dfs');
    assert.equal(q.length, 0);
    q.push({ url: 'a', depth: 0 });
    assert.equal(q.length, 1);
    q.shift();
    assert.equal(q.length, 0);
});

test('toArray returns remaining items for all strategies', () => {
    for (const strategy of ['bfs', 'dfs', 'bestfirst'] as const) {
        const q = createCrawlQueue(strategy);
        q.push({ url: 'a', depth: 0, score: 1 });
        q.push({ url: 'b', depth: 0, score: 2 });
        q.shift(); // remove one
        const remaining = q.toArray();
        assert.equal(remaining.length, 1);
    }
});

// ---------------------------------------------------------------------------
// scoreUrl
// ---------------------------------------------------------------------------

test('scoreUrl counts keyword matches', () => {
    assert.equal(scoreUrl('https://example.com/products/shoes', ['products', 'shoes']), 2);
    assert.equal(scoreUrl('https://example.com/about', ['products', 'shoes']), 0);
    assert.equal(scoreUrl('https://example.com/products/archive', ['products']), 1);
});

test('scoreUrl is case-insensitive', () => {
    assert.equal(scoreUrl('https://example.com/Products/SHOES', ['products', 'shoes']), 2);
});

test('scoreUrl returns 0 for empty keywords', () => {
    assert.equal(scoreUrl('https://example.com/anything', []), 0);
});

// ---------------------------------------------------------------------------
// Schema validation
// ---------------------------------------------------------------------------

test('schema accepts strategy: bfs', () => {
    const result = CrawlOptionsSchema.safeParse({
        url: 'https://example.com',
        strategy: 'bfs',
    });
    assert.ok(result.success);
});

test('schema accepts strategy: dfs', () => {
    const result = CrawlOptionsSchema.safeParse({
        url: 'https://example.com',
        strategy: 'dfs',
    });
    assert.ok(result.success);
});

test('schema accepts strategy: bestfirst with priorityKeywords', () => {
    const result = CrawlOptionsSchema.safeParse({
        url: 'https://example.com',
        strategy: 'bestfirst',
        priorityKeywords: ['products', 'pricing'],
    });
    assert.ok(result.success);
});

test('schema rejects invalid strategy', () => {
    const result = CrawlOptionsSchema.safeParse({
        url: 'https://example.com',
        strategy: 'random',
    });
    assert.ok(!result.success);
});

test('schema rejects more than 50 priorityKeywords', () => {
    const keywords = Array.from({ length: 51 }, (_, i) => `kw${i}`);
    const result = CrawlOptionsSchema.safeParse({
        url: 'https://example.com',
        priorityKeywords: keywords,
    });
    assert.ok(!result.success);
});

test('schema defaults strategy to bfs', () => {
    const result = CrawlOptionsSchema.safeParse({
        url: 'https://example.com',
    });
    assert.ok(result.success);
    if (result.success) {
        assert.equal(result.data.strategy, 'bfs');
    }
});

// ---------------------------------------------------------------------------
// Integration: DFS crawl visits deeper pages before wider ones
// ---------------------------------------------------------------------------

const originalFetch = globalThis.fetch;

function makePage(url: string, links: string[] = []): ScrapedPage {
    return { url, content: 'ok', title: 't', links, metadata: { status: 200 } };
}

test.afterEach(() => {
    globalThis.fetch = originalFetch;
});

test('DFS crawl explores depth-first', async () => {
    // Site structure:
    //   /         → [/a, /b]
    //   /a        → [/a/deep]
    //   /b        → [/b/deep]
    //   /a/deep   → []
    //   /b/deep   → []
    // BFS order: /, /a, /b, /a/deep, /b/deep
    // DFS order: /, /b (last link pushed, popped first), /b/deep, /a, /a/deep
    const origin = 'https://dfs-test.site';

    // Mock fetch for robots/sitemap (no-op)
    globalThis.fetch = (async () => new Response('not found', { status: 404 })) as typeof fetch;

    const visitOrder: string[] = [];
    const originalScrape = AgentCrawl.scrape.bind(AgentCrawl);
    AgentCrawl.scrape = async (url: string) => {
        visitOrder.push(url);
        if (url === `${origin}/`) return makePage(url, [`${origin}/a`, `${origin}/b`]);
        if (url === `${origin}/a`) return makePage(url, [`${origin}/a/deep`]);
        if (url === `${origin}/b`) return makePage(url, [`${origin}/b/deep`]);
        return makePage(url, []);
    };

    try {
        const result = await AgentCrawl.crawl(`${origin}/`, {
            maxDepth: 3,
            maxPages: 10,
            concurrency: 1, // Sequential to observe ordering
            strategy: 'dfs',
        });

        assert.equal(result.totalPages, 5);
        // DFS: after visiting /, links [/a, /b] are pushed. /b is popped first (LIFO)
        assert.equal(visitOrder[0], `${origin}/`);
        assert.equal(visitOrder[1], `${origin}/b`);
        assert.equal(visitOrder[2], `${origin}/b/deep`);
        assert.equal(visitOrder[3], `${origin}/a`);
        assert.equal(visitOrder[4], `${origin}/a/deep`);
    } finally {
        AgentCrawl.scrape = originalScrape;
    }
});

test('BFS crawl explores breadth-first (default)', async () => {
    const origin = 'https://bfs-test.site';

    globalThis.fetch = (async () => new Response('not found', { status: 404 })) as typeof fetch;

    const visitOrder: string[] = [];
    const originalScrape = AgentCrawl.scrape.bind(AgentCrawl);
    AgentCrawl.scrape = async (url: string) => {
        visitOrder.push(url);
        if (url === `${origin}/`) return makePage(url, [`${origin}/a`, `${origin}/b`]);
        if (url === `${origin}/a`) return makePage(url, [`${origin}/a/deep`]);
        if (url === `${origin}/b`) return makePage(url, [`${origin}/b/deep`]);
        return makePage(url, []);
    };

    try {
        const result = await AgentCrawl.crawl(`${origin}/`, {
            maxDepth: 3,
            maxPages: 10,
            concurrency: 1,
            strategy: 'bfs',
        });

        assert.equal(result.totalPages, 5);
        // BFS: /, /a, /b (breadth level 1), then /a/deep, /b/deep (level 2)
        assert.equal(visitOrder[0], `${origin}/`);
        assert.equal(visitOrder[1], `${origin}/a`);
        assert.equal(visitOrder[2], `${origin}/b`);
        assert.equal(visitOrder[3], `${origin}/a/deep`);
        assert.equal(visitOrder[4], `${origin}/b/deep`);
    } finally {
        AgentCrawl.scrape = originalScrape;
    }
});

test('bestfirst crawl prioritizes keyword-matching URLs', async () => {
    const origin = 'https://bf-test.site';

    globalThis.fetch = (async () => new Response('not found', { status: 404 })) as typeof fetch;

    const visitOrder: string[] = [];
    const originalScrape = AgentCrawl.scrape.bind(AgentCrawl);
    AgentCrawl.scrape = async (url: string) => {
        visitOrder.push(url);
        if (url === `${origin}/`) {
            return makePage(url, [
                `${origin}/about`,
                `${origin}/products`,
                `${origin}/contact`,
                `${origin}/products/pricing`,
            ]);
        }
        return makePage(url, []);
    };

    try {
        const result = await AgentCrawl.crawl(`${origin}/`, {
            maxDepth: 2,
            maxPages: 10,
            concurrency: 1,
            strategy: 'bestfirst',
            priorityKeywords: ['products', 'pricing'],
        });

        assert.equal(result.totalPages, 5);
        // After /, the queue has: /about(0), /products(1), /contact(0), /products/pricing(2)
        // Best-first pops: /products/pricing first (score 2), then /products (score 1)
        assert.equal(visitOrder[0], `${origin}/`);
        assert.equal(visitOrder[1], `${origin}/products/pricing`); // score: 2
        assert.equal(visitOrder[2], `${origin}/products`); // score: 1
        // /about and /contact have score 0, order between them is insertion order
        const remaining = visitOrder.slice(3);
        assert.ok(remaining.includes(`${origin}/about`));
        assert.ok(remaining.includes(`${origin}/contact`));
    } finally {
        AgentCrawl.scrape = originalScrape;
    }
});

test('default strategy is bfs when not specified', async () => {
    const origin = 'https://default-test.site';

    globalThis.fetch = (async () => new Response('not found', { status: 404 })) as typeof fetch;

    const visitOrder: string[] = [];
    const originalScrape = AgentCrawl.scrape.bind(AgentCrawl);
    AgentCrawl.scrape = async (url: string) => {
        visitOrder.push(url);
        if (url === `${origin}/`) return makePage(url, [`${origin}/a`, `${origin}/b`]);
        return makePage(url, []);
    };

    try {
        await AgentCrawl.crawl(`${origin}/`, {
            maxDepth: 2,
            maxPages: 10,
            concurrency: 1,
            // strategy not set — should default to bfs
        });

        // BFS order
        assert.equal(visitOrder[0], `${origin}/`);
        assert.equal(visitOrder[1], `${origin}/a`);
        assert.equal(visitOrder[2], `${origin}/b`);
    } finally {
        AgentCrawl.scrape = originalScrape;
    }
});
