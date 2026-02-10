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

### Crawl Options

Crawl options include all scrape options plus:

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `maxDepth` | `number` | `1` | Maximum link depth to crawl from the start URL. |
| `maxPages` | `number` | `10` | Maximum number of pages to crawl. |
| `concurrency` | `number` | `2` | Number of pages to fetch in parallel. |

## Return Values

### `scrape()` → `ScrapedPage`

```typescript
{
  url: string;           // The final URL (after redirects)
  content: string;       // Clean markdown content
  title?: string;        // Page title
  links?: string[];      // Same-origin links found on the page
  metadata?: {
    status: number;      // HTTP status code
    contentLength: number;
    error?: string;      // Populated when scrape fails
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
