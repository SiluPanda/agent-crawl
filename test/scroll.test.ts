import test from 'node:test';
import assert from 'node:assert/strict';
import { ScrapeOptionsSchema } from '../src/schemas.js';

// ---------------------------------------------------------------------------
// Schema validation
// ---------------------------------------------------------------------------

test('schema accepts scroll: true', () => {
    const result = ScrapeOptionsSchema.safeParse({
        url: 'https://example.com',
        scroll: true,
    });
    assert.ok(result.success);
});

test('schema accepts scroll: false', () => {
    const result = ScrapeOptionsSchema.safeParse({
        url: 'https://example.com',
        scroll: false,
    });
    assert.ok(result.success);
});

test('schema accepts scroll with full config', () => {
    const result = ScrapeOptionsSchema.safeParse({
        url: 'https://example.com',
        scroll: {
            enabled: true,
            maxScrolls: 20,
            scrollDelay: 1000,
            selector: '.feed-container',
        },
    });
    assert.ok(result.success);
});

test('schema accepts scroll with partial config', () => {
    const result = ScrapeOptionsSchema.safeParse({
        url: 'https://example.com',
        scroll: { maxScrolls: 5 },
    });
    assert.ok(result.success);
});

test('schema rejects maxScrolls > 100', () => {
    const result = ScrapeOptionsSchema.safeParse({
        url: 'https://example.com',
        scroll: { maxScrolls: 101 },
    });
    assert.ok(!result.success);
});

test('schema rejects maxScrolls < 1', () => {
    const result = ScrapeOptionsSchema.safeParse({
        url: 'https://example.com',
        scroll: { maxScrolls: 0 },
    });
    assert.ok(!result.success);
});

test('schema rejects scrollDelay < 100', () => {
    const result = ScrapeOptionsSchema.safeParse({
        url: 'https://example.com',
        scroll: { scrollDelay: 50 },
    });
    assert.ok(!result.success);
});

test('schema rejects scrollDelay > 10000', () => {
    const result = ScrapeOptionsSchema.safeParse({
        url: 'https://example.com',
        scroll: { scrollDelay: 11000 },
    });
    assert.ok(!result.success);
});

test('schema rejects selector > 500 chars', () => {
    const result = ScrapeOptionsSchema.safeParse({
        url: 'https://example.com',
        scroll: { selector: 'x'.repeat(501) },
    });
    assert.ok(!result.success);
});

test('schema allows omitting scroll', () => {
    const result = ScrapeOptionsSchema.safeParse({
        url: 'https://example.com',
    });
    assert.ok(result.success);
});

test('schema accepts scroll with all other features', () => {
    const result = ScrapeOptionsSchema.safeParse({
        url: 'https://example.com',
        mode: 'browser',
        scroll: { maxScrolls: 10, scrollDelay: 500 },
        jsCode: 'console.log("hi")',
        screenshot: true,
        stealth: true,
    });
    assert.ok(result.success);
});

// ---------------------------------------------------------------------------
// AgentCrawl integration: scroll forces browser mode
// ---------------------------------------------------------------------------

test('scroll: true forces browser mode', async () => {
    const { AgentCrawl } = await import('../src/AgentCrawl.js');

    let fetcherCalled = false;
    let browserCalled = false;
    let receivedOpts: any;

    const origFetcher = (AgentCrawl as any).fetcher;
    const origBrowser = (AgentCrawl as any).browserManager;
    const origMarkdown = (AgentCrawl as any).markdownifier;
    const origCache = (AgentCrawl as any).cache;

    try {
        (AgentCrawl as any).fetcher = {
            fetch: async () => {
                fetcherCalled = true;
                return {
                    url: 'https://example.com', html: '<html><body>Static</body></html>',
                    status: 200, headers: {}, isStaticSuccess: true, needsBrowser: false,
                };
            },
        };
        (AgentCrawl as any).browserManager = {
            getPage: async (_url: string, _wf?: string, opts?: any) => {
                browserCalled = true;
                receivedOpts = opts;
                return {
                    html: '<html><body>Scrolled</body></html>',
                    status: 200, headers: {},
                };
            },
        };
        (AgentCrawl as any).markdownifier = {
            extractAll: () => ({ title: 'T', links: [], markdown: 'Scrolled' }),
        };
        (AgentCrawl as any).cache = { get: () => null, set: () => {} };

        const page = await AgentCrawl.scrape('https://example.com', {
            mode: 'hybrid',
            scroll: true,
        });

        assert.equal(fetcherCalled, false, 'static fetcher should be skipped');
        assert.equal(browserCalled, true, 'browser should be used');
        assert.ok(receivedOpts.scroll, 'scroll config should be passed to browser');
        assert.equal(page.content, 'Scrolled');
    } finally {
        (AgentCrawl as any).fetcher = origFetcher;
        (AgentCrawl as any).browserManager = origBrowser;
        (AgentCrawl as any).markdownifier = origMarkdown;
        (AgentCrawl as any).cache = origCache;
    }
});

