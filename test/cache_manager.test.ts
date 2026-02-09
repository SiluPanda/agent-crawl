import test from 'node:test';
import assert from 'node:assert/strict';
import { CacheManager } from '../src/core/CacheManager.js';
import type { ScrapedPage } from '../src/types.js';

function page(url: string, content: string): ScrapedPage {
    return { url, content, metadata: { status: 200 } };
}

const realDateNow = Date.now;

test.afterEach(() => {
    Date.now = realDateNow;
});

test('returns cached value for valid entry', () => {
    const cache = new CacheManager(1000, 10);
    cache.set('a', page('https://example.com/a', 'alpha'));

    const got = cache.get('a');
    assert.ok(got);
    assert.equal(got.content, 'alpha');
});

test('expires entries after ttl', () => {
    let now = 1_000;
    Date.now = () => now;

    const cache = new CacheManager(100, 10);
    cache.set('a', page('https://example.com/a', 'alpha'));

    now += 101;
    const got = cache.get('a');
    assert.equal(got, null);
});

test('evicts least recently used entry when max size reached', () => {
    const cache = new CacheManager(10_000, 2);
    cache.set('a', page('https://example.com/a', 'alpha'));
    cache.set('b', page('https://example.com/b', 'beta'));

    // Touch "a" so "b" becomes least-recently-used.
    assert.ok(cache.get('a'));
    cache.set('c', page('https://example.com/c', 'gamma'));

    assert.equal(cache.get('b'), null);
    assert.ok(cache.get('a'));
    assert.ok(cache.get('c'));
});

test('clear removes all entries', () => {
    const cache = new CacheManager(1000, 10);
    cache.set('a', page('https://example.com/a', 'alpha'));
    cache.set('b', page('https://example.com/b', 'beta'));

    cache.clear();

    assert.equal(cache.get('a'), null);
    assert.equal(cache.get('b'), null);
});
