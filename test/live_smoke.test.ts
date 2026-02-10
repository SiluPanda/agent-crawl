import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentCrawl } from '../src/AgentCrawl.js';

const live = process.env.LIVE === '1';

async function hasNetwork(): Promise<boolean> {
    try {
        const controller = new AbortController();
        const id = setTimeout(() => controller.abort(), 2000);
        const res = await fetch('https://example.com', { signal: controller.signal });
        clearTimeout(id);
        return res.ok;
    } catch {
        return false;
    }
}

test('LIVE smoke: scrape example.com returns content', { skip: !live }, async (t) => {
    if (!(await hasNetwork())) {
        t.skip('no network access in this environment');
        return;
    }
    const page = await AgentCrawl.scrape('https://example.com', { mode: 'static' });
    assert.equal(page.metadata?.status, 200);
    assert.match(page.content, /Example Domain/i);
});

test('LIVE smoke: httpCache does not error', { skip: !live }, async (t) => {
    if (!(await hasNetwork())) {
        t.skip('no network access in this environment');
        return;
    }
    const cfg = { mode: 'static' as const, httpCache: { enabled: true, dir: '.cache/agent-crawl/http', ttlMs: 60_000, maxEntries: 1000 } };
    const first = await AgentCrawl.scrape('https://example.com', cfg as any);
    const second = await AgentCrawl.scrape('https://example.com', cfg as any);
    assert.match(first.content, /Example Domain/i);
    assert.match(second.content, /Example Domain/i);
});
