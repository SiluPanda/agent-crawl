import { createInterface } from 'node:readline';
import { AgentCrawl } from './AgentCrawl.js';
import type { ScrapeConfig, CrawlConfig } from './types.js';

const SERVER_INFO = { name: 'agent-crawl', version: '3.9.0' };
const PROTOCOL_VERSION = '2024-11-05';

const TOOLS = [
    {
        name: 'scrape',
        description: 'Scrape a web page and return its content as markdown. Supports static/hybrid/browser modes, JavaScript execution, auto-scroll, stealth, screenshot/PDF capture, and structured data extraction.',
        inputSchema: {
            type: 'object',
            properties: {
                url: { type: 'string', description: 'URL to scrape' },
                mode: { type: 'string', enum: ['static', 'hybrid', 'browser'], description: 'Fetch mode (default: hybrid)' },
                waitFor: { type: 'string', description: 'CSS selector to wait for (browser mode)' },
                extractMainContent: { type: 'boolean', description: 'Extract only main content' },
                stealth: { type: 'boolean', description: 'Enable anti-bot stealth mode' },
                jsCode: { type: 'string', description: 'JavaScript to execute after page load' },
                scroll: { type: 'boolean', description: 'Auto-scroll for lazy/infinite content' },
                maxScrolls: { type: 'number', description: 'Max scroll iterations (default: 10)' },
                screenshot: { type: 'boolean', description: 'Capture page screenshot' },
                pdf: { type: 'boolean', description: 'Capture page as PDF' },
            },
            required: ['url'],
        },
    },
    {
        name: 'crawl',
        description: 'Crawl a website starting from a URL. Returns markdown content from all crawled pages. Supports BFS/DFS/best-first strategies, robots.txt, sitemap seeding.',
        inputSchema: {
            type: 'object',
            properties: {
                url: { type: 'string', description: 'Start URL' },
                maxDepth: { type: 'number', description: 'Maximum crawl depth (default: 1)' },
                maxPages: { type: 'number', description: 'Maximum pages to crawl (default: 10)' },
                concurrency: { type: 'number', description: 'Concurrent requests (default: 2)' },
                strategy: { type: 'string', enum: ['bfs', 'dfs', 'bestfirst'], description: 'Crawl strategy (default: bfs)' },
                priorityKeywords: { type: 'array', items: { type: 'string' }, description: 'Keywords for bestfirst strategy' },
                includePatterns: { type: 'array', items: { type: 'string' }, description: 'URL include patterns' },
                excludePatterns: { type: 'array', items: { type: 'string' }, description: 'URL exclude patterns' },
                robots: { type: 'boolean', description: 'Enable robots.txt compliance' },
                sitemap: { type: 'boolean', description: 'Enable sitemap seeding' },
                extractMainContent: { type: 'boolean', description: 'Extract only main content per page' },
                stealth: { type: 'boolean', description: 'Enable anti-bot stealth mode' },
            },
            required: ['url'],
        },
    },
    {
        name: 'extract',
        description: 'Extract structured data from a web page using CSS selectors or regex patterns. Returns JSON with the extracted data.',
        inputSchema: {
            type: 'object',
            properties: {
                url: { type: 'string', description: 'URL to scrape and extract from' },
                cssSchema: { type: 'object', description: 'CSS extraction schema — keys are field names, values are CSS selectors (string) or field definitions (object with selector, type, attribute, all, fields)' },
                regexPatterns: { type: 'object', description: 'Regex extraction patterns — keys are field names, values are regex pattern strings' },
            },
            required: ['url'],
        },
    },
];

function send(msg: object) {
    process.stdout.write(JSON.stringify(msg) + '\n');
}

function jsonRpcResponse(id: string | number, result: unknown) {
    send({ jsonrpc: '2.0', id, result });
}

function jsonRpcError(id: string | number | null, code: number, message: string) {
    send({ jsonrpc: '2.0', id, error: { code, message } });
}

