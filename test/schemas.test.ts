import test from 'node:test';
import assert from 'node:assert/strict';
import { ScrapeOptionsSchema, CrawlOptionsSchema } from '../src/schemas.js';

test('scrape schema applies defaults', () => {
    const parsed = ScrapeOptionsSchema.parse({
        url: 'https://example.com',
    });

    assert.equal(parsed.mode, 'hybrid');
    assert.equal(parsed.extractMainContent, false);
    assert.equal(parsed.optimizeTokens, true);
    assert.equal(parsed.stealth, false);
    assert.equal(parsed.stealthLevel, 'balanced');
    assert.equal(parsed.waitFor, undefined);
});

test('scrape schema validates url and mode', () => {
    assert.throws(
        () =>
            ScrapeOptionsSchema.parse({
                url: 'not-a-url',
                mode: 'hybrid',
            }),
        /Invalid url/i
    );

    assert.throws(
        () =>
            ScrapeOptionsSchema.parse({
                url: 'https://example.com',
                mode: 'invalid',
            }),
        /Invalid option/i
    );

    assert.throws(
        () =>
            ScrapeOptionsSchema.parse({
                url: 'https://example.com',
                stealthLevel: 'max',
            }),
        /Invalid option/i
    );
});

test('crawl schema applies numeric defaults', () => {
    const parsed = CrawlOptionsSchema.parse({
        url: 'https://example.com',
    });

    assert.equal(parsed.maxDepth, 1);
    assert.equal(parsed.maxPages, 10);
    assert.equal(parsed.concurrency, 2);
});

test('crawl schema rejects invalid numeric bounds', () => {
    // maxDepth: 0 is valid (crawl only the start URL)
    assert.doesNotThrow(() =>
        CrawlOptionsSchema.parse({ url: 'https://example.com', maxDepth: 0 })
    );

    // maxDepth: -1 is invalid
    assert.throws(
        () => CrawlOptionsSchema.parse({ url: 'https://example.com', maxDepth: -1 }),
    );

    // concurrency: 0 is invalid (min is 1)
    assert.throws(
        () => CrawlOptionsSchema.parse({ url: 'https://example.com', concurrency: 0 }),
    );

    // Values above upper bounds are rejected
    assert.throws(
        () => CrawlOptionsSchema.parse({ url: 'https://example.com', maxDepth: 101 }),
    );
    assert.throws(
        () => CrawlOptionsSchema.parse({ url: 'https://example.com', concurrency: 51 }),
    );
    assert.throws(
        () => CrawlOptionsSchema.parse({ url: 'https://example.com', maxPages: 100_001 }),
    );
});
