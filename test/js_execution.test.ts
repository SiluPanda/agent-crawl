import test from 'node:test';
import assert from 'node:assert/strict';
import { ScrapeOptionsSchema } from '../src/schemas.js';

// ---------------------------------------------------------------------------
// Schema validation for jsCode
// ---------------------------------------------------------------------------

test('schema accepts jsCode as single string', () => {
    const result = ScrapeOptionsSchema.safeParse({
        url: 'https://example.com',
        jsCode: 'document.querySelector(".load-more").click()',
    });
    assert.ok(result.success);
});

test('schema accepts jsCode as array of strings', () => {
    const result = ScrapeOptionsSchema.safeParse({
        url: 'https://example.com',
        jsCode: [
            'document.querySelector(".load-more").click()',
            'window.scrollTo(0, document.body.scrollHeight)',
        ],
    });
    assert.ok(result.success);
});

test('schema accepts empty jsCode array', () => {
    const result = ScrapeOptionsSchema.safeParse({
        url: 'https://example.com',
        jsCode: [],
    });
    assert.ok(result.success);
});

test('schema rejects jsCode string exceeding 50KB', () => {
    const result = ScrapeOptionsSchema.safeParse({
        url: 'https://example.com',
        jsCode: 'x'.repeat(51201),
    });
    assert.ok(!result.success);
});

test('schema rejects jsCode array with script exceeding 50KB', () => {
    const result = ScrapeOptionsSchema.safeParse({
        url: 'https://example.com',
        jsCode: ['short', 'x'.repeat(51201)],
    });
    assert.ok(!result.success);
});

test('schema rejects jsCode array with more than 10 scripts', () => {
    const scripts = Array.from({ length: 11 }, (_, i) => `console.log(${i})`);
    const result = ScrapeOptionsSchema.safeParse({
        url: 'https://example.com',
        jsCode: scripts,
    });
    assert.ok(!result.success);
});

test('schema accepts jsCode with exactly 10 scripts', () => {
    const scripts = Array.from({ length: 10 }, (_, i) => `console.log(${i})`);
    const result = ScrapeOptionsSchema.safeParse({
        url: 'https://example.com',
        jsCode: scripts,
    });
    assert.ok(result.success);
});

test('schema allows omitting jsCode', () => {
    const result = ScrapeOptionsSchema.safeParse({
        url: 'https://example.com',
    });
    assert.ok(result.success);
});

// ---------------------------------------------------------------------------
// AgentCrawl integration: jsCode forces browser mode
// ---------------------------------------------------------------------------

test('jsCode forces browser mode even when hybrid is set', async () => {
    // Dynamically import to allow patching static members
    const { AgentCrawl } = await import('../src/AgentCrawl.js');

    let browserCalled = false;
    let fetcherCalled = false;
    let receivedJsCode: string[] | undefined;

    const origFetcher = (AgentCrawl as any).fetcher;
    const origBrowser = (AgentCrawl as any).browserManager;
    const origMarkdown = (AgentCrawl as any).markdownifier;
    const origCache = (AgentCrawl as any).cache;

    try {
        (AgentCrawl as any).fetcher = {
            fetch: async () => {
                fetcherCalled = true;
                return {
                    url: 'https://example.com',
                    html: '<html><body>Static</body></html>',
                    status: 200,
                    headers: {},
                    isStaticSuccess: true,
                    needsBrowser: false,
                };
            },
        };
        (AgentCrawl as any).browserManager = {
            getPage: async (_url: string, _wf?: string, opts?: any) => {
                browserCalled = true;
                receivedJsCode = opts?.jsCode;
                return {
                    html: '<html><body>After JS</body></html>',
                    status: 200,
                    headers: {},
                };
            },
        };
        (AgentCrawl as any).markdownifier = {
            extractAll: () => ({
                title: 'Test',
                links: [],
                markdown: 'After JS',
            }),
        };
        (AgentCrawl as any).cache = { get: () => null, set: () => {} };

        const page = await AgentCrawl.scrape('https://example.com', {
            mode: 'hybrid',
            jsCode: 'document.querySelector(".btn").click()',
        });

        // jsCode should force browser, skip static fetch
        assert.equal(fetcherCalled, false, 'static fetcher should not be called when jsCode is set');
        assert.equal(browserCalled, true, 'browser should be used when jsCode is set');
        assert.deepEqual(receivedJsCode, ['document.querySelector(".btn").click()']);
        assert.equal(page.content, 'After JS');
    } finally {
        (AgentCrawl as any).fetcher = origFetcher;
        (AgentCrawl as any).browserManager = origBrowser;
        (AgentCrawl as any).markdownifier = origMarkdown;
        (AgentCrawl as any).cache = origCache;
    }
});

test('jsCode as array is passed through to browser', async () => {
    const { AgentCrawl } = await import('../src/AgentCrawl.js');

    let receivedJsCode: string[] | undefined;

    const origBrowser = (AgentCrawl as any).browserManager;
    const origMarkdown = (AgentCrawl as any).markdownifier;
    const origCache = (AgentCrawl as any).cache;

    try {
        (AgentCrawl as any).browserManager = {
            getPage: async (_url: string, _wf?: string, opts?: any) => {
                receivedJsCode = opts?.jsCode;
                return {
                    html: '<html><body>Done</body></html>',
                    status: 200,
                    headers: {},
                };
            },
        };
        (AgentCrawl as any).markdownifier = {
            extractAll: () => ({ title: 'T', links: [], markdown: 'Done' }),
        };
        (AgentCrawl as any).cache = { get: () => null, set: () => {} };

        await AgentCrawl.scrape('https://example.com', {
            mode: 'browser',
            jsCode: ['script1()', 'script2()'],
        });

        assert.deepEqual(receivedJsCode, ['script1()', 'script2()']);
    } finally {
        (AgentCrawl as any).browserManager = origBrowser;
        (AgentCrawl as any).markdownifier = origMarkdown;
        (AgentCrawl as any).cache = origCache;
    }
});

