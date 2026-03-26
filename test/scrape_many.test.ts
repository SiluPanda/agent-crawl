import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentCrawl } from '../src/AgentCrawl.js';
import type { ScrapedPage, ScrapeTarget } from '../src/types.js';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const originalFetch = globalThis.fetch;

test.afterEach(() => {
    globalThis.fetch = originalFetch;
});

function makePage(url: string, content = 'ok'): ScrapedPage {
    return { url, content, title: 't', links: [], metadata: { status: 200 } };
}

// ---------------------------------------------------------------------------
// Basic scrapeMany functionality
// ---------------------------------------------------------------------------

test('scrapeMany with string array', async () => {
    const originalScrape = AgentCrawl.scrape.bind(AgentCrawl);
    AgentCrawl.scrape = async (url: string) => makePage(url, `content-${url}`);

    try {
        const result = await AgentCrawl.scrapeMany([
            'https://a.com',
            'https://b.com',
            'https://c.com',
        ]);

        assert.equal(result.totalPages, 3);
        assert.equal(result.pages[0].url, 'https://a.com');
        assert.equal(result.pages[1].url, 'https://b.com');
        assert.equal(result.pages[2].url, 'https://c.com');
        assert.equal(result.pages[0].content, 'content-https://a.com');
        assert.equal(result.errors.length, 0);
    } finally {
        AgentCrawl.scrape = originalScrape;
    }
});

test('scrapeMany with ScrapeTarget array', async () => {
    const originalScrape = AgentCrawl.scrape.bind(AgentCrawl);
    const receivedConfigs: any[] = [];

    AgentCrawl.scrape = async (url: string, config: any) => {
        receivedConfigs.push({ url, mode: config?.mode });
        return makePage(url);
    };

    try {
        const targets: ScrapeTarget[] = [
            { url: 'https://a.com', config: { mode: 'static' } },
            { url: 'https://b.com', config: { mode: 'browser' } },
        ];

        const result = await AgentCrawl.scrapeMany(targets);

        assert.equal(result.totalPages, 2);
        assert.equal(receivedConfigs[0].mode, 'static');
        assert.equal(receivedConfigs[1].mode, 'browser');
    } finally {
        AgentCrawl.scrape = originalScrape;
    }
});

test('scrapeMany with shared config', async () => {
    const originalScrape = AgentCrawl.scrape.bind(AgentCrawl);
    const receivedConfigs: any[] = [];

    AgentCrawl.scrape = async (url: string, config: any) => {
        receivedConfigs.push({ url, extractMainContent: config?.extractMainContent });
        return makePage(url);
    };

    try {
        await AgentCrawl.scrapeMany(
            ['https://a.com', 'https://b.com'],
            { extractMainContent: true },
        );

        assert.equal(receivedConfigs[0].extractMainContent, true);
        assert.equal(receivedConfigs[1].extractMainContent, true);
    } finally {
        AgentCrawl.scrape = originalScrape;
    }
});

test('scrapeMany per-URL config overrides shared config', async () => {
    const originalScrape = AgentCrawl.scrape.bind(AgentCrawl);
    const receivedConfigs: any[] = [];

    AgentCrawl.scrape = async (url: string, config: any) => {
        receivedConfigs.push({ url, mode: config?.mode });
        return makePage(url);
    };

    try {
        await AgentCrawl.scrapeMany(
            [
                { url: 'https://a.com' },
                { url: 'https://b.com', config: { mode: 'browser' } },
            ],
            { mode: 'static' },
        );

        assert.equal(receivedConfigs[0].mode, 'static'); // shared
        assert.equal(receivedConfigs[1].mode, 'browser'); // overridden
    } finally {
        AgentCrawl.scrape = originalScrape;
    }
});

// ---------------------------------------------------------------------------
// Concurrency
// ---------------------------------------------------------------------------

test('scrapeMany respects concurrency limit', async () => {
    const originalScrape = AgentCrawl.scrape.bind(AgentCrawl);
    let maxConcurrent = 0;
    let currentConcurrent = 0;

    AgentCrawl.scrape = async (url: string) => {
        currentConcurrent++;
        maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
        await new Promise(r => setTimeout(r, 50));
        currentConcurrent--;
        return makePage(url);
    };

    try {
        await AgentCrawl.scrapeMany(
            Array.from({ length: 10 }, (_, i) => `https://site${i}.com`),
            undefined,
            { concurrency: 3 },
        );

        assert.ok(maxConcurrent <= 3, `Max concurrent was ${maxConcurrent}, expected <= 3`);
        assert.ok(maxConcurrent >= 2, `Max concurrent was ${maxConcurrent}, expected >= 2`);
    } finally {
        AgentCrawl.scrape = originalScrape;
    }
});

