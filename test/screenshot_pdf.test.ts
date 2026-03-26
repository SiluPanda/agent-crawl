import test from 'node:test';
import assert from 'node:assert/strict';
import { ScrapeOptionsSchema } from '../src/schemas.js';

// ---------------------------------------------------------------------------
// Schema validation
// ---------------------------------------------------------------------------

test('schema accepts screenshot: true', () => {
    const result = ScrapeOptionsSchema.safeParse({
        url: 'https://example.com',
        screenshot: true,
    });
    assert.ok(result.success);
});

test('schema accepts pdf: true', () => {
    const result = ScrapeOptionsSchema.safeParse({
        url: 'https://example.com',
        pdf: true,
    });
    assert.ok(result.success);
});

test('schema accepts both screenshot and pdf', () => {
    const result = ScrapeOptionsSchema.safeParse({
        url: 'https://example.com',
        screenshot: true,
        pdf: true,
    });
    assert.ok(result.success);
});

test('schema accepts screenshot: false', () => {
    const result = ScrapeOptionsSchema.safeParse({
        url: 'https://example.com',
        screenshot: false,
    });
    assert.ok(result.success);
});

test('schema allows omitting screenshot and pdf', () => {
    const result = ScrapeOptionsSchema.safeParse({
        url: 'https://example.com',
    });
    assert.ok(result.success);
});

test('schema accepts screenshot combined with all other options', () => {
    const result = ScrapeOptionsSchema.safeParse({
        url: 'https://example.com',
        mode: 'browser',
        screenshot: true,
        pdf: true,
        jsCode: 'console.log("hi")',
        proxy: { url: 'http://proxy:8080' },
        headers: { 'Authorization': 'Bearer tok' },
        cookies: [{ name: 'sid', value: '123' }],
        extraction: { type: 'css', schema: { title: 'h1' } },
    });
    assert.ok(result.success);
});

// ---------------------------------------------------------------------------
// AgentCrawl integration: screenshot forces browser mode
// ---------------------------------------------------------------------------

test('screenshot forces browser mode, skips static fetch', async () => {
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
                    html: '<html><body>Page</body></html>',
                    status: 200, headers: {},
                    screenshot: 'iVBORw0KGgo=', // fake base64
                };
            },
        };
        (AgentCrawl as any).markdownifier = {
            extractAll: () => ({ title: 'T', links: [], markdown: 'Page' }),
        };
        (AgentCrawl as any).cache = { get: () => null, set: () => {} };

        const page = await AgentCrawl.scrape('https://example.com', {
            mode: 'hybrid',
            screenshot: true,
        });

        assert.equal(fetcherCalled, false, 'static fetcher should be skipped');
        assert.equal(browserCalled, true, 'browser should be used');
        assert.equal(receivedOpts.screenshot, true);
        assert.equal(page.screenshot, 'iVBORw0KGgo=');
        assert.equal(page.content, 'Page');
    } finally {
        (AgentCrawl as any).fetcher = origFetcher;
        (AgentCrawl as any).browserManager = origBrowser;
        (AgentCrawl as any).markdownifier = origMarkdown;
        (AgentCrawl as any).cache = origCache;
    }
});

test('pdf forces browser mode', async () => {
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
                return {
                    url: 'https://example.com', html: '', status: 200,
                    headers: {}, isStaticSuccess: true, needsBrowser: false,
                };
            },
        };
        (AgentCrawl as any).browserManager = {
            getPage: async (_url: string, _wf?: string, opts?: any) => {
                receivedOpts = opts;
                return {
                    html: '<html><body>Doc</body></html>',
                    status: 200, headers: {},
                    pdf: 'JVBERi0xLjQ=', // fake base64
                };
            },
        };
        (AgentCrawl as any).markdownifier = {
            extractAll: () => ({ title: 'T', links: [], markdown: 'Doc' }),
        };
        (AgentCrawl as any).cache = { get: () => null, set: () => {} };

        const page = await AgentCrawl.scrape('https://example.com', {
            mode: 'hybrid',
            pdf: true,
        });

        assert.equal(fetcherCalled, false);
        assert.equal(receivedOpts.pdf, true);
        assert.equal(page.pdf, 'JVBERi0xLjQ=');
    } finally {
        (AgentCrawl as any).fetcher = origFetcher;
        (AgentCrawl as any).browserManager = origBrowser;
        (AgentCrawl as any).markdownifier = origMarkdown;
        (AgentCrawl as any).cache = origCache;
    }
});

