# AgentCrawl

**The High-Performance TypeScript Web Scraper for LLM Agents.**

AgentCrawl is built to be the "eyes" of your AI Agents. It fetches web content, strips away the noise (ads, scripts, styles), and returns clean, token-optimized Markdown ready for your LLM context window.

It features a **Hybrid Engine** that starts with extremely fast static scraping and automatically falls back to a headless browser (Playwright) only when necessary for dynamic content or authentication.

## Features

- 🚀 **Hybrid Engine**: Instant static fetch by default, auto-switch to Headless Browser for dynamic sites.
- ⚡ **Token Optimized**: Returns clean Markdown, stripping 80-90% of tokens (ads, navs, footers).
- 🧠 **Agent-First**: Detects Main Content, removes boilerplate, and extracts semantic structure.
- 🔌 **Plug-and-Play**: Simple API designed for agent runtimes (scrape + crawl).
- 🛡️ **Production Ready**: Built-in caching, retry logic, user-agent rotation, and resource blocking.
- 🕵️ **Stealth Mode**: Optional best-effort browser hardening to reduce common bot-detection fingerprints.
- ✅ **Predictable Errors**: Non-2xx HTTP responses are surfaced as errors instead of silently parsed as success.
- 🇹 **Type-Safe**: 100% TypeScript with Zod validation.

## Installation

```bash
npm install agent-crawl
# OR
bun add agent-crawl
```

## CLI

AgentCrawl ships with a CLI for quick scraping and crawling from the terminal.

```bash
# Install globally
npm install -g agent-crawl

# Or use directly with npx
npx agent-crawl scrape https://example.com
```

### Scrape a page to markdown

```bash
agent-crawl scrape https://example.com
```

### JSON output with metadata

```bash
agent-crawl scrape https://example.com --output json
```

### Browser mode for JS-rendered pages

```bash
agent-crawl scrape https://example.com --mode browser --stealth
agent-crawl scrape https://example.com --mode browser --wait-for ".content" --js "document.querySelector('.more').click()"
```

### Structured extraction

```bash
agent-crawl scrape https://example.com --output json --extract-css '{"title":"h1","price":".price"}'
agent-crawl scrape https://example.com --output json --extract-regex '{"email":"[\\w.+-]+@[\\w-]+\\.[\\w.]+"}'
```

### Crawl multiple pages

```bash
agent-crawl crawl https://example.com --depth 2 --pages 50 --strategy dfs
agent-crawl crawl https://example.com --robots --sitemap --include "/blog/*"
agent-crawl crawl https://example.com --strategy bestfirst --keywords "pricing,plans,features"
```

### More options

```bash
# Auto-scroll for infinite/lazy content
agent-crawl scrape https://example.com --mode browser --scroll --max-scrolls 20

# Screenshot and PDF capture
agent-crawl scrape https://example.com --mode browser --screenshot --pdf

# Custom headers and cookies
agent-crawl scrape https://example.com -H "Authorization: Bearer tok123" --cookie "session=abc"

# Table extraction and footnote-style citations
agent-crawl scrape https://example.com --tables --citations

# Pipe to an LLM
agent-crawl scrape https://docs.example.com | llm "summarize this page"
```

Run `agent-crawl --help` for the full list of options.

## Quick Start

### Basic Usage

```typescript
import { AgentCrawl } from 'agent-crawl';

// Simplest usage - returns clean properties
const page = await AgentCrawl.scrape("https://example.com");

console.log(page.title);   // "Example Domain"
console.log(page.content); // "Example Domain\n\nThis domain is for use..."
console.log(page.links);   // Array of same-origin links found on the page
```

### Advanced Usage (Optimized for LLMs)

```typescript
const page = await AgentCrawl.scrape("https://news.ycombinator.com", {
  mode: "hybrid",            // "static" | "browser" | "hybrid" (default)
  extractMainContent: true,  // Extract only the article body
  optimizeTokens: true,      // Compress excessive whitespace (default: true)
  stealth: true,             // Enable browser stealth hardening when browser is used
  stealthLevel: "balanced",  // "basic" | "balanced" (default: "balanced")
  waitFor: ".main-content",  // CSS selector to wait for (browser mode)
});
```

### Crawling Multiple Pages

Crawl an entire website with configurable depth, page limits, and concurrency:

```typescript
const result = await AgentCrawl.crawl("https://docs.example.com", {
  maxDepth: 2,        // How many link-hops from start URL (default: 1)
  maxPages: 20,       // Stop after N pages (default: 10)
  concurrency: 4,     // Parallel requests (default: 2)
  extractMainContent: true,
});

console.log(`Crawled ${result.totalPages} pages`);
console.log(`Max depth reached: ${result.maxDepthReached}`);
result.pages.forEach(page => {
  console.log(`- ${page.title}: ${page.url}`);
});
```

## Configuration

