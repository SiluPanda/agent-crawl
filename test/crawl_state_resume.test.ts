import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentCrawl } from '../src/AgentCrawl.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';

test('crawlState persists and resumes frontier', async () => {
    const tmpDir = path.join('/tmp', `agent-crawl-state-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    await fs.mkdir(tmpDir, { recursive: true });

    const AgentAny = AgentCrawl as any;
    const originalScrape = AgentAny.scrape.bind(AgentAny);

    const calls: string[] = [];
    AgentAny.scrape = async (url: string) => {
        calls.push(url);
        if (url.endsWith('/')) {
            return { url, content: 'root', title: 'root', links: [`${url}a`, `${url}b`], metadata: { status: 200 } };
        }
        if (url.endsWith('/a')) {
            return { url, content: 'a', title: 'a', links: [], metadata: { status: 200 } };
        }
        if (url.endsWith('/b')) {
            return { url, content: 'b', title: 'b', links: [], metadata: { status: 200 } };
        }
        return { url, content: 'x', title: 'x', links: [], metadata: { status: 200 } };
    };

    try {
        const startUrl = 'https://state.example/';
        const id = 'resume-test';

        const first = await AgentCrawl.crawl(startUrl, {
            maxDepth: 1,
            maxPages: 1, // stop early
            concurrency: 2,
            crawlState: { enabled: true, dir: tmpDir, id, resume: true, flushEvery: 1, persistPages: true },
        } as any);

        assert.equal(first.totalPages, 1);

        // Resume with higher maxPages; should continue without re-scraping the root page.
        const beforeCalls = calls.length;
        const second = await AgentCrawl.crawl(startUrl, {
            maxDepth: 1,
            maxPages: 3,
            concurrency: 2,
            crawlState: { enabled: true, dir: tmpDir, id, resume: true, flushEvery: 1, persistPages: true },
        } as any);

        assert.equal(second.totalPages, 3);
        assert.ok(calls.length > beforeCalls);
        // Root should not be re-added if it was already persisted in pages/visited.
        const rootCalls = calls.filter((u) => u === startUrl).length;
        assert.equal(rootCalls, 1);
    } finally {
        AgentAny.scrape = originalScrape;
    }
});