test('scrapeMany defaults to concurrency 5', async () => {
    const originalScrape = AgentCrawl.scrape.bind(AgentCrawl);
    let maxConcurrent = 0;
    let currentConcurrent = 0;

    AgentCrawl.scrape = async (url: string) => {
        currentConcurrent++;
        maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
        await new Promise(r => setTimeout(r, 30));
        currentConcurrent--;
        return makePage(url);
    };

    try {
        await AgentCrawl.scrapeMany(
            Array.from({ length: 20 }, (_, i) => `https://site${i}.com`),
        );

        assert.ok(maxConcurrent <= 5, `Max concurrent was ${maxConcurrent}, expected <= 5`);
    } finally {
        AgentCrawl.scrape = originalScrape;
    }
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

test('scrapeMany collects errors without failing', async () => {
    const originalScrape = AgentCrawl.scrape.bind(AgentCrawl);

    AgentCrawl.scrape = async (url: string) => {
        if (url.includes('bad')) {
            return { url, content: '', metadata: { status: 0, error: 'Failed to fetch' } } as ScrapedPage;
        }
        return makePage(url);
    };

    try {
        const result = await AgentCrawl.scrapeMany([
            'https://good.com',
            'https://bad.com',
            'https://also-good.com',
        ]);

        assert.equal(result.totalPages, 3);
        assert.equal(result.errors.length, 1);
        assert.equal(result.errors[0].url, 'https://bad.com');
    } finally {
        AgentCrawl.scrape = originalScrape;
    }
});

test('scrapeMany handles thrown errors gracefully', async () => {
    const originalScrape = AgentCrawl.scrape.bind(AgentCrawl);

    AgentCrawl.scrape = async (url: string) => {
        if (url.includes('throw')) throw new Error('Connection refused');
        return makePage(url);
    };

    try {
        const result = await AgentCrawl.scrapeMany([
            'https://ok.com',
            'https://throw.com',
        ]);

        assert.equal(result.totalPages, 2);
        assert.equal(result.errors.length, 1);
        assert.ok(result.errors[0].error.includes('Connection refused'));
    } finally {
        AgentCrawl.scrape = originalScrape;
    }
});

// ---------------------------------------------------------------------------
// Empty input
// ---------------------------------------------------------------------------

test('scrapeMany with empty array returns empty result', async () => {
    const result = await AgentCrawl.scrapeMany([]);
    assert.equal(result.totalPages, 0);
    assert.equal(result.pages.length, 0);
    assert.equal(result.errors.length, 0);
});

// ---------------------------------------------------------------------------
// onProgress callback
// ---------------------------------------------------------------------------

test('scrapeMany calls onProgress for each page', async () => {
    const originalScrape = AgentCrawl.scrape.bind(AgentCrawl);
    AgentCrawl.scrape = async (url: string) => makePage(url);

    const progressCalls: Array<{ url: string; index: number }> = [];

    try {
        await AgentCrawl.scrapeMany(
            ['https://a.com', 'https://b.com', 'https://c.com'],
            undefined,
            {
                concurrency: 1,
                onProgress: (page, index) => {
                    progressCalls.push({ url: page.url, index });
                },
            },
        );

        assert.equal(progressCalls.length, 3);
        assert.equal(progressCalls[0].index, 0);
        assert.equal(progressCalls[1].index, 1);
        assert.equal(progressCalls[2].index, 2);
    } finally {
        AgentCrawl.scrape = originalScrape;
    }
});

test('onProgress error is non-fatal', async () => {
    const originalScrape = AgentCrawl.scrape.bind(AgentCrawl);
    AgentCrawl.scrape = async (url: string) => makePage(url);

    try {
        const result = await AgentCrawl.scrapeMany(
            ['https://a.com', 'https://b.com'],
            undefined,
            {
                onProgress: () => { throw new Error('callback crash'); },
            },
        );

        assert.equal(result.totalPages, 2, 'Should complete despite callback error');
    } finally {
        AgentCrawl.scrape = originalScrape;
    }
});

// ---------------------------------------------------------------------------
// Results maintain input order
// ---------------------------------------------------------------------------

test('scrapeMany returns pages in input order', async () => {
    const originalScrape = AgentCrawl.scrape.bind(AgentCrawl);

    // Simulate varying response times — later URLs return faster
    AgentCrawl.scrape = async (url: string) => {
        const idx = parseInt(url.replace('https://site', '').replace('.com', ''));
        await new Promise(r => setTimeout(r, (5 - idx) * 20));
        return makePage(url);
    };

    try {
        const result = await AgentCrawl.scrapeMany(
            ['https://site0.com', 'https://site1.com', 'https://site2.com', 'https://site3.com', 'https://site4.com'],
            undefined,
            { concurrency: 5 },
        );

        assert.equal(result.pages[0].url, 'https://site0.com');
        assert.equal(result.pages[1].url, 'https://site1.com');
        assert.equal(result.pages[2].url, 'https://site2.com');
        assert.equal(result.pages[3].url, 'https://site3.com');
        assert.equal(result.pages[4].url, 'https://site4.com');
    } finally {
        AgentCrawl.scrape = originalScrape;
    }
});

// ---------------------------------------------------------------------------
// MCP scrape_many tool
// ---------------------------------------------------------------------------

test('MCP: scrape_many tool listed', () => {
    const MCP = path.resolve('dist/mcp.js');
    const input = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) + '\n';
    let stdout: string;
    try {
        stdout = execFileSync('node', [MCP], { input, encoding: 'utf-8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e: any) {
        stdout = e.stdout?.toString() || '';
    }
    const resp = JSON.parse(stdout.trim().split('\n')[0]);
    const names = resp.result.tools.map((t: any) => t.name);
    assert.ok(names.includes('scrape_many'));
});

// ---------------------------------------------------------------------------
// Live test
// ---------------------------------------------------------------------------

test('scrapeMany live: scrape example.com twice', async () => {
    const result = await AgentCrawl.scrapeMany(
        ['https://example.com', 'https://example.com'],
        { mode: 'static' as const },
        { concurrency: 2 },
    );

    assert.equal(result.totalPages, 2);
    assert.ok(result.pages[0].content.includes('Example Domain'));
    assert.ok(result.pages[1].content.includes('Example Domain'));
    assert.equal(result.errors.length, 0);
}, { timeout: 30000 });