async function handleToolCall(name: string, args: Record<string, unknown>): Promise<{ content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; isError?: boolean }> {
    try {
        if (name === 'scrape') {
            const url = args.url as string;
            if (!url) return { content: [{ type: 'text', text: 'Missing required parameter: url' }], isError: true };

            const config: ScrapeConfig = {};
            if (args.mode) config.mode = args.mode as ScrapeConfig['mode'];
            if (args.waitFor) config.waitFor = args.waitFor as string;
            if (args.extractMainContent) config.extractMainContent = true;
            if (args.stealth) config.stealth = true;
            if (args.jsCode) config.jsCode = args.jsCode as string;
            if (args.scroll) config.scroll = args.maxScrolls ? { enabled: true, maxScrolls: args.maxScrolls as number } : true;
            if (args.screenshot) config.screenshot = true;
            if (args.pdf) config.pdf = true;

            const page = await AgentCrawl.scrape(url, config);

            if (page.metadata?.error) {
                return { content: [{ type: 'text', text: `Error: ${page.metadata.error}` }], isError: true };
            }

            const parts: Array<{ type: string; text?: string; data?: string; mimeType?: string }> = [];
            parts.push({ type: 'text', text: page.content });

            if (page.screenshot) {
                parts.push({ type: 'image', data: page.screenshot, mimeType: 'image/png' });
            }

            return { content: parts };
        }

        if (name === 'crawl') {
            const url = args.url as string;
            if (!url) return { content: [{ type: 'text', text: 'Missing required parameter: url' }], isError: true };

            const config: CrawlConfig = {};
            if (args.maxDepth !== undefined) config.maxDepth = args.maxDepth as number;
            if (args.maxPages !== undefined) config.maxPages = args.maxPages as number;
            if (args.concurrency !== undefined) config.concurrency = args.concurrency as number;
            if (args.strategy) config.strategy = args.strategy as CrawlConfig['strategy'];
            if (args.priorityKeywords) config.priorityKeywords = args.priorityKeywords as string[];
            if (args.includePatterns) config.includePatterns = args.includePatterns as string[];
            if (args.excludePatterns) config.excludePatterns = args.excludePatterns as string[];
            if (args.robots) config.robots = true;
            if (args.sitemap) config.sitemap = true;
            if (args.extractMainContent) config.extractMainContent = true;
            if (args.stealth) config.stealth = true;

            const result = await AgentCrawl.crawl(url, config);

            const text = result.pages.map(p =>
                `--- ${p.url} ---\n${p.content}`
            ).join('\n\n') + `\n\n[Crawled ${result.totalPages} pages, ${result.errors.length} errors, max depth ${result.maxDepthReached}]`;

            return { content: [{ type: 'text', text }] };
        }

        if (name === 'extract') {
            const url = args.url as string;
            if (!url) return { content: [{ type: 'text', text: 'Missing required parameter: url' }], isError: true };

            const config: ScrapeConfig = {};
            if (args.cssSchema) {
                config.extraction = { type: 'css', schema: args.cssSchema as Record<string, any> };
            } else if (args.regexPatterns) {
                config.extraction = { type: 'regex', patterns: args.regexPatterns as Record<string, string> };
            } else {
                return { content: [{ type: 'text', text: 'Provide either cssSchema or regexPatterns' }], isError: true };
            }

            const page = await AgentCrawl.scrape(url, config);

            if (page.metadata?.error) {
                return { content: [{ type: 'text', text: `Error: ${page.metadata.error}` }], isError: true };
            }

            return { content: [{ type: 'text', text: JSON.stringify(page.extracted ?? {}, null, 2) }] };
        }

        return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
    } catch (e) {
        const msg = e instanceof Error ? e.message : 'Unknown error';
        return { content: [{ type: 'text', text: `Tool error: ${msg.slice(0, 500)}` }], isError: true };
    }
}

async function handleMessage(msg: any) {
    const id = msg.id;
    const method = msg.method;

    // Notifications (no id) — no response needed
    if (id === undefined || id === null) return;

    switch (method) {
        case 'initialize':
            jsonRpcResponse(id, {
                protocolVersion: PROTOCOL_VERSION,
                capabilities: { tools: {} },
                serverInfo: SERVER_INFO,
            });
            break;

        case 'tools/list':
            jsonRpcResponse(id, { tools: TOOLS });
            break;

        case 'tools/call': {
            const name = msg.params?.name as string;
            const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
            const result = await handleToolCall(name, args);
            jsonRpcResponse(id, result);
            break;
        }

        case 'ping':
            jsonRpcResponse(id, {});
            break;

        default:
            jsonRpcError(id, -32601, `Method not found: ${method}`);
    }
}

async function main() {
    process.stderr.write('[agent-crawl-mcp] MCP server starting on stdio\n');

    let pendingOps = 0;
    let stdinClosed = false;

    const shutdown = async () => {
        await AgentCrawl.close();
        process.exit(0);
    };

    const maybeShutdown = () => {
        if (stdinClosed && pendingOps === 0) shutdown();
    };

    const rl = createInterface({ input: process.stdin, terminal: false });

    rl.on('line', (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        let msg: any;
        try { msg = JSON.parse(trimmed); } catch { return; }

        pendingOps++;
        handleMessage(msg).finally(() => {
            pendingOps--;
            maybeShutdown();
        });
    });

    rl.on('close', () => {
        stdinClosed = true;
        maybeShutdown();
    });

    process.on('SIGINT', () => shutdown());
    process.on('SIGTERM', () => shutdown());
}

main();