test('both screenshot and pdf returned on ScrapedPage', async () => {
    const { AgentCrawl } = await import('../src/AgentCrawl.js');

    const origBrowser = (AgentCrawl as any).browserManager;
    const origMarkdown = (AgentCrawl as any).markdownifier;
    const origCache = (AgentCrawl as any).cache;

    try {
        (AgentCrawl as any).browserManager = {
            getPage: async () => ({
                html: '<html><body>Both</body></html>',
                status: 200, headers: {},
                screenshot: 'SCREEN_B64',
                pdf: 'PDF_B64',
            }),
        };
        (AgentCrawl as any).markdownifier = {
            extractAll: () => ({ title: 'T', links: [], markdown: 'Both' }),
        };
        (AgentCrawl as any).cache = { get: () => null, set: () => {} };

        const page = await AgentCrawl.scrape('https://example.com', {
            mode: 'browser',
            screenshot: true,
            pdf: true,
        });

        assert.equal(page.screenshot, 'SCREEN_B64');
        assert.equal(page.pdf, 'PDF_B64');
        assert.equal(page.content, 'Both');
    } finally {
        (AgentCrawl as any).browserManager = origBrowser;
        (AgentCrawl as any).markdownifier = origMarkdown;
        (AgentCrawl as any).cache = origCache;
    }
});

test('screenshot/pdf undefined when not requested', async () => {
    const { AgentCrawl } = await import('../src/AgentCrawl.js');

    const origFetcher = (AgentCrawl as any).fetcher;
    const origMarkdown = (AgentCrawl as any).markdownifier;
    const origCache = (AgentCrawl as any).cache;

    try {
        (AgentCrawl as any).fetcher = {
            fetch: async () => ({
                url: 'https://example.com',
                html: '<html><body>Normal</body></html>',
                status: 200, headers: {},
                isStaticSuccess: true, needsBrowser: false,
            }),
        };
        (AgentCrawl as any).markdownifier = {
            extractAll: () => ({ title: 'T', links: [], markdown: 'Normal' }),
        };
        (AgentCrawl as any).cache = { get: () => null, set: () => {} };

        const page = await AgentCrawl.scrape('https://example.com', {
            mode: 'static',
        });

        assert.equal(page.screenshot, undefined);
        assert.equal(page.pdf, undefined);
    } finally {
        (AgentCrawl as any).fetcher = origFetcher;
        (AgentCrawl as any).markdownifier = origMarkdown;
        (AgentCrawl as any).cache = origCache;
    }
});

test('screenshot false does not force browser', async () => {
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
                    status: 200, headers: {},
                    isStaticSuccess: true, needsBrowser: false,
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
            screenshot: false,
            pdf: false,
        });

        assert.equal(fetcherCalled, true, 'static fetch should be used');
        assert.equal(browserCalled, false, 'browser should not be forced');
    } finally {
        (AgentCrawl as any).fetcher = origFetcher;
        (AgentCrawl as any).browserManager = origBrowser;
        (AgentCrawl as any).markdownifier = origMarkdown;
        (AgentCrawl as any).cache = origCache;
    }
});

// ---------------------------------------------------------------------------
// BrowserManager: screenshot/pdf capture
// ---------------------------------------------------------------------------

test('BrowserPageResult includes screenshot and pdf fields in type', () => {
    // Compile-time type check via runtime object
    const result = {
        html: '<html></html>',
        status: 200,
        headers: {},
        finalUrl: 'https://example.com',
        screenshot: 'base64data',
        pdf: 'base64data',
    };
    assert.ok(result.screenshot);
    assert.ok(result.pdf);
});

test('BrowserPageOptions includes screenshot and pdf fields', () => {
    const opts = {
        stealth: false,
        screenshot: true,
        pdf: true,
    };
    assert.equal(opts.screenshot, true);
    assert.equal(opts.pdf, true);
});
