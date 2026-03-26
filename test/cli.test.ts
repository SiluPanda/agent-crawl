import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const CLI = path.resolve('dist/cli.js');
const run = (args: string[], timeout = 15000): { stdout: string; stderr: string; exitCode: number } => {
    try {
        const stdout = execFileSync('node', [CLI, ...args], {
            encoding: 'utf-8',
            timeout,
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        return { stdout, stderr: '', exitCode: 0 };
    } catch (e: any) {
        return {
            stdout: e.stdout?.toString() || '',
            stderr: e.stderr?.toString() || '',
            exitCode: e.status ?? 1,
        };
    }
};

// ---------------------------------------------------------------------------
// Help and basic error handling
// ---------------------------------------------------------------------------

test('CLI --help shows usage', () => {
    const r = run(['--help']);
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes('agent-crawl'));
    assert.ok(r.stdout.includes('scrape'));
    assert.ok(r.stdout.includes('crawl'));
});

test('CLI -h shows usage', () => {
    const r = run(['-h']);
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes('Usage'));
});

test('CLI no args shows help', () => {
    const r = run([]);
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes('agent-crawl'));
});

test('CLI unknown command errors', () => {
    const r = run(['bad']);
    assert.equal(r.exitCode, 1);
    assert.ok(r.stderr.includes('Unknown command'));
});

test('CLI scrape without URL errors', () => {
    const r = run(['scrape']);
    assert.equal(r.exitCode, 1);
    assert.ok(r.stderr.includes('Missing URL'));
});

test('CLI crawl without URL errors', () => {
    const r = run(['crawl']);
    assert.equal(r.exitCode, 1);
    assert.ok(r.stderr.includes('Missing URL'));
});

test('CLI invalid output format errors', () => {
    const r = run(['scrape', 'https://example.com', '--output', 'xml']);
    assert.equal(r.exitCode, 1);
    assert.ok(r.stderr.includes('Invalid output format'));
});

test('CLI scrape help flag', () => {
    const r = run(['scrape', '--help']);
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes('agent-crawl'));
});

// ---------------------------------------------------------------------------
// Live scrape tests (example.com is stable and fast)
// ---------------------------------------------------------------------------

test('CLI scrape example.com markdown output', () => {
    const r = run(['scrape', 'https://example.com', '--mode', 'static'], 30000);
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes('Example Domain'));
    assert.ok(r.stdout.includes('documentation'));
});

test('CLI scrape example.com JSON output', () => {
    const r = run(['scrape', 'https://example.com', '--mode', 'static', '-o', 'json'], 30000);
    assert.equal(r.exitCode, 0);
    const page = JSON.parse(r.stdout);
    assert.equal(page.url, 'https://example.com');
    assert.ok(page.content.includes('Example Domain'));
    assert.equal(page.title, 'Example Domain');
    assert.equal(page.metadata.status, 200);
});

test('CLI scrape with --main flag', () => {
    const r = run(['scrape', 'https://example.com', '--mode', 'static', '--main', '-o', 'json'], 30000);
    assert.equal(r.exitCode, 0);
    const page = JSON.parse(r.stdout);
    assert.ok(page.content.length > 0);
});

test('CLI scrape with --extract-css', () => {
    const r = run([
        'scrape', 'https://example.com', '--mode', 'static',
        '--extract-css', '{"title":"h1"}',
        '-o', 'json',
    ], 30000);
    assert.equal(r.exitCode, 0);
    const page = JSON.parse(r.stdout);
    assert.equal(page.extracted.title, 'Example Domain');
});

test('CLI scrape with --extract-regex', () => {
    const r = run([
        'scrape', 'https://example.com', '--mode', 'static',
        '--extract-regex', '{"words":"[A-Z][a-z]+"}',
        '-o', 'json',
    ], 30000);
    assert.equal(r.exitCode, 0);
    const page = JSON.parse(r.stdout);
    assert.ok(Array.isArray(page.extracted.words));
    assert.ok(page.extracted.words.length > 0);
});

test('CLI scrape with --chunking', () => {
    const r = run([
        'scrape', 'https://example.com', '--mode', 'static',
        '--chunking', '-o', 'json',
    ], 30000);
    assert.equal(r.exitCode, 0);
    const page = JSON.parse(r.stdout);
    assert.ok(Array.isArray(page.chunks));
    assert.ok(page.chunks.length > 0);
});

test('CLI scrape with custom header', () => {
    const r = run([
        'scrape', 'https://example.com', '--mode', 'static',
        '-H', 'X-Custom: test-value',
        '-o', 'json',
    ], 30000);
    assert.equal(r.exitCode, 0);
    const page = JSON.parse(r.stdout);
    assert.equal(page.metadata.status, 200);
});

test('CLI scrape rejects private hosts', () => {
    const r = run(['scrape', 'http://127.0.0.1', '--mode', 'static', '-o', 'json'], 10000);
    assert.equal(r.exitCode, 0); // Returns error page, not crash
    const page = JSON.parse(r.stdout);
    assert.ok(page.metadata.error?.includes('private'));
});

// ---------------------------------------------------------------------------
// Invalid input handling
// ---------------------------------------------------------------------------

test('CLI --extract-css with invalid JSON errors', () => {
    const r = run(['scrape', 'https://example.com', '--extract-css', 'not json']);
    assert.equal(r.exitCode, 1);
    assert.ok(r.stderr.includes('Invalid JSON'));
});

test('CLI --extract-regex with invalid JSON errors', () => {
    const r = run(['scrape', 'https://example.com', '--extract-regex', '{bad}']);
    assert.equal(r.exitCode, 1);
    assert.ok(r.stderr.includes('Invalid JSON'));
});

test('CLI invalid mode errors', () => {
    const r = run(['scrape', 'https://example.com', '--mode', 'turbo']);
    assert.equal(r.exitCode, 1);
    assert.ok(r.stderr.includes('Invalid mode'));
});

test('CLI invalid strategy errors', () => {
    const r = run(['crawl', 'https://example.com', '--strategy', 'random']);
    assert.equal(r.exitCode, 1);
    assert.ok(r.stderr.includes('Invalid strategy'));
});

test('CLI invalid header format errors', () => {
    const r = run(['scrape', 'https://example.com', '-H', 'badheader']);
    assert.equal(r.exitCode, 1);
    assert.ok(r.stderr.includes('Invalid header'));
});

test('CLI invalid cookie format errors', () => {
    const r = run(['scrape', 'https://example.com', '--cookie', 'nocookie']);
    assert.equal(r.exitCode, 1);
    assert.ok(r.stderr.includes('Invalid cookie'));
});
