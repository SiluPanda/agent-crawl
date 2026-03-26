import { parseArgs } from 'node:util';
import { writeFileSync } from 'node:fs';
import { AgentCrawl } from './AgentCrawl.js';
import type { ScrapeConfig, CrawlConfig, CookieDef, CssExtractionConfig, RegexExtractionConfig } from './types.js';

const HELP = `
agent-crawl — High-performance web scraping for LLM agents

Usage:
  agent-crawl scrape <url> [options]
  agent-crawl crawl  <url> [options]

Scrape options:
  -m, --mode <mode>        Fetch mode: static, hybrid, browser (default: hybrid)
  -w, --wait-for <sel>     CSS selector to wait for (browser mode)
  --main                   Extract main content only
  --no-optimize            Disable token optimization
  --stealth                Enable stealth mode
  --js <code>              JavaScript to execute (repeatable)
  --screenshot             Capture screenshot (saves to screenshot.png)
  --pdf                    Capture PDF (saves to page.pdf)
  -o, --output <format>    Output format: markdown, json (default: markdown)
  --proxy <url>            Proxy server URL
  -H, --header <key:val>   Custom header (repeatable, format: "Key: Value")
  --cookie <name=value>    Cookie (repeatable)
  --extract-css <json>     CSS extraction schema (JSON string)
  --extract-regex <json>   Regex extraction patterns (JSON string)
  --chunking               Enable token-aware chunking
  --scroll                 Auto-scroll to load lazy/infinite content
  --max-scrolls <n>        Max scroll iterations (default: 10)
  --scroll-delay <ms>      Delay between scrolls in ms (default: 500)
  --tables                 Extract HTML tables as structured data
  --citations              Convert inline links to numbered footnotes
  --max-retries <n>        Max retry attempts (default: 2)
  --retry-delay <ms>       Base retry delay in ms (default: 1000)

Crawl options (in addition to scrape options):
  -d, --depth <n>          Max crawl depth (default: 1)
  -n, --pages <n>          Max pages to crawl (default: 10)
  -c, --concurrency <n>    Concurrent requests (default: 2)
  --strategy <str>         Crawl strategy: bfs, dfs, bestfirst (default: bfs)
  --keywords <k1,k2,...>   Priority keywords for bestfirst strategy
  --include <pattern>      URL include pattern (repeatable)
  --exclude <pattern>      URL exclude pattern (repeatable)
  --robots                 Enable robots.txt compliance
  --sitemap                Enable sitemap seeding

Examples:
  agent-crawl scrape https://example.com
  agent-crawl scrape https://example.com --mode browser --stealth --js "document.querySelector('.more').click()"
  agent-crawl scrape https://example.com --output json --extract-css '{"title":"h1","price":".price"}'
  agent-crawl crawl https://example.com --depth 2 --pages 50 --strategy dfs
  agent-crawl crawl https://example.com --robots --sitemap --output json
`.trim();

function fatal(msg: string): never {
    process.stderr.write(`Error: ${msg}\n`);
    process.exit(1);
}

function parseHeaders(raw: string[]): Record<string, string> {
    const headers: Record<string, string> = {};
    for (const h of raw) {
        const idx = h.indexOf(':');
        if (idx === -1) { fatal(`Invalid header format: "${h}" (expected "Key: Value")`); }
        headers[h.slice(0, idx).trim()] = h.slice(idx + 1).trim();
    }
    return headers;
}

function parseCookies(raw: string[]): CookieDef[] {
    return raw.map(c => {
        const idx = c.indexOf('=');
        if (idx === -1) fatal(`Invalid cookie format: "${c}" (expected "name=value")`);
        return { name: c.slice(0, idx), value: c.slice(idx + 1) };
    });
}

