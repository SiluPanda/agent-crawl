import test from 'node:test';
import assert from 'node:assert/strict';
import type { ScrapedPage } from '../src/types.js';

type AnyObj = Record<string, any>;

let agentCrawlPromise: Promise<AnyObj> | null = null;

async function loadAgentCrawl(): Promise<AnyObj> {
    if (!agentCrawlPromise) {
        agentCrawlPromise = import('../src/AgentCrawl.js').then((mod) => mod.AgentCrawl as AnyObj);
    }
    return agentCrawlPromise;
}

function withPatchedStatics(
    target: AnyObj,
    patches: Array<{ key: string; value: any }>,
    run: () => Promise<void>
): Promise<void> {
    const originals = new Map<string, any>();

    for (const patch of patches) {
        originals.set(patch.key, target[patch.key]);
        target[patch.key] = patch.value;
    }

    return run().finally(() => {
        for (const [key, original] of originals.entries()) {
            target[key] = original;
        }
    });
}

function makePage(url: string, content = 'ok', links: string[] = []): ScrapedPage {
    return {
        url,
        content,
        title: 'title',
        links,
        metadata: { status: 200 },
    };
}

const noopCache = {
    get: () => null,
    set: () => {},
    clear: () => {},
};

test('cache key normalizes defaults and isolates stealth variants', async () => {
    const AgentCrawl = await loadAgentCrawl();

    let fetchCalls = 0;
    let markdownCalls = 0;

    await withPatchedStatics(
        AgentCrawl,
        [
            {
                key: 'fetcher',
                value: {
                    fetch: async () => {
                        fetchCalls++;
                        return {
                            url: 'https://example.com',
                            html: '<html><title>T</title><body>Hello</body></html>',
                            status: 200,
                            headers: {},
                            isStaticSuccess: true,
                            needsBrowser: false,
                        };
                    },
                },
            },
            {
                key: 'markdownifier',
                value: {
                    extractAll: () => {
                        markdownCalls++;
                        return { title: 'T', links: [], markdown: 'Hello' };
                    },
                },
            },
            {
                key: 'cache',
                value: {
                    store: new Map<string, ScrapedPage>(),
                    get(key: string) {
                        return this.store.get(key) || null;
                    },
                    set(key: string, value: ScrapedPage) {
                        this.store.set(key, value);
                    },
                    clear() {
                        this.store.clear();
                    },
                },
            },
        ],
        async () => {
            const url = 'https://example.com';
            const explicit = await AgentCrawl.scrape(url, { optimizeTokens: true });
            const implicit = await AgentCrawl.scrape(url, {});
            const stealthFirst = await AgentCrawl.scrape(url, { stealth: true });
            const stealthSecond = await AgentCrawl.scrape(url, { stealth: true, stealthLevel: 'balanced' });

            assert.equal(explicit.content, 'Hello');
            assert.equal(implicit.content, 'Hello');
            assert.equal(stealthFirst.content, 'Hello');
            assert.equal(stealthSecond.content, 'Hello');
            assert.equal(fetchCalls, 2);
            assert.equal(markdownCalls, 2);
        }
    );
});

test('hybrid mode surfaces non-2xx as error and does not browser-fallback', async () => {
    const AgentCrawl = await loadAgentCrawl();

    let browserCalls = 0;

    await withPatchedStatics(
        AgentCrawl,
        [
            {
                key: 'fetcher',
                value: {
                    fetch: async () => ({
                        url: 'https://example.com/not-found',
                        html: '',
                        status: 404,
                        headers: { 'content-type': 'text/html' },
                        isStaticSuccess: false,
                        needsBrowser: false,
                        error: 'HTTP 404',
                    }),
                },
            },
            {
                key: 'browserManager',
                value: {
                    getPage: async () => {
                        browserCalls++;
                        return { html: '<html></html>', status: 200, headers: {} };
                    },
                },
            },
            {
                key: 'cache',
                value: noopCache,
            },
        ],
        async () => {
            const page = await AgentCrawl.scrape('https://example.com/not-found', { mode: 'hybrid' });

            assert.equal(browserCalls, 0);
            assert.equal(page.content, '');
            assert.equal(page.metadata?.status, 404);
            assert.match(String(page.metadata?.error), /HTTP 404/);
        }
    );
});

test('hybrid mode falls back to browser for dynamic pages', async () => {
    const AgentCrawl = await loadAgentCrawl();
    let browserCalls = 0;
    let receivedStealthOptions: any = null;

    await withPatchedStatics(
        AgentCrawl,
        [
            {
                key: 'fetcher',
                value: {
                    fetch: async () => ({
                        url: 'https://example.com/app',
                        html: '',
                        status: 200,
                        headers: { 'content-type': 'text/html' },
                        isStaticSuccess: false,
                        needsBrowser: true,
                        error: 'Detected client-side rendered content',
                    }),
                },
            },
            {
                key: 'browserManager',
                value: {
                    getPage: async (_url: string, _waitFor?: string, options?: any) => {
                        browserCalls++;
                        receivedStealthOptions = options;
                        return {
                            html: '<html><title>App</title><body>Rendered</body></html>',
                            status: 200,
                            headers: { 'x-source': 'browser' },
                        };
                    },
                },
            },
            {
                key: 'markdownifier',
                value: {
                    extractAll: () => ({
                        title: 'App',
                        links: [],
                        markdown: 'Rendered',
                    }),
                },
            },
            {
                key: 'cache',
                value: noopCache,
            },
        ],
        async () => {
            const page = await AgentCrawl.scrape('https://example.com/app', { mode: 'hybrid', stealth: true, stealthLevel: 'basic' });
            assert.equal(browserCalls, 1);
            assert.deepEqual(receivedStealthOptions, { stealth: true, stealthLevel: 'basic' });
            assert.equal(page.content, 'Rendered');
            assert.equal(page.metadata?.status, 200);
            assert.equal(page.metadata?.['x-source'], 'browser');
            assert.equal(page.metadata?.stealthApplied, true);
            assert.equal(page.metadata?.stealthLevel, 'basic');
        }
    );
});

