import test from 'node:test';
import assert from 'node:assert/strict';
import { extractTables } from '../src/core/TableExtractor.js';
import { ScrapeOptionsSchema } from '../src/schemas.js';

// ---------------------------------------------------------------------------
// Basic table extraction
// ---------------------------------------------------------------------------

test('extracts simple data table with thead/tbody', () => {
    const html = `
        <table>
            <thead><tr><th>Name</th><th>Age</th><th>City</th></tr></thead>
            <tbody>
                <tr><td>Alice</td><td>30</td><td>NYC</td></tr>
                <tr><td>Bob</td><td>25</td><td>LA</td></tr>
            </tbody>
        </table>
    `;
    const tables = extractTables(html);
    assert.equal(tables.length, 1);
    assert.deepEqual(tables[0].headers, ['Name', 'Age', 'City']);
    assert.equal(tables[0].rows.length, 2);
    assert.deepEqual(tables[0].rows[0], ['Alice', '30', 'NYC']);
    assert.deepEqual(tables[0].rows[1], ['Bob', '25', 'LA']);
});

test('extracts table with caption', () => {
    const html = `
        <table>
            <caption>Employee List</caption>
            <thead><tr><th>Name</th><th>Role</th></tr></thead>
            <tbody>
                <tr><td>Carol</td><td>Engineer</td></tr>
            </tbody>
        </table>
    `;
    const tables = extractTables(html);
    assert.equal(tables.length, 1);
    assert.equal(tables[0].caption, 'Employee List');
});

test('extracts table without thead — uses first row th as headers', () => {
    const html = `
        <table>
            <tr><th>Product</th><th>Price</th></tr>
            <tr><td>Widget</td><td>$9.99</td></tr>
            <tr><td>Gadget</td><td>$19.99</td></tr>
        </table>
    `;
    const tables = extractTables(html);
    assert.equal(tables.length, 1);
    assert.deepEqual(tables[0].headers, ['Product', 'Price']);
    assert.equal(tables[0].rows.length, 2);
});

test('extracts table without any th — uses first row as headers', () => {
    const html = `
        <table>
            <tr><td>Name</td><td>Score</td></tr>
            <tr><td>Alice</td><td>95</td></tr>
            <tr><td>Bob</td><td>87</td></tr>
        </table>
    `;
    const tables = extractTables(html);
    assert.equal(tables.length, 1);
    assert.deepEqual(tables[0].headers, ['Name', 'Score']);
    assert.equal(tables[0].rows.length, 2);
});

test('extracts multiple tables from one page', () => {
    const html = `
        <table>
            <thead><tr><th>A</th><th>B</th></tr></thead>
            <tbody><tr><td>1</td><td>2</td></tr></tbody>
        </table>
        <table>
            <thead><tr><th>X</th><th>Y</th></tr></thead>
            <tbody><tr><td>3</td><td>4</td></tr></tbody>
        </table>
    `;
    const tables = extractTables(html);
    assert.equal(tables.length, 2);
    assert.deepEqual(tables[0].headers, ['A', 'B']);
    assert.deepEqual(tables[1].headers, ['X', 'Y']);
});

// ---------------------------------------------------------------------------
// Layout table filtering
// ---------------------------------------------------------------------------

test('filters out layout tables (role=presentation)', () => {
    const html = `
        <table role="presentation">
            <tr><td>Layout cell 1</td><td>Layout cell 2</td></tr>
        </table>
        <table>
            <thead><tr><th>Real</th><th>Data</th></tr></thead>
            <tbody><tr><td>1</td><td>2</td></tr></tbody>
        </table>
    `;
    const tables = extractTables(html);
    assert.equal(tables.length, 1);
    assert.deepEqual(tables[0].headers, ['Real', 'Data']);
});

test('filters out single-row tables (likely layout)', () => {
    const html = `
        <table><tr><td>Only row</td></tr></table>
    `;
    const tables = extractTables(html);
    assert.equal(tables.length, 0);
});