async function main() {
    const args = process.argv.slice(2);
    if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
        console.log(HELP);
        process.exit(0);
    }

    const command = args[0];
    if (command !== 'scrape' && command !== 'crawl') {
        fatal(`Unknown command: "${command}". Use "scrape" or "crawl".`);
    }

    let parsed;
    try {
        parsed = parseArgs({
            args: args.slice(1),
            options: {
                mode: { type: 'string', short: 'm' },
                'wait-for': { type: 'string', short: 'w' },
                main: { type: 'boolean', default: false },
                'no-optimize': { type: 'boolean', default: false },
                stealth: { type: 'boolean', default: false },
                js: { type: 'string', multiple: true },
                screenshot: { type: 'boolean', default: false },
                pdf: { type: 'boolean', default: false },
                output: { type: 'string', short: 'o', default: 'markdown' },
                proxy: { type: 'string' },
                header: { type: 'string', short: 'H', multiple: true },
                cookie: { type: 'string', multiple: true },
                'extract-css': { type: 'string' },
                'extract-regex': { type: 'string' },
                chunking: { type: 'boolean', default: false },
                scroll: { type: 'boolean', default: false },
                'max-scrolls': { type: 'string' },
                'scroll-delay': { type: 'string' },
                tables: { type: 'boolean', default: false },
                citations: { type: 'boolean', default: false },
                'max-retries': { type: 'string' },
                'retry-delay': { type: 'string' },
                // Crawl-specific
                depth: { type: 'string', short: 'd' },
                pages: { type: 'string', short: 'n' },
                concurrency: { type: 'string', short: 'c' },
                strategy: { type: 'string' },
                keywords: { type: 'string' },
                include: { type: 'string', multiple: true },
                exclude: { type: 'string', multiple: true },
                robots: { type: 'boolean', default: false },
                sitemap: { type: 'boolean', default: false },
                help: { type: 'boolean', short: 'h', default: false },
            },
            allowPositionals: true,
            strict: false,
        });
    } catch (e: any) {
        fatal(e.message);
    }

    if (parsed.values.help) {
        console.log(HELP);
        process.exit(0);
    }

    const url = parsed.positionals[0];
    if (!url) {
        fatal(`Missing URL. Usage: agent-crawl ${command} <url> [options]`);
    }

    const v = parsed.values;
    const outputFormat = (v.output as string) || 'markdown';
    if (outputFormat !== 'markdown' && outputFormat !== 'json') {
        fatal(`Invalid output format: "${outputFormat}". Use "markdown" or "json".`);
    }

    // Build scrape config
    const config: ScrapeConfig & CrawlConfig = {};

    if (v.mode) {
        const m = v.mode as string;
        if (m !== 'static' && m !== 'hybrid' && m !== 'browser') fatal(`Invalid mode: "${m}"`);
        config.mode = m;
    }
    if (v['wait-for']) config.waitFor = v['wait-for'] as string;
    if (v.main) config.extractMainContent = true;
    if (v['no-optimize']) config.optimizeTokens = false;
    if (v.stealth) config.stealth = true;
    if (v.js && (v.js as string[]).length > 0) config.jsCode = v.js as string[];
    if (v.screenshot) config.screenshot = true;
    if (v.pdf) config.pdf = true;
    if (v.proxy) config.proxy = { url: v.proxy as string };
    if (v.header && (v.header as string[]).length > 0) config.headers = parseHeaders(v.header as string[]);
    if (v.cookie && (v.cookie as string[]).length > 0) config.cookies = parseCookies(v.cookie as string[]);
    if (v.chunking) config.chunking = true;
    if (v.scroll) {
        config.scroll = {
            enabled: true,
            ...(v['max-scrolls'] ? { maxScrolls: parseInt(v['max-scrolls'] as string, 10) } : {}),
            ...(v['scroll-delay'] ? { scrollDelay: parseInt(v['scroll-delay'] as string, 10) } : {}),
        };
    }

    if (v.tables) config.tableExtraction = true;
    if (v.citations) config.citations = true;
    if (v['max-retries'] || v['retry-delay']) {
        config.retry = {
            ...(v['max-retries'] ? { maxRetries: parseInt(v['max-retries'] as string, 10) } : {}),
            ...(v['retry-delay'] ? { baseDelayMs: parseInt(v['retry-delay'] as string, 10) } : {}),
        };
    }

    if (v['extract-css']) {
        try {
            const schema = JSON.parse(v['extract-css'] as string);
            config.extraction = { type: 'css', schema } as CssExtractionConfig;
        } catch { fatal('Invalid JSON for --extract-css'); }
    }
    if (v['extract-regex']) {
        try {
            const patterns = JSON.parse(v['extract-regex'] as string);
            config.extraction = { type: 'regex', patterns } as RegexExtractionConfig;
        } catch { fatal('Invalid JSON for --extract-regex'); }
    }

    // Crawl-specific options
    if (command === 'crawl') {
        if (v.depth) config.maxDepth = parseInt(v.depth as string, 10);
        if (v.pages) config.maxPages = parseInt(v.pages as string, 10);
        if (v.concurrency) config.concurrency = parseInt(v.concurrency as string, 10);
        if (v.strategy) {
            const s = v.strategy as string;
            if (s !== 'bfs' && s !== 'dfs' && s !== 'bestfirst') fatal(`Invalid strategy: "${s}"`);
            config.strategy = s;
        }
        if (v.keywords) config.priorityKeywords = (v.keywords as string).split(',').map(k => k.trim());
        if (v.include && (v.include as string[]).length > 0) config.includePatterns = v.include as string[];
        if (v.exclude && (v.exclude as string[]).length > 0) config.excludePatterns = v.exclude as string[];
        if (v.robots) config.robots = true;
        if (v.sitemap) config.sitemap = true;
    }

    try {
        if (command === 'scrape') {
            const page = await AgentCrawl.scrape(url, config);

            // Save screenshot/pdf to files
            if (page.screenshot) {
                const file = 'screenshot.png';
                writeFileSync(file, Buffer.from(page.screenshot, 'base64'));
                process.stderr.write(`Screenshot saved: ${file}\n`);
            }
            if (page.pdf) {
                const file = 'page.pdf';
                writeFileSync(file, Buffer.from(page.pdf, 'base64'));
                process.stderr.write(`PDF saved: ${file}\n`);
            }

            if (outputFormat === 'json') {
                // Omit large binary fields from JSON stdout (they're saved to files)
                const { screenshot: _s, pdf: _p, ...rest } = page;
                console.log(JSON.stringify(rest, null, 2));
            } else {
                process.stdout.write(page.content);
                if (page.content && !page.content.endsWith('\n')) process.stdout.write('\n');
            }
        } else {
            const result = await AgentCrawl.crawl(url, config);

            if (outputFormat === 'json') {
                const cleaned = {
                    ...result,
                    pages: result.pages.map(({ screenshot: _s, pdf: _p, ...rest }) => rest),
                };
                console.log(JSON.stringify(cleaned, null, 2));
            } else {
                for (const page of result.pages) {
                    process.stdout.write(`--- ${page.url} ---\n`);
                    process.stdout.write(page.content);
                    if (page.content && !page.content.endsWith('\n')) process.stdout.write('\n');
                    process.stdout.write('\n');
                }
                process.stderr.write(`Crawled ${result.totalPages} pages, ${result.errors.length} errors, max depth ${result.maxDepthReached}\n`);
            }
        }
    } catch (e: any) {
        fatal(e.message || 'Unknown error');
    } finally {
        await AgentCrawl.close();
    }
}

main();
