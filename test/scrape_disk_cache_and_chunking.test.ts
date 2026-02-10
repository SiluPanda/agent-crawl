import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentCrawl } from '../src/AgentCrawl.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';

test('disk cache persists processed scrape results and chunking emits chunks', async () => {
    const tmpDir = path.join('/tmp', `agent-crawl-scrapecache-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    await fs.mkdir(tmpDir, { recursive: true });

    const AgentAny = AgentCrawl as any;
    const originalFetcher = AgentAny.fetcher;
    const originalMarkdownifier = AgentAny.markdownifier;
    const originalCache = AgentAny.cache;

    let fetchCalls = 0;
    AgentAny.fetcher = {
        fetch: async () => {
            fetchCalls++;
            return {
                url: 'https://example.com',
                finalUrl: 'https://example.com/',
                html: '<html><head><title>T</title></head><body><h1>H</h1><p>Hello world</p></body></html>',
                status: 200,
                headers: { 'content-type': 'text/html' },
                isStaticSuccess: true,
                needsBrowser: false,
            };
        },
    };

    AgentAny.markdownifier = originalMarkdownifier; // use real markdownifier
    AgentAny.cache = { get: () => null, set: () => {}, clear: () => {} }; // disable mem cache to force disk hit

    try {
        const cfg = {
            cache: { dir: tmpDir, ttlMs: 60_000, maxEntries: 100 },
            chunking: { enabled: true, maxTokens: 10_000, overlapTokens: 0 },
        };

        const first = await AgentCrawl.scrape('https://example.com', cfg as any);
        assert.equal(fetchCalls, 1);
        assert.ok(first.chunks && first.chunks.length >= 1);

        const second = await AgentCrawl.scrape('https://example.com', cfg as any);
        assert.equal(fetchCalls, 1); // disk cache served
        assert.equal(second.content, first.content);
    } finally {
        AgentAny.fetcher = originalFetcher;
        AgentAny.markdownifier = originalMarkdownifier;
        AgentAny.cache = originalCache;
    }
});