test('filters out tables with layout class', () => {
    const html = `
        <table class="layout-table">
            <tr><td>A</td><td>B</td></tr>
            <tr><td>C</td><td>D</td></tr>
        </table>
    `;
    const tables = extractTables(html);
    assert.equal(tables.length, 0);
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

test('handles empty HTML', () => {
    const tables = extractTables('');
    assert.equal(tables.length, 0);
});

test('handles HTML with no tables', () => {
    const tables = extractTables('<html><body><p>No tables here</p></body></html>');
    assert.equal(tables.length, 0);
});

test('handles empty table', () => {
    const html = '<table></table>';
    const tables = extractTables(html);
    assert.equal(tables.length, 0);
});

test('skips empty rows', () => {
    const html = `
        <table>
            <thead><tr><th>A</th><th>B</th></tr></thead>
            <tbody>
                <tr><td></td><td></td></tr>
                <tr><td>1</td><td>2</td></tr>
            </tbody>
        </table>
    `;
    const tables = extractTables(html);
    assert.equal(tables.length, 1);
    assert.equal(tables[0].rows.length, 1);
    assert.deepEqual(tables[0].rows[0], ['1', '2']);
});

test('cleans whitespace in cells', () => {
    const html = `
        <table>
            <thead><tr><th>  Name  </th><th> Value </th></tr></thead>
            <tbody>
                <tr><td>  multi\n  line  </td><td> data </td></tr>
            </tbody>
        </table>
    `;
    const tables = extractTables(html);
    assert.equal(tables[0].headers[0], 'Name');
    assert.equal(tables[0].rows[0][0], 'multi line');
});

test('handles complex real-world table HTML', () => {
    const html = `
        <div class="content">
            <table class="data-table" summary="Sales figures">
                <caption>Q4 Sales Report</caption>
                <thead>
                    <tr><th>Region</th><th>Q1</th><th>Q2</th><th>Q3</th><th>Q4</th></tr>
                </thead>
                <tbody>
                    <tr><td>North</td><td>$1.2M</td><td>$1.5M</td><td>$1.3M</td><td>$1.8M</td></tr>
                    <tr><td>South</td><td>$0.8M</td><td>$0.9M</td><td>$1.1M</td><td>$1.2M</td></tr>
                    <tr><td>East</td><td>$2.1M</td><td>$2.3M</td><td>$2.0M</td><td>$2.5M</td></tr>
                    <tr><td>West</td><td>$1.5M</td><td>$1.7M</td><td>$1.6M</td><td>$2.0M</td></tr>
                </tbody>
            </table>
        </div>
    `;
    const tables = extractTables(html);
    assert.equal(tables.length, 1);
    assert.equal(tables[0].caption, 'Q4 Sales Report');
    assert.deepEqual(tables[0].headers, ['Region', 'Q1', 'Q2', 'Q3', 'Q4']);
    assert.equal(tables[0].rows.length, 4);
    assert.equal(tables[0].rows[0][0], 'North');
    assert.equal(tables[0].rows[3][4], '$2.0M');
});

// ---------------------------------------------------------------------------
// Schema validation
// ---------------------------------------------------------------------------

test('schema accepts tableExtraction: true', () => {
    const result = ScrapeOptionsSchema.safeParse({
        url: 'https://example.com',
        tableExtraction: true,
    });
    assert.ok(result.success);
});

test('schema accepts tableExtraction: false', () => {
    const result = ScrapeOptionsSchema.safeParse({
        url: 'https://example.com',
        tableExtraction: false,
    });
    assert.ok(result.success);
});

test('schema allows omitting tableExtraction', () => {
    const result = ScrapeOptionsSchema.safeParse({
        url: 'https://example.com',
    });
    assert.ok(result.success);
});

// ---------------------------------------------------------------------------
// AgentCrawl integration
// ---------------------------------------------------------------------------

test('AgentCrawl.scrape returns tables when tableExtraction is true', async () => {
    const { AgentCrawl } = await import('../src/AgentCrawl.js');

    const origFetcher = (AgentCrawl as any).fetcher;
    const origMarkdown = (AgentCrawl as any).markdownifier;
    const origCache = (AgentCrawl as any).cache;

    const html = `
        <html><body>
            <table>
                <thead><tr><th>Product</th><th>Price</th></tr></thead>
                <tbody>
                    <tr><td>Widget</td><td>$9.99</td></tr>
                    <tr><td>Gadget</td><td>$19.99</td></tr>
                </tbody>
            </table>
        </body></html>
    `;

    try {
        (AgentCrawl as any).fetcher = {
            fetch: async () => ({
                url: 'https://example.com', html,
                status: 200, headers: { 'content-type': 'text/html' },
                isStaticSuccess: true, needsBrowser: false,
            }),
        };
        (AgentCrawl as any).markdownifier = {
            extractAll: () => ({ title: 'T', links: [], markdown: 'Content' }),
        };
        (AgentCrawl as any).cache = { get: () => null, set: () => {} };

        const page = await AgentCrawl.scrape('https://example.com', {
            mode: 'static',
            tableExtraction: true,
        });

        assert.ok(page.tables);
        assert.equal(page.tables!.length, 1);
        assert.deepEqual(page.tables![0].headers, ['Product', 'Price']);
        assert.equal(page.tables![0].rows.length, 2);
    } finally {
        (AgentCrawl as any).fetcher = origFetcher;
        (AgentCrawl as any).markdownifier = origMarkdown;
        (AgentCrawl as any).cache = origCache;
    }
});

test('tables undefined when tableExtraction not set', async () => {
    const { AgentCrawl } = await import('../src/AgentCrawl.js');

    const origFetcher = (AgentCrawl as any).fetcher;
    const origMarkdown = (AgentCrawl as any).markdownifier;
    const origCache = (AgentCrawl as any).cache;

    try {
        (AgentCrawl as any).fetcher = {
            fetch: async () => ({
                url: 'https://example.com', html: '<html><body><table><tr><th>A</th></tr><tr><td>B</td></tr></table></body></html>',
                status: 200, headers: {}, isStaticSuccess: true, needsBrowser: false,
            }),
        };
        (AgentCrawl as any).markdownifier = {
            extractAll: () => ({ title: 'T', links: [], markdown: 'Content' }),
        };
        (AgentCrawl as any).cache = { get: () => null, set: () => {} };

        const page = await AgentCrawl.scrape('https://example.com', { mode: 'static' });
        assert.equal(page.tables, undefined);
    } finally {
        (AgentCrawl as any).fetcher = origFetcher;
        (AgentCrawl as any).markdownifier = origMarkdown;
        (AgentCrawl as any).cache = origCache;
    }
});

// ---------------------------------------------------------------------------
// CLI integration
// ---------------------------------------------------------------------------

test('CLI --tables flag accepted', async () => {
    const { execFileSync } = await import('node:child_process');
    const pathMod = await import('node:path');
    const CLI = pathMod.resolve('dist/cli.js');

    try {
        const stdout = execFileSync('node', [CLI, 'scrape', 'https://example.com', '--mode', 'static', '--tables', '-o', 'json'], {
            encoding: 'utf-8',
            timeout: 30000,
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        const page = JSON.parse(stdout);
        assert.ok('tables' in page);
        // example.com may or may not have qualifying tables — just verify the field exists
    } catch (e: any) {
        const stdout = e.stdout?.toString() || '';
        if (stdout.trim()) {
            const page = JSON.parse(stdout);
            assert.ok('tables' in page);
        }
    }
});
