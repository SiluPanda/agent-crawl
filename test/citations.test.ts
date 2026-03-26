import test from 'node:test';
import assert from 'node:assert/strict';
import { markdownToCitations } from '../src/core/Citations.js';
import { ScrapeOptionsSchema } from '../src/schemas.js';

// ---------------------------------------------------------------------------
// markdownToCitations unit tests
// ---------------------------------------------------------------------------

test('converts single inline link to footnote', () => {
    const input = 'Visit [Example](https://example.com) for more.';
    const output = markdownToCitations(input);
    assert.ok(output.includes('Visit Example[1] for more.'));
    assert.ok(output.includes('[1] https://example.com'));
});

test('converts multiple links with unique URLs', () => {
    const input = 'See [A](https://a.com) and [B](https://b.com) and [C](https://c.com).';
    const output = markdownToCitations(input);
    assert.ok(output.includes('A[1]'));
    assert.ok(output.includes('B[2]'));
    assert.ok(output.includes('C[3]'));
    assert.ok(output.includes('[1] https://a.com'));
    assert.ok(output.includes('[2] https://b.com'));
    assert.ok(output.includes('[3] https://c.com'));
});

test('deduplicates same URL', () => {
    const input = 'First [link](https://example.com) and second [link](https://example.com).';
    const output = markdownToCitations(input);
    assert.ok(output.includes('link[1]'));
    // Should only have one reference entry
    const refs = output.split('---\n')[1];
    assert.equal(refs.trim().split('\n').length, 1);
    assert.ok(refs.includes('[1] https://example.com'));
});

test('handles image links', () => {
    const input = 'Here is ![logo](https://example.com/logo.png) image.';
    const output = markdownToCitations(input);
    assert.ok(output.includes('[Image: logo][1]'));
    assert.ok(output.includes('[1] https://example.com/logo.png'));
});

test('preserves code blocks', () => {
    const input = '```\n[not a link](https://example.com)\n```\nOutside [link](https://real.com).';
    const output = markdownToCitations(input);
    // Code block should be preserved literally
    assert.ok(output.includes('[not a link](https://example.com)'));
    // Outside link should be converted
    assert.ok(output.includes('link[1]'));
    assert.ok(output.includes('[1] https://real.com'));
});

test('preserves inline code', () => {
    const input = 'Use `[text](url)` syntax. See [docs](https://docs.com).';
    const output = markdownToCitations(input);
    assert.ok(output.includes('`[text](url)`'));
    assert.ok(output.includes('docs[1]'));
});

test('skips fragment-only links', () => {
    const input = 'Jump to [section](#section) and visit [site](https://site.com).';
    const output = markdownToCitations(input);
    // Fragment link preserved as-is
    assert.ok(output.includes('[section](#section)'));
    // Real link converted
    assert.ok(output.includes('site[1]'));
});

test('handles empty text in links', () => {
    const input = 'Empty [](https://example.com) link.';
    const output = markdownToCitations(input);
    assert.ok(output.includes('[1]'));
    assert.ok(output.includes('[1] https://example.com'));
});

test('handles links with title attributes', () => {
    const input = 'Visit [Example](https://example.com "A website").';
    const output = markdownToCitations(input);
    assert.ok(output.includes('Example[1]'));
    assert.ok(output.includes('[1] https://example.com'));
});

test('no links produces no reference section', () => {
    const input = 'Plain text with no links at all.';
    const output = markdownToCitations(input);
    assert.equal(output, input);
    assert.ok(!output.includes('---'));
});

test('handles nested brackets in link text', () => {
    const input = 'See [item [1]](https://example.com).';
    const output = markdownToCitations(input);
    assert.ok(output.includes('[1] https://example.com'));
});

test('handles multiple links on same line', () => {
    const input = '[A](https://a.com) | [B](https://b.com) | [C](https://c.com)';
    const output = markdownToCitations(input);
    assert.ok(output.includes('A[1]'));
    assert.ok(output.includes('B[2]'));
    assert.ok(output.includes('C[3]'));
});