test('empty jsCode string is filtered out and does not force browser', async () => {
    const { AgentCrawl } = await import('../src/AgentCrawl.js');

    let fetcherCalled = false;
    let browserCalled = false;

    const origFetcher = (AgentCrawl as any).fetcher;
    const origBrowser = (AgentCrawl as any).browserManager;
    const origMarkdown = (AgentCrawl as any).markdownifier;
    const origCache = (AgentCrawl as any).cache;

    try {
        (AgentCrawl as any).fetcher = {
            fetch: async () => {
                fetcherCalled = true;
                return {
                    url: 'https://example.com',
                    html: '<html><body>Static</body></html>',
                    status: 200,
                    headers: {},
                    isStaticSuccess: true,
                    needsBrowser: false,
                };
            },
        };
        (AgentCrawl as any).browserManager = {
            getPage: async () => {
                browserCalled = true;
                return { html: '', status: 200, headers: {} };
            },
        };
        (AgentCrawl as any).markdownifier = {
            extractAll: () => ({ title: 'T', links: [], markdown: 'Static' }),
        };
        (AgentCrawl as any).cache = { get: () => null, set: () => {} };

        await AgentCrawl.scrape('https://example.com', {
            mode: 'hybrid',
            jsCode: '   ', // whitespace-only, should be filtered
        });

        // Empty/whitespace jsCode should not force browser mode
        assert.equal(fetcherCalled, true);
        assert.equal(browserCalled, false);
    } finally {
        (AgentCrawl as any).fetcher = origFetcher;
        (AgentCrawl as any).browserManager = origBrowser;
        (AgentCrawl as any).markdownifier = origMarkdown;
        (AgentCrawl as any).cache = origCache;
    }
});

// ---------------------------------------------------------------------------
// Normalization: jsCode string → array
// ---------------------------------------------------------------------------

test('jsCode single string is normalized to array in browser options', async () => {
    const { AgentCrawl } = await import('../src/AgentCrawl.js');

    let receivedJsCode: any;

    const origBrowser = (AgentCrawl as any).browserManager;
    const origMarkdown = (AgentCrawl as any).markdownifier;
    const origCache = (AgentCrawl as any).cache;

    try {
        (AgentCrawl as any).browserManager = {
            getPage: async (_url: string, _wf?: string, opts?: any) => {
                receivedJsCode = opts?.jsCode;
                return { html: '<html><body>X</body></html>', status: 200, headers: {} };
            },
        };
        (AgentCrawl as any).markdownifier = {
            extractAll: () => ({ title: '', links: [], markdown: 'X' }),
        };
        (AgentCrawl as any).cache = { get: () => null, set: () => {} };

        await AgentCrawl.scrape('https://example.com', {
            jsCode: 'console.log("hi")',
        });

        assert.ok(Array.isArray(receivedJsCode));
        assert.equal(receivedJsCode.length, 1);
        assert.equal(receivedJsCode[0], 'console.log("hi")');
    } finally {
        (AgentCrawl as any).browserManager = origBrowser;
        (AgentCrawl as any).markdownifier = origMarkdown;
        (AgentCrawl as any).cache = origCache;
    }
});

// ---------------------------------------------------------------------------
// Cache key differentiation with jsCode
// ---------------------------------------------------------------------------

test('different jsCode produces different cache keys', async () => {
    const { AgentCrawl } = await import('../src/AgentCrawl.js');

    const results: string[] = [];

    const origBrowser = (AgentCrawl as any).browserManager;
    const origMarkdown = (AgentCrawl as any).markdownifier;
    const origCache = (AgentCrawl as any).cache;

    try {
        (AgentCrawl as any).browserManager = {
            getPage: async () => ({
                html: '<html><body>Content</body></html>',
                status: 200,
                headers: {},
            }),
        };
        (AgentCrawl as any).markdownifier = {
            extractAll: () => ({ title: 'T', links: [], markdown: 'Content' }),
        };

        const setKeys: string[] = [];
        (AgentCrawl as any).cache = {
            get: () => null,
            set: (key: string) => { setKeys.push(key); },
        };

        await AgentCrawl.scrape('https://example.com', { jsCode: 'scriptA()' });
        await AgentCrawl.scrape('https://example.com', { jsCode: 'scriptB()' });

        assert.equal(setKeys.length, 2);
        assert.notEqual(setKeys[0], setKeys[1], 'cache keys should differ for different jsCode');
    } finally {
        (AgentCrawl as any).browserManager = origBrowser;
        (AgentCrawl as any).markdownifier = origMarkdown;
        (AgentCrawl as any).cache = origCache;
    }
});

// ---------------------------------------------------------------------------
// jsCode combined with other features
// ---------------------------------------------------------------------------

test('schema accepts jsCode combined with proxy, headers, cookies, extraction', () => {
    const result = ScrapeOptionsSchema.safeParse({
        url: 'https://example.com',
        mode: 'browser',
        jsCode: ['document.querySelector(".more").click()'],
        proxy: { url: 'http://proxy:8080' },
        headers: { 'Authorization': 'Bearer tok' },
        cookies: [{ name: 'sid', value: '123' }],
        extraction: {
            type: 'css',
            schema: { title: 'h1' },
        },
    });
    assert.ok(result.success);
});
