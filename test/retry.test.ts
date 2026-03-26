import test from 'node:test';
import assert from 'node:assert/strict';
import { SmartFetcher } from '../src/core/SmartFetcher.js';
import { ScrapeOptionsSchema } from '../src/schemas.js';

const originalFetch = globalThis.fetch;

test.afterEach(() => {
    globalThis.fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// Schema validation for RetryConfig
// ---------------------------------------------------------------------------

test('schema accepts retry config', () => {
    const result = ScrapeOptionsSchema.safeParse({
        url: 'https://example.com',
        retry: { maxRetries: 3, baseDelayMs: 500, maxDelayMs: 10000 },
    });
    assert.ok(result.success);
});

test('schema accepts retry with retryOn codes', () => {
    const result = ScrapeOptionsSchema.safeParse({
        url: 'https://example.com',
        retry: { retryOn: [429, 503], respectRetryAfter: true },
    });
    assert.ok(result.success);
});

test('schema rejects maxRetries > 10', () => {
    const result = ScrapeOptionsSchema.safeParse({
        url: 'https://example.com',
        retry: { maxRetries: 11 },
    });
    assert.ok(!result.success);
});

test('schema rejects baseDelayMs < 100', () => {
    const result = ScrapeOptionsSchema.safeParse({
        url: 'https://example.com',
        retry: { baseDelayMs: 50 },
    });
    assert.ok(!result.success);
});

test('schema rejects more than 20 retryOn codes', () => {
    const codes = Array.from({ length: 21 }, (_, i) => 400 + i);
    const result = ScrapeOptionsSchema.safeParse({
        url: 'https://example.com',
        retry: { retryOn: codes },
    });
    assert.ok(!result.success);
});

test('schema allows omitting retry', () => {
    const result = ScrapeOptionsSchema.safeParse({ url: 'https://example.com' });
    assert.ok(result.success);
});

// ---------------------------------------------------------------------------
// Exponential backoff behavior
// ---------------------------------------------------------------------------

test('retries 429 with exponential backoff', async () => {
    let attempts = 0;
    const timestamps: number[] = [];

    globalThis.fetch = (async () => {
        attempts++;
        timestamps.push(Date.now());
        if (attempts <= 2) {
            return new Response('rate limited', { status: 429, headers: {} });
        }
        return new Response('<html><body>OK</body></html>', {
            status: 200,
            headers: { 'content-type': 'text/html' },
        });
    }) as typeof fetch;

    const fetcher = new SmartFetcher();
    const result = await fetcher.fetch('https://example.com/test', {
        retry: { maxRetries: 3, baseDelayMs: 200, maxDelayMs: 5000 },
    });

    assert.equal(result.status, 200);
    assert.equal(attempts, 3);
    // Second attempt should wait ~200ms (base), third ~400ms+ (2^1 * 200)
    if (timestamps.length >= 3) {
        const delay1 = timestamps[1] - timestamps[0];
        const delay2 = timestamps[2] - timestamps[1];
        assert.ok(delay1 >= 150, `First delay was ${delay1}ms, expected >= 150ms`);
        assert.ok(delay2 >= 300, `Second delay was ${delay2}ms, expected >= 300ms (exponential)`);
    }
});

test('retries 503 and respects Retry-After header (seconds)', async () => {
    let attempts = 0;

    globalThis.fetch = (async () => {
        attempts++;
        if (attempts === 1) {
            return new Response('unavailable', {
                status: 503,
                headers: { 'retry-after': '1' }, // wait 1 second
            });
        }
        return new Response('<html><body>OK</body></html>', {
            status: 200,
            headers: { 'content-type': 'text/html' },
        });
    }) as typeof fetch;

    const fetcher = new SmartFetcher();
    const start = Date.now();
    const result = await fetcher.fetch('https://example.com/retry-after', {
        retry: { maxRetries: 2, baseDelayMs: 100, respectRetryAfter: true },
    });

    assert.equal(result.status, 200);
    assert.equal(attempts, 2);
    const elapsed = Date.now() - start;
    assert.ok(elapsed >= 900, `Should have waited ~1s for Retry-After, got ${elapsed}ms`);
});

test('does not retry when retryOn excludes the status code', async () => {
    let attempts = 0;

    globalThis.fetch = (async () => {
        attempts++;
        return new Response('error', { status: 500 });
    }) as typeof fetch;

    const fetcher = new SmartFetcher();
    const result = await fetcher.fetch('https://example.com/no-retry', {
        retry: { maxRetries: 3, retryOn: [429] }, // only retry 429, not 500
    });

    assert.equal(attempts, 1, 'Should not retry 500 when retryOn is [429]');
    assert.equal(result.status, 500);
});

test('retries custom status codes', async () => {
    let attempts = 0;

    globalThis.fetch = (async () => {
        attempts++;
        if (attempts <= 2) {
            return new Response('conflict', { status: 409 });
        }
        return new Response('<html><body>OK</body></html>', {
            status: 200,
            headers: { 'content-type': 'text/html' },
        });
    }) as typeof fetch;

    const fetcher = new SmartFetcher();
    const result = await fetcher.fetch('https://example.com/custom', {
        retry: { maxRetries: 3, retryOn: [409], baseDelayMs: 100 },
    });

    assert.equal(result.status, 200);
    assert.equal(attempts, 3);
});

test('maxRetries: 0 disables retries', async () => {
    let attempts = 0;

    globalThis.fetch = (async () => {
        attempts++;
        return new Response('error', { status: 429 });
    }) as typeof fetch;

    const fetcher = new SmartFetcher();
    const result = await fetcher.fetch('https://example.com/no-retries', {
        retry: { maxRetries: 0 },
    });

    assert.equal(attempts, 1);
    assert.equal(result.status, 429);
});

test('default retry behavior still works without retry config', async () => {
    let attempts = 0;

    globalThis.fetch = (async () => {
        attempts++;
        if (attempts <= 2) {
            return new Response('error', { status: 500 });
        }
        return new Response('<html><body>OK</body></html>', {
            status: 200,
            headers: { 'content-type': 'text/html' },
        });
    }) as typeof fetch;

    const fetcher = new SmartFetcher();
    const result = await fetcher.fetch('https://example.com/default', {
        // no retry config — should use defaults (2 retries)
    });

    assert.equal(result.status, 200);
    assert.equal(attempts, 3);
});

test('respects maxDelayMs cap', async () => {
    let attempts = 0;
    const timestamps: number[] = [];

    globalThis.fetch = (async () => {
        attempts++;
        timestamps.push(Date.now());
        if (attempts <= 3) {
            return new Response('error', { status: 500 });
        }
        return new Response('<html><body>OK</body></html>', {
            status: 200,
            headers: { 'content-type': 'text/html' },
        });
    }) as typeof fetch;

    const fetcher = new SmartFetcher();
    const result = await fetcher.fetch('https://example.com/cap', {
        retry: { maxRetries: 5, baseDelayMs: 200, maxDelayMs: 500 },
    });

    assert.equal(result.status, 200);
    // Delays should never exceed maxDelayMs (500ms) + jitter tolerance
    if (timestamps.length >= 4) {
        const delay3 = timestamps[3] - timestamps[2];
        assert.ok(delay3 <= 800, `Third delay ${delay3}ms should be capped near 500ms`);
    }
});

test('Retry-After header with date format', async () => {
    let attempts = 0;

    globalThis.fetch = (async () => {
        attempts++;
        if (attempts === 1) {
            // Set Retry-After to 2 seconds in the future
            const futureDate = new Date(Date.now() + 2000).toUTCString();
            return new Response('rate limited', {
                status: 429,
                headers: { 'retry-after': futureDate },
            });
        }
        return new Response('<html><body>OK</body></html>', {
            status: 200,
            headers: { 'content-type': 'text/html' },
        });
    }) as typeof fetch;

    const fetcher = new SmartFetcher();
    const start = Date.now();
    const result = await fetcher.fetch('https://example.com/date-retry', {
        retry: { maxRetries: 2, baseDelayMs: 100, respectRetryAfter: true },
    });

    assert.equal(result.status, 200);
    const elapsed = Date.now() - start;
    // Should wait at least 1s for Retry-After date (allowing margin for timing)
    assert.ok(elapsed >= 1000, `Should respect Retry-After date, got ${elapsed}ms`);
});

test('respectRetryAfter: false ignores Retry-After header', async () => {
    let attempts = 0;

    globalThis.fetch = (async () => {
        attempts++;
        if (attempts === 1) {
            return new Response('rate limited', {
                status: 429,
                headers: { 'retry-after': '10' }, // 10 seconds
            });
        }
        return new Response('<html><body>OK</body></html>', {
            status: 200,
            headers: { 'content-type': 'text/html' },
        });
    }) as typeof fetch;

    const fetcher = new SmartFetcher();
    const start = Date.now();
    const result = await fetcher.fetch('https://example.com/ignore-retry', {
        retry: { maxRetries: 2, baseDelayMs: 100, respectRetryAfter: false },
    });

    assert.equal(result.status, 200);
    const elapsed = Date.now() - start;
    // Should use exponential backoff (~100ms), not Retry-After (10s)
    assert.ok(elapsed < 3000, `Should ignore Retry-After, got ${elapsed}ms`);
});

// ---------------------------------------------------------------------------
// Network error retries with backoff
// ---------------------------------------------------------------------------

test('retries network errors with exponential backoff', async () => {
    let attempts = 0;

    globalThis.fetch = (async () => {
        attempts++;
        if (attempts <= 2) throw new Error('ECONNREFUSED');
        return new Response('<html><body>OK</body></html>', {
            status: 200,
            headers: { 'content-type': 'text/html' },
        });
    }) as typeof fetch;

    const fetcher = new SmartFetcher();
    const result = await fetcher.fetch('https://example.com/network-err', {
        retry: { maxRetries: 3, baseDelayMs: 100 },
    });

    assert.equal(result.status, 200);
    assert.equal(attempts, 3);
});
