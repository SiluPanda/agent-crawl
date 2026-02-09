import test from 'node:test';
import assert from 'node:assert/strict';
import { SmartFetcher } from '../src/core/SmartFetcher.js';

const originalFetch = globalThis.fetch;

test.after(() => {
    globalThis.fetch = originalFetch;
});

test('returns strict error metadata for non-2xx responses', async () => {
    globalThis.fetch = (async () => {
        return new Response('Not Found', {
            status: 404,
            headers: { 'content-type': 'text/html' },
        });
    }) as typeof fetch;

    const fetcher = new SmartFetcher();
    const result = await fetcher.fetch('https://example.com/missing', { retries: 0 });

    assert.equal(result.status, 404);
    assert.equal(result.isStaticSuccess, false);
    assert.equal(result.needsBrowser, false);
    assert.equal(result.error, 'HTTP 404');
});

test('marks likely CSR pages for browser fallback', async () => {
    const csrHtml = '<html><body><div id="root"></div><script>boot()</script></body></html>';
    globalThis.fetch = (async () => {
        return new Response(csrHtml, {
            status: 200,
            headers: { 'content-type': 'text/html' },
        });
    }) as typeof fetch;

    const fetcher = new SmartFetcher();
    const result = await fetcher.fetch('https://example.com/app', { retries: 0 });

    assert.equal(result.status, 200);
    assert.equal(result.isStaticSuccess, false);
    assert.equal(result.needsBrowser, true);
    assert.match(String(result.error), /client-side rendered/i);
});

test('keeps static HTML on successful pages', async () => {
    const html = '<html><body><article><p>Hello world</p></article></body></html>';
    globalThis.fetch = (async () => {
        return new Response(html, {
            status: 200,
            headers: { 'content-type': 'text/html' },
        });
    }) as typeof fetch;

    const fetcher = new SmartFetcher();
    const result = await fetcher.fetch('https://example.com/', { retries: 0 });

    assert.equal(result.isStaticSuccess, true);
    assert.equal(result.needsBrowser, false);
    assert.equal(result.html.includes('Hello world'), true);
    assert.equal(result.error, undefined);
});

test('retries retryable server errors then succeeds', async () => {
    const fetcher = new SmartFetcher();
    let calls = 0;

    (fetcher as any).wait = async () => {};
    globalThis.fetch = (async () => {
        calls++;
        if (calls < 3) {
            return new Response('retry', { status: 500, headers: { 'content-type': 'text/html' } });
        }
        return new Response('<html><body>ok</body></html>', {
            status: 200,
            headers: { 'content-type': 'text/html' },
        });
    }) as typeof fetch;

    const result = await fetcher.fetch('https://example.com/retry', { retries: 2 });
    assert.equal(calls, 3);
    assert.equal(result.status, 200);
    assert.equal(result.isStaticSuccess, true);
});

test('returns final http error after exhausting retries', async () => {
    const fetcher = new SmartFetcher();
    let calls = 0;

    (fetcher as any).wait = async () => {};
    globalThis.fetch = (async () => {
        calls++;
        return new Response('unavailable', {
            status: 503,
            headers: { 'content-type': 'text/html' },
        });
    }) as typeof fetch;

    const result = await fetcher.fetch('https://example.com/down', { retries: 2 });
    assert.equal(calls, 3);
    assert.equal(result.status, 503);
    assert.equal(result.error, 'HTTP 503');
    assert.equal(result.needsBrowser, false);
});

test('times out and returns timeout error when fetch aborts', async () => {
    globalThis.fetch = ((_: RequestInfo | URL, init?: RequestInit) => {
        return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
                reject(new DOMException('The operation was aborted.', 'AbortError'));
            });
        });
    }) as typeof fetch;

    const fetcher = new SmartFetcher();
    const result = await fetcher.fetch('https://example.com/slow', {
        retries: 0,
        timeout: 10,
    });

    assert.equal(result.status, 0);
    assert.equal(result.error, 'Request timed out');
});

test('flags json content-type as browser-needed', async () => {
    globalThis.fetch = (async () => {
        return new Response('{"ok":true}', {
            status: 200,
            headers: { 'content-type': 'application/json' },
        });
    }) as typeof fetch;

    const fetcher = new SmartFetcher();
    const result = await fetcher.fetch('https://example.com/api', { retries: 0 });

    assert.equal(result.isStaticSuccess, false);
    assert.equal(result.needsBrowser, true);
    assert.match(String(result.error), /client-side rendered/i);
});