test('scroll config object forces browser mode', async () => {
    const { AgentCrawl } = await import('../src/AgentCrawl.js');

    let fetcherCalled = false;
    let receivedOpts: any;

    const origFetcher = (AgentCrawl as any).fetcher;
    const origBrowser = (AgentCrawl as any).browserManager;
    const origMarkdown = (AgentCrawl as any).markdownifier;
    const origCache = (AgentCrawl as any).cache;

    try {
        (AgentCrawl as any).fetcher = {
            fetch: async () => {
                fetcherCalled = true;
                return { url: '', html: '', status: 200, headers: {}, isStaticSuccess: true, needsBrowser: false };
            },
        };
        (AgentCrawl as any).browserManager = {
            getPage: async (_url: string, _wf?: string, opts?: any) => {
                receivedOpts = opts;
                return { html: '<html><body>OK</body></html>', status: 200, headers: {} };
            },
        };
        (AgentCrawl as any).markdownifier = {
            extractAll: () => ({ title: 'T', links: [], markdown: 'OK' }),
        };
        (AgentCrawl as any).cache = { get: () => null, set: () => {} };

        await AgentCrawl.scrape('https://example.com', {
            scroll: { maxScrolls: 5, scrollDelay: 300 },
        });

        assert.equal(fetcherCalled, false);
        assert.equal(receivedOpts.scroll.maxScrolls, 5);
        assert.equal(receivedOpts.scroll.scrollDelay, 300);
    } finally {
        (AgentCrawl as any).fetcher = origFetcher;
        (AgentCrawl as any).browserManager = origBrowser;
        (AgentCrawl as any).markdownifier = origMarkdown;
        (AgentCrawl as any).cache = origCache;
    }
});

test('scroll: false does not force browser mode', async () => {
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
                    url: 'https://example.com', html: '<html><body>Static</body></html>',
                    status: 200, headers: {}, isStaticSuccess: true, needsBrowser: false,
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
            scroll: false,
        });

        assert.equal(fetcherCalled, true);
        assert.equal(browserCalled, false);
    } finally {
        (AgentCrawl as any).fetcher = origFetcher;
        (AgentCrawl as any).browserManager = origBrowser;
        (AgentCrawl as any).markdownifier = origMarkdown;
        (AgentCrawl as any).cache = origCache;
    }
});

test('scroll { enabled: false } does not force browser mode', async () => {
    const { AgentCrawl } = await import('../src/AgentCrawl.js');

    let fetcherCalled = false;

    const origFetcher = (AgentCrawl as any).fetcher;
    const origMarkdown = (AgentCrawl as any).markdownifier;
    const origCache = (AgentCrawl as any).cache;

    try {
        (AgentCrawl as any).fetcher = {
            fetch: async () => {
                fetcherCalled = true;
                return {
                    url: 'https://example.com', html: '<html><body>S</body></html>',
                    status: 200, headers: {}, isStaticSuccess: true, needsBrowser: false,
                };
            },
        };
        (AgentCrawl as any).markdownifier = {
            extractAll: () => ({ title: 'T', links: [], markdown: 'S' }),
        };
        (AgentCrawl as any).cache = { get: () => null, set: () => {} };

        await AgentCrawl.scrape('https://example.com', {
            mode: 'hybrid',
            scroll: { enabled: false, maxScrolls: 10 },
        });

        assert.equal(fetcherCalled, true);
    } finally {
        (AgentCrawl as any).fetcher = origFetcher;
        (AgentCrawl as any).markdownifier = origMarkdown;
        (AgentCrawl as any).cache = origCache;
    }
});

// ---------------------------------------------------------------------------
// CLI integration
// ---------------------------------------------------------------------------

test('CLI --scroll flag accepted', async () => {
    const { execFileSync } = await import('node:child_process');
    const path = await import('node:path');
    const CLI = path.resolve('dist/cli.js');

    try {
        // Just verify the flag parses without error (scraping a private host so no network)
        execFileSync('node', [CLI, 'scrape', 'http://127.0.0.1', '--scroll', '-o', 'json'], {
            encoding: 'utf-8',
            timeout: 10000,
            stdio: ['pipe', 'pipe', 'pipe'],
        });
    } catch (e: any) {
        // Should get SSRF block, not a flag parsing error
        const output = e.stdout?.toString() || '';
        const parsed = JSON.parse(output);
        assert.ok(parsed.metadata.error.includes('private'));
    }
});
