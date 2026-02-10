import test from 'node:test';
import assert from 'node:assert/strict';
import { SmartFetcher } from '../src/core/SmartFetcher.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const originalFetch = globalThis.fetch;

test.afterEach(async () => {
    globalThis.fetch = originalFetch;
});

test('httpCache uses If-None-Match and serves body on 304', async () => {
    const tmpDir = path.join('/tmp', `agent-crawl-httpcache-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    await fs.mkdir(tmpDir, { recursive: true });

    const url = 'https://example.com/';
    let call = 0;
    let sawIfNoneMatch = false;

    const makeMockResponse = (status: number, body: string, headers: Record<string, string>) => {
        const h = new Headers(headers);
        return {
            status,
            ok: status >= 200 && status < 300,
            url,
            headers: h,
            text: async () => body,
            body: null,
        } as any;
    };

    globalThis.fetch = (async (_input: any, init?: any) => {
        call++;
        const inm = init?.headers?.['If-None-Match'] ?? init?.headers?.get?.('If-None-Match');
        if (inm) sawIfNoneMatch = true;

        if (call === 1) {
            return makeMockResponse(200, '<html><body>Hello</body></html>', { 'content-type': 'text/html', etag: '"abc"' });
        }
        return makeMockResponse(304, '', { etag: '"abc"' });
    }) as typeof fetch;

    const fetcher = new SmartFetcher();

    const first = await fetcher.fetch(url, { retries: 0, httpCache: { dir: tmpDir, ttlMs: 60_000, maxEntries: 100 } });
    assert.equal(first.status, 200);
    assert.match(first.html, /Hello/);

    const second = await fetcher.fetch(url, { retries: 0, httpCache: { dir: tmpDir, ttlMs: 60_000, maxEntries: 100 } });
    assert.equal(second.status, 200);
    assert.match(second.html, /Hello/);
    assert.equal(sawIfNoneMatch, true);
});
