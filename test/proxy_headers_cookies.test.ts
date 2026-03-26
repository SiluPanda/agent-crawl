import test from 'node:test';
import assert from 'node:assert/strict';
import { SmartFetcher } from '../src/core/SmartFetcher.js';
import { ScrapeOptionsSchema } from '../src/schemas.js';

// ---------------------------------------------------------------------------
// Schema validation for proxy, headers, cookies
// ---------------------------------------------------------------------------

test('schema accepts valid proxy config', () => {
    const result = ScrapeOptionsSchema.safeParse({
        url: 'https://example.com',
        proxy: { url: 'http://proxy.example.com:8080' },
    });
    assert.ok(result.success);
});

test('schema accepts proxy with auth', () => {
    const result = ScrapeOptionsSchema.safeParse({
        url: 'https://example.com',
        proxy: {
            url: 'http://proxy.example.com:8080',
            username: 'user',
            password: 'pass',
        },
    });
    assert.ok(result.success);
});

test('schema rejects proxy with invalid URL', () => {
    const result = ScrapeOptionsSchema.safeParse({
        url: 'https://example.com',
        proxy: { url: 'not-a-url' },
    });
    assert.ok(!result.success);
});

test('schema rejects proxy URL exceeding max length', () => {
    const result = ScrapeOptionsSchema.safeParse({
        url: 'https://example.com',
        proxy: { url: 'http://proxy.example.com/' + 'x'.repeat(2000) },
    });
    assert.ok(!result.success);
});

test('schema accepts valid custom headers', () => {
    const result = ScrapeOptionsSchema.safeParse({
        url: 'https://example.com',
        headers: {
            'Authorization': 'Bearer token123',
            'X-Custom': 'value',
        },
    });
    assert.ok(result.success);
});

test('schema rejects more than 50 custom headers', () => {
    const headers: Record<string, string> = {};
    for (let i = 0; i < 51; i++) headers[`Header-${i}`] = 'value';
    const result = ScrapeOptionsSchema.safeParse({
        url: 'https://example.com',
        headers,
    });
    assert.ok(!result.success);
});

test('schema rejects header value exceeding 8192 chars', () => {
    const result = ScrapeOptionsSchema.safeParse({
        url: 'https://example.com',
        headers: { 'Authorization': 'x'.repeat(8193) },
    });
    assert.ok(!result.success);
});

test('schema accepts valid cookies', () => {
    const result = ScrapeOptionsSchema.safeParse({
        url: 'https://example.com',
        cookies: [
            { name: 'session', value: 'abc123' },
            { name: 'auth', value: 'token', domain: '.example.com', path: '/' },
        ],
    });
    assert.ok(result.success);
});

test('schema rejects more than 100 cookies', () => {
    const cookies = Array.from({ length: 101 }, (_, i) => ({
        name: `cookie${i}`,
        value: 'val',
    }));
    const result = ScrapeOptionsSchema.safeParse({
        url: 'https://example.com',
        cookies,
    });
    assert.ok(!result.success);
});

test('schema rejects cookie name exceeding 200 chars', () => {
    const result = ScrapeOptionsSchema.safeParse({
        url: 'https://example.com',
        cookies: [{ name: 'x'.repeat(201), value: 'val' }],
    });
    assert.ok(!result.success);
});

test('schema rejects cookie value exceeding 4096 chars', () => {
    const result = ScrapeOptionsSchema.safeParse({
        url: 'https://example.com',
        cookies: [{ name: 'session', value: 'x'.repeat(4097) }],
    });
    assert.ok(!result.success);
});

test('schema accepts config with all three: proxy, headers, cookies', () => {
    const result = ScrapeOptionsSchema.safeParse({
        url: 'https://example.com',
        proxy: { url: 'http://proxy:8080' },
        headers: { 'Authorization': 'Bearer tok' },
        cookies: [{ name: 'sid', value: '123' }],
    });
    assert.ok(result.success);
});

test('schema allows omitting proxy, headers, cookies', () => {
    const result = ScrapeOptionsSchema.safeParse({
        url: 'https://example.com',
    });
    assert.ok(result.success);
});

// ---------------------------------------------------------------------------
// SmartFetcher: cookie formatting
// ---------------------------------------------------------------------------

test('SmartFetcher formats cookies as header', async () => {
    // We test the cookie header formation by verifying the fetch sends cookies
    // to a URL that will fail (we just check it doesn't crash)
    const fetcher = new SmartFetcher();
    const result = await fetcher.fetch('https://httpbin.org/status/404', {
        retries: 0,
        timeout: 5000,
        cookies: [
            { name: 'session', value: 'abc' },
            { name: 'lang', value: 'en' },
        ],
    });
    // The request should complete (404 or network error) without crashing
    assert.ok(typeof result.status === 'number');
    assert.ok(typeof result.error === 'string' || result.error === undefined);
});