test('browser mode surfaces non-2xx browser response as error', async () => {
    const AgentCrawl = await loadAgentCrawl();
    let receivedStealthOptions: any = null;

    await withPatchedStatics(
        AgentCrawl,
        [
            {
                key: 'browserManager',
                value: {
                    getPage: async (_url: string, _waitFor?: string, options?: any) => {
                        receivedStealthOptions = options;
                        return {
                            html: '<html><body>Service unavailable</body></html>',
                            status: 503,
                            headers: { 'retry-after': '120' },
                        };
                    },
                },
            },
            {
                key: 'cache',
                value: noopCache,
            },
        ],
        async () => {
            const page = await AgentCrawl.scrape('https://example.com/down', { mode: 'browser', stealth: true });
            assert.equal(page.content, '');
            assert.equal(page.metadata?.status, 503);
            assert.equal(page.metadata?.['retry-after'], '120');
            assert.match(String(page.metadata?.error), /HTTP 503/);
            assert.deepEqual(receivedStealthOptions, { stealth: true, stealthLevel: 'balanced' });
        }
    );
});

test('static mode reports dynamic-content requirement without browser fallback', async () => {
    const AgentCrawl = await loadAgentCrawl();
    let browserCalls = 0;

    await withPatchedStatics(
        AgentCrawl,
        [
            {
                key: 'fetcher',
                value: {
                    fetch: async () => ({
                        url: 'https://example.com/app',
                        html: '',
                        status: 200,
                        headers: { 'content-type': 'text/html' },
                        isStaticSuccess: false,
                        needsBrowser: true,
                        error: 'Detected client-side rendered content',
                    }),
                },
            },
            {
                key: 'browserManager',
                value: {
                    getPage: async () => {
                        browserCalls++;
                        return {
                            html: '<html><body>Rendered</body></html>',
                            status: 200,
                            headers: {},
                        };
                    },
                },
            },
            {
                key: 'cache',
                value: noopCache,
            },
        ],
        async () => {
            const page = await AgentCrawl.scrape('https://example.com/app', { mode: 'static' });
            assert.equal(browserCalls, 0);
            assert.equal(page.content, '');
            assert.equal(page.metadata?.status, 200);
            assert.match(String(page.metadata?.error), /dynamic content/i);
        }
    );
});

test('crawl dedupes pages that resolve to the same final URL (redirect-like)', async () => {
    const AgentCrawl = await loadAgentCrawl();

    let scrapeCalls: string[] = [];

    await withPatchedStatics(
        AgentCrawl,
        [
            {
                key: 'scrape',
                value: async (url: string) => {
                    scrapeCalls.push(url);
                    // Simulate start URL resolving to /news.
                    if (url === 'https://news.ycombinator.com/') {
                        return makePage(
                            'https://news.ycombinator.com/news',
                            'front',
                            ['https://news.ycombinator.com/news']
                        );
                    }
                    return makePage(url, 'ok', []);
                },
            },
            { key: 'cache', value: noopCache },
        ],
        async () => {
            const result = await AgentCrawl.crawl('https://news.ycombinator.com/', {
                maxDepth: 1,
                maxPages: 10,
                concurrency: 2,
            });

            assert.equal(result.totalPages, 1);
            assert.equal(scrapeCalls.length, 1);
            assert.equal(result.pages[0]?.url, 'https://news.ycombinator.com/news');
        }
    );
});

test('crawl deduplicates queued links before visiting', async () => {
    const AgentCrawl = await loadAgentCrawl();

    const originalScrape = AgentCrawl.scrape.bind(AgentCrawl);
    const seen: string[] = [];
    const scrapeConfigs: any[] = [];

    AgentCrawl.scrape = async (url: string, config?: any) => {
        seen.push(url);
        scrapeConfigs.push(config);

        if (url === 'https://docs.example.com/') {
            return makePage(url, 'root', [
                'https://docs.example.com/a',
                'https://docs.example.com/a',
                'https://docs.example.com/b',
                'https://docs.example.com/b',
            ]);
        }
        if (url === 'https://docs.example.com/a') {
            return makePage(url, 'a', ['https://docs.example.com/b']);
        }
        return makePage(url, 'b', []);
    };

    try {
        const result = await AgentCrawl.crawl('https://docs.example.com/', {
            maxDepth: 2,
            maxPages: 10,
            concurrency: 3,
            stealth: true,
            stealthLevel: 'basic',
        });

        assert.equal(result.totalPages, 3);
        assert.deepEqual(seen, [
            'https://docs.example.com/',
            'https://docs.example.com/a',
            'https://docs.example.com/b',
        ]);
        assert.equal(scrapeConfigs[0]?.stealth, true);
        assert.equal(scrapeConfigs[0]?.stealthLevel, 'basic');
    } finally {
        AgentCrawl.scrape = originalScrape;
    }
});