### Scrape Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `mode` | `'hybrid'` \| `'static'` \| `'browser'` | `'hybrid'` | Strategy to use. `hybrid` tries static first, then browser. |
| `extractMainContent` | `boolean` | `false` | Extract only the main article body using Readability-like algorithm. |
| `optimizeTokens` | `boolean` | `true` | Remove extra whitespace and empty links for token efficiency. |
| `stealth` | `boolean` | `false` | Apply best-effort browser stealth hardening (browser mode only). |
| `stealthLevel` | `'basic'` \| `'balanced'` | `'balanced'` | Stealth profile strength when `stealth` is enabled. |
| `waitFor` | `string` | `undefined` | CSS selector to wait for (browser mode only). |
| `maxResponseBytes` | `number` | `undefined` | Best-effort cap for static fetch response size in bytes. |
| `httpCache` | `boolean \| { dir?, ttlMs?, maxEntries? }` | `undefined` | Opt-in disk HTTP cache for static fetch (ETag/Last-Modified). |
| `cache` | `boolean \| { dir?, ttlMs?, maxEntries? }` | `undefined` | Opt-in disk cache for processed scrape results (`ScrapedPage`). |
| `chunking` | `boolean \| { enabled?, maxTokens?, overlapTokens? }` | `undefined` | Opt-in token-aware chunking (`page.chunks`) with citation anchors. |

#### Disk Cache Example (HTTP + Processed Result)

```ts
const page = await AgentCrawl.scrape("https://example.com", {
  mode: "static",
  httpCache: { dir: ".cache/agent-crawl/http", ttlMs: 60_000, maxEntries: 1000 },
  cache: { dir: ".cache/agent-crawl", ttlMs: 5 * 60_000, maxEntries: 1000 },
});
```

#### Chunking Example (For Agent RAG/Tools)

```ts
const page = await AgentCrawl.scrape("https://example.com", {
  chunking: { enabled: true, maxTokens: 1200, overlapTokens: 100 },
});

// page.chunks: [{ id, text, approxTokens, headingPath, citation: { url, anchor } }, ...]
```

### Crawl Options

Crawl options include all scrape options plus:

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `maxDepth` | `number` | `1` | Maximum link depth to crawl from the start URL. |
| `maxPages` | `number` | `10` | Maximum number of pages to crawl. |
| `concurrency` | `number` | `2` | Number of pages to fetch in parallel. |
| `perHostConcurrency` | `number` | `concurrency` | Maximum concurrent requests per host. |
| `minDelayMs` | `number` | `0` | Minimum delay between requests to the same host. |
| `includePatterns` | `string[]` | `[]` | Only crawl URLs containing any of these substrings. |
| `excludePatterns` | `string[]` | `[]` | Do not crawl URLs containing any of these substrings. |
| `robots` | `boolean \| { enabled?, userAgent?, respectCrawlDelay? }` | `undefined` | Opt-in robots.txt compliance (Disallow/Allow + Crawl-delay). |
| `sitemap` | `boolean \| { enabled?, maxUrls? }` | `undefined` | Opt-in sitemap seeding from `/sitemap.xml`. |
| `crawlState` | `boolean \| { enabled?, dir?, id?, resume?, flushEvery?, persistPages? }` | `undefined` | Opt-in resumable crawl state persisted to disk. |

#### Polite Crawl Example (Robots + Sitemap + Throttling)

```ts
const result = await AgentCrawl.crawl("https://docs.example.com", {
  maxDepth: 2,
  maxPages: 100,
  concurrency: 6,
  perHostConcurrency: 2,
  minDelayMs: 250,
  robots: { enabled: true, userAgent: "agent-crawl", respectCrawlDelay: true },
  sitemap: { enabled: true, maxUrls: 1000 },
});
```

#### Resumable Crawl Example

```ts
const result = await AgentCrawl.crawl("https://docs.example.com", {
  maxDepth: 3,
  maxPages: 500,
  concurrency: 6,
  crawlState: {
    enabled: true,
    dir: ".cache/agent-crawl/state",
    id: "docs-example",
    resume: true,
    flushEvery: 5,
    persistPages: true,
  },
});
```

## Return Values

### `scrape()` → `ScrapedPage`

```typescript
{
  url: string;           // The final URL (after redirects)
  content: string;       // Clean markdown content
  title?: string;        // Page title
  links?: string[];      // Same-origin links found on the page
  chunks?: Array<{       // Present only when chunking is enabled
    id: string;
    text: string;
    approxTokens: number;
    headingPath: string[];
    citation: { url: string; anchor?: string };
  }>;
  metadata?: {
    status: number;      // HTTP status code
    contentLength: number;
    error?: string;      // Populated when scrape fails
    structured?: {       // Structured metadata from HTML (when present)
      canonicalUrl?: string;
      openGraph?: Record<string, string>;
      twitter?: Record<string, string>;
      jsonLd?: unknown[];
    };
    // ... other headers
  }
}
```

`scrape()` returns an empty `content` plus `metadata.error` for non-2xx responses or fetch/browser failures.

When browser rendering is used, metadata also includes:
- `stealthApplied: boolean`
- `stealthLevel?: "basic" | "balanced"` (when stealth is enabled)

## Stealth Mode (Best-Effort)

- Stealth is opt-in via `stealth: true`.
- It is applied only for browser rendering (`mode: "browser"` and hybrid browser fallback).
- It hardens common automation fingerprints (`navigator.webdriver`, language/plugins/platform hints, permission query behavior, and browser headers/profile).
- It is best-effort: some anti-bot systems may still block requests.

### `crawl()` → `CrawlResult`

```typescript
{
  pages: ScrapedPage[];  // Array of all scraped pages
  totalPages: number;    // Total number of pages crawled
  maxDepthReached: number; // Deepest level reached
  errors: Array<{        // Any errors encountered
    url: string;
    error: string;
  }>;
}
```

## License

MIT © silupanda