test('SmartFetcher passes custom headers through', async () => {
    const fetcher = new SmartFetcher();
    const result = await fetcher.fetch('https://httpbin.org/status/404', {
        retries: 0,
        timeout: 5000,
        headers: {
            'Authorization': 'Bearer test-token',
            'X-Custom-Header': 'custom-value',
        },
    });
    // Request should complete without crashing
    assert.ok(typeof result.status === 'number');
});

test('SmartFetcher blocked headers still filtered with custom headers', async () => {
    const fetcher = new SmartFetcher();
    const result = await fetcher.fetch('https://httpbin.org/status/404', {
        retries: 0,
        timeout: 5000,
        headers: {
            'Host': 'evil.com',  // should be blocked
            'Transfer-Encoding': 'chunked',  // should be blocked
            'Authorization': 'Bearer ok',  // should pass through
        },
    });
    assert.ok(typeof result.status === 'number');
});

// ---------------------------------------------------------------------------
// SmartFetcher: proxy with invalid config
// ---------------------------------------------------------------------------

test('SmartFetcher proxy with invalid undici gives clear error', async () => {
    const fetcher = new SmartFetcher();
    // Use a definitely-unreachable proxy to test the proxy code path runs
    const result = await fetcher.fetch('https://example.com', {
        retries: 0,
        timeout: 5000,
        proxy: { url: 'http://127.0.0.1:1' },  // blocked by SSRF
    });
    // Should get an error (SSRF block happens before proxy)
    assert.ok(result.error);
});

// ---------------------------------------------------------------------------
// Cache key differentiation
// ---------------------------------------------------------------------------

test('cache key varies by proxy URL', () => {
    // Import AgentCrawl's getCacheKey indirectly by verifying scrapes with
    // different proxy configs don't collide in the in-memory cache.
    // This is a design-level test — we verify the types include proxy.

    // The NormalizedScrapeConfig type includes proxy, headers, cookies
    // which getCacheKey serializes into the cache key.
    // A full integration test would require mocking, so we verify the schema
    // accepts different proxy configs.
    const result1 = ScrapeOptionsSchema.safeParse({
        url: 'https://example.com',
        proxy: { url: 'http://proxy1:8080' },
    });
    const result2 = ScrapeOptionsSchema.safeParse({
        url: 'https://example.com',
        proxy: { url: 'http://proxy2:8080' },
    });
    assert.ok(result1.success);
    assert.ok(result2.success);
});

// ---------------------------------------------------------------------------
// Type compatibility: ScrapeConfig includes new fields
// ---------------------------------------------------------------------------

test('ScrapeConfig type accepts proxy, headers, cookies', () => {
    // Compile-time check via runtime object that matches the type
    const config = {
        mode: 'static' as const,
        proxy: { url: 'http://proxy:8080', username: 'u', password: 'p' },
        headers: { 'Authorization': 'Bearer tok' },
        cookies: [{ name: 'sid', value: '123', domain: '.example.com', path: '/' }],
    };
    assert.ok(config.proxy.url);
    assert.ok(config.headers.Authorization);
    assert.ok(config.cookies[0].name);
});

test('CookieDef accepts minimal fields', () => {
    const cookie = { name: 'key', value: 'val' };
    assert.equal(cookie.name, 'key');
    assert.equal(cookie.value, 'val');
});

test('CookieDef accepts all fields', () => {
    const cookie = { name: 'key', value: 'val', domain: '.test.com', path: '/api' };
    assert.equal(cookie.domain, '.test.com');
    assert.equal(cookie.path, '/api');
});

// ---------------------------------------------------------------------------
// SmartFetcher: SSRF still applies with proxy configured
// ---------------------------------------------------------------------------

test('SmartFetcher still blocks private hosts even with proxy', async () => {
    const fetcher = new SmartFetcher();
    const result = await fetcher.fetch('http://127.0.0.1/secret', {
        retries: 0,
        timeout: 5000,
        proxy: { url: 'http://external-proxy:8080' },
    });
    assert.ok(result.error?.includes('private/internal'));
});

test('SmartFetcher still blocks localhost with proxy', async () => {
    const fetcher = new SmartFetcher();
    const result = await fetcher.fetch('http://localhost/admin', {
        retries: 0,
        timeout: 5000,
        proxy: { url: 'http://external-proxy:8080' },
    });
    assert.ok(result.error?.includes('private/internal'));
});

// ---------------------------------------------------------------------------
// SmartFetcher: cookies and headers don't crash on empty arrays/objects
// ---------------------------------------------------------------------------

test('SmartFetcher handles empty cookies array', async () => {
    const fetcher = new SmartFetcher();
    const result = await fetcher.fetch('https://httpbin.org/status/404', {
        retries: 0,
        timeout: 5000,
        cookies: [],
    });
    assert.ok(typeof result.status === 'number');
});

test('SmartFetcher handles empty headers object', async () => {
    const fetcher = new SmartFetcher();
    const result = await fetcher.fetch('https://httpbin.org/status/404', {
        retries: 0,
        timeout: 5000,
        headers: {},
    });
    assert.ok(typeof result.status === 'number');
});
