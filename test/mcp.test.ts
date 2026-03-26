import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import path from 'node:path';

const MCP = path.resolve('dist/mcp.js');

function mcpCall(messages: object[], timeout = 30000): string[] {
    const input = messages.map(m => JSON.stringify(m)).join('\n') + '\n';
    try {
        const stdout = execFileSync('node', [MCP], {
            input,
            encoding: 'utf-8',
            timeout,
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        return stdout.trim().split('\n').filter(l => l.trim());
    } catch (e: any) {
        const out = e.stdout?.toString() || '';
        return out.trim().split('\n').filter((l: string) => l.trim());
    }
}

function parseResponse(lines: string[], id: number): any {
    for (const line of lines) {
        try {
            const msg = JSON.parse(line);
            if (msg.id === id) return msg;
        } catch { /* skip */ }
    }
    return null;
}

// ---------------------------------------------------------------------------
// Initialize handshake
// ---------------------------------------------------------------------------

test('MCP: initialize returns server info and capabilities', () => {
    const lines = mcpCall([
        { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } } },
    ]);
    const resp = parseResponse(lines, 1);
    assert.ok(resp);
    assert.equal(resp.result.protocolVersion, '2024-11-05');
    assert.equal(resp.result.serverInfo.name, 'agent-crawl');
    assert.ok(resp.result.capabilities.tools);
});

// ---------------------------------------------------------------------------
// tools/list
// ---------------------------------------------------------------------------

test('MCP: tools/list returns scrape, crawl, extract', () => {
    const lines = mcpCall([
        { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
    ]);
    const resp = parseResponse(lines, 1);
    assert.ok(resp);
    const names = resp.result.tools.map((t: any) => t.name);
    assert.ok(names.includes('scrape'));
    assert.ok(names.includes('crawl'));
    assert.ok(names.includes('extract'));
    assert.equal(resp.result.tools.length, 3);
});

test('MCP: tools have valid inputSchema with required fields', () => {
    const lines = mcpCall([
        { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
    ]);
    const resp = parseResponse(lines, 1);
    for (const tool of resp.result.tools) {
        assert.ok(tool.inputSchema);
        assert.equal(tool.inputSchema.type, 'object');
        assert.ok(tool.inputSchema.required.includes('url'));
        assert.ok(tool.description.length > 10);
    }
});

// ---------------------------------------------------------------------------
// tools/call — scrape
// ---------------------------------------------------------------------------

test('MCP: scrape returns markdown content', () => {
    const lines = mcpCall([
        { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'scrape', arguments: { url: 'https://example.com', mode: 'static' } } },
    ]);
    const resp = parseResponse(lines, 1);
    assert.ok(resp);
    assert.ok(!resp.result.isError);
    assert.equal(resp.result.content[0].type, 'text');
    assert.ok(resp.result.content[0].text.includes('Example Domain'));
});

test('MCP: scrape with extractMainContent', () => {
    const lines = mcpCall([
        { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'scrape', arguments: { url: 'https://example.com', mode: 'static', extractMainContent: true } } },
    ]);
    const resp = parseResponse(lines, 1);
    assert.ok(resp);
    assert.ok(!resp.result.isError);
    assert.ok(resp.result.content[0].text.length > 0);
});

test('MCP: scrape missing url returns error', () => {
    const lines = mcpCall([
        { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'scrape', arguments: {} } },
    ]);
    const resp = parseResponse(lines, 1);
    assert.ok(resp);
    assert.equal(resp.result.isError, true);
    assert.ok(resp.result.content[0].text.includes('Missing'));
});

test('MCP: scrape SSRF blocked', () => {
    const lines = mcpCall([
        { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'scrape', arguments: { url: 'http://127.0.0.1' } } },
    ]);
    const resp = parseResponse(lines, 1);
    assert.ok(resp);
    assert.equal(resp.result.isError, true);
    assert.ok(resp.result.content[0].text.includes('private'));
});

// ---------------------------------------------------------------------------
// tools/call — extract
// ---------------------------------------------------------------------------