test('handles real-world markdown with mixed content', () => {
    const input = `# Example Page

This is a paragraph with [a link](https://example.com) and some **bold** text.

- Item 1 with [docs](https://docs.example.com)
- Item 2 with [same link](https://example.com)

\`\`\`js
const url = "[not a link](https://fake.com)";
\`\`\`

Visit [our blog](https://blog.example.com) for more.`;

    const output = markdownToCitations(input);
    assert.ok(output.includes('a link[1]'));
    assert.ok(output.includes('docs[2]'));
    assert.ok(output.includes('same link[1]')); // deduplicated with first link
    assert.ok(output.includes('our blog[3]'));
    assert.ok(output.includes('[1] https://example.com'));
    assert.ok(output.includes('[2] https://docs.example.com'));
    assert.ok(output.includes('[3] https://blog.example.com'));
    // Code block preserved
    assert.ok(output.includes('"[not a link](https://fake.com)"'));
});

// ---------------------------------------------------------------------------
// Schema validation
// ---------------------------------------------------------------------------

test('schema accepts citations: true', () => {
    const result = ScrapeOptionsSchema.safeParse({
        url: 'https://example.com',
        citations: true,
    });
    assert.ok(result.success);
});

test('schema accepts citations: false', () => {
    const result = ScrapeOptionsSchema.safeParse({
        url: 'https://example.com',
        citations: false,
    });
    assert.ok(result.success);
});

test('schema allows omitting citations', () => {
    const result = ScrapeOptionsSchema.safeParse({
        url: 'https://example.com',
    });
    assert.ok(result.success);
});

// ---------------------------------------------------------------------------
// AgentCrawl integration
// ---------------------------------------------------------------------------

test('AgentCrawl.scrape applies citations when enabled', async () => {
    const { AgentCrawl } = await import('../src/AgentCrawl.js');

    const origFetcher = (AgentCrawl as any).fetcher;
    const origMarkdown = (AgentCrawl as any).markdownifier;
    const origCache = (AgentCrawl as any).cache;

    try {
        (AgentCrawl as any).fetcher = {
            fetch: async () => ({
                url: 'https://example.com',
                html: '<html><body><a href="https://test.com">Test</a></body></html>',
                status: 200, headers: {}, isStaticSuccess: true, needsBrowser: false,
            }),
        };
        (AgentCrawl as any).markdownifier = {
            extractAll: () => ({
                title: 'T', links: [],
                markdown: 'Visit [Test](https://test.com) now.',
            }),
        };
        (AgentCrawl as any).cache = { get: () => null, set: () => {} };

        const page = await AgentCrawl.scrape('https://example.com', {
            mode: 'static',
            citations: true,
        });

        assert.ok(page.content.includes('Test[1]'));
        assert.ok(page.content.includes('[1] https://test.com'));
        assert.ok(!page.content.includes('[Test](https://test.com)'));
    } finally {
        (AgentCrawl as any).fetcher = origFetcher;
        (AgentCrawl as any).markdownifier = origMarkdown;
        (AgentCrawl as any).cache = origCache;
    }
});

test('citations not applied when not enabled', async () => {
    const { AgentCrawl } = await import('../src/AgentCrawl.js');

    const origFetcher = (AgentCrawl as any).fetcher;
    const origMarkdown = (AgentCrawl as any).markdownifier;
    const origCache = (AgentCrawl as any).cache;

    try {
        (AgentCrawl as any).fetcher = {
            fetch: async () => ({
                url: 'https://example.com',
                html: '<html><body>Hi</body></html>',
                status: 200, headers: {}, isStaticSuccess: true, needsBrowser: false,
            }),
        };
        (AgentCrawl as any).markdownifier = {
            extractAll: () => ({
                title: 'T', links: [],
                markdown: 'Visit [Test](https://test.com) now.',
            }),
        };
        (AgentCrawl as any).cache = { get: () => null, set: () => {} };

        const page = await AgentCrawl.scrape('https://example.com', { mode: 'static' });

        // Should keep inline links
        assert.ok(page.content.includes('[Test](https://test.com)'));
    } finally {
        (AgentCrawl as any).fetcher = origFetcher;
        (AgentCrawl as any).markdownifier = origMarkdown;
        (AgentCrawl as any).cache = origCache;
    }
});

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

test('CLI --citations flag works', async () => {
    const { execFileSync } = await import('node:child_process');
    const pathMod = await import('node:path');
    const CLI = pathMod.resolve('dist/cli.js');

    const stdout = execFileSync('node', [CLI, 'scrape', 'https://example.com', '--mode', 'static', '--citations'], {
        encoding: 'utf-8',
        timeout: 30000,
        stdio: ['pipe', 'pipe', 'pipe'],
    });

    // example.com has a "Learn more" link — should be converted to footnote
    assert.ok(stdout.includes('Learn more[1]') || stdout.includes('[1]'));
});