test('MCP: extract with CSS schema', () => {
    const lines = mcpCall([
        { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'extract', arguments: { url: 'https://example.com', cssSchema: { title: 'h1' } } } },
    ]);
    const resp = parseResponse(lines, 1);
    assert.ok(resp);
    assert.ok(!resp.result.isError);
    const extracted = JSON.parse(resp.result.content[0].text);
    assert.equal(extracted.title, 'Example Domain');
});

test('MCP: extract with regex patterns', () => {
    const lines = mcpCall([
        { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'extract', arguments: { url: 'https://example.com', regexPatterns: { words: '[A-Z][a-z]+' } } } },
    ]);
    const resp = parseResponse(lines, 1);
    assert.ok(resp);
    assert.ok(!resp.result.isError);
    const extracted = JSON.parse(resp.result.content[0].text);
    assert.ok(Array.isArray(extracted.words));
    assert.ok(extracted.words.length > 0);
});

test('MCP: extract missing schema returns error', () => {
    const lines = mcpCall([
        { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'extract', arguments: { url: 'https://example.com' } } },
    ]);
    const resp = parseResponse(lines, 1);
    assert.ok(resp);
    assert.equal(resp.result.isError, true);
    assert.ok(resp.result.content[0].text.includes('cssSchema'));
});

// ---------------------------------------------------------------------------
// ping and unknown methods
// ---------------------------------------------------------------------------

test('MCP: ping returns empty result', () => {
    const lines = mcpCall([
        { jsonrpc: '2.0', id: 1, method: 'ping' },
    ]);
    const resp = parseResponse(lines, 1);
    assert.ok(resp);
    assert.deepEqual(resp.result, {});
});

test('MCP: unknown method returns error', () => {
    const lines = mcpCall([
        { jsonrpc: '2.0', id: 1, method: 'unknown/method' },
    ]);
    const resp = parseResponse(lines, 1);
    assert.ok(resp);
    assert.ok(resp.error);
    assert.equal(resp.error.code, -32601);
});

test('MCP: unknown tool returns isError', () => {
    const lines = mcpCall([
        { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'nonexistent', arguments: {} } },
    ]);
    const resp = parseResponse(lines, 1);
    assert.ok(resp);
    assert.equal(resp.result.isError, true);
    assert.ok(resp.result.content[0].text.includes('Unknown tool'));
});

// ---------------------------------------------------------------------------
// Notifications (no response)
// ---------------------------------------------------------------------------

test('MCP: notification with no id produces no response', () => {
    const lines = mcpCall([
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        { jsonrpc: '2.0', id: 99, method: 'ping' },
    ]);
    // Should only get the ping response, not a response for the notification
    assert.equal(lines.length, 1);
    const resp = parseResponse(lines, 99);
    assert.ok(resp);
});

// ---------------------------------------------------------------------------
// Multiple messages in one session
// ---------------------------------------------------------------------------

test('MCP: multiple calls in sequence', () => {
    const lines = mcpCall([
        { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } } },
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
        { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'scrape', arguments: { url: 'https://example.com', mode: 'static' } } },
    ]);

    const init = parseResponse(lines, 1);
    assert.ok(init?.result?.serverInfo);

    const list = parseResponse(lines, 2);
    assert.ok(list?.result?.tools?.length === 3);

    const scrape = parseResponse(lines, 3);
    assert.ok(scrape?.result?.content?.[0]?.text?.includes('Example Domain'));
});

// ---------------------------------------------------------------------------
// Malformed input
// ---------------------------------------------------------------------------

test('MCP: malformed JSON is silently ignored', () => {
    const input = 'not valid json\n{"jsonrpc":"2.0","id":1,"method":"ping"}\n';
    try {
        const stdout = execFileSync('node', [MCP], {
            input,
            encoding: 'utf-8',
            timeout: 10000,
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        const lines = stdout.trim().split('\n').filter(l => l.trim());
        assert.equal(lines.length, 1);
        const resp = JSON.parse(lines[0]);
        assert.equal(resp.id, 1);
    } catch (e: any) {
        const lines = (e.stdout?.toString() || '').trim().split('\n').filter((l: string) => l.trim());
        assert.equal(lines.length, 1);
    }
});
