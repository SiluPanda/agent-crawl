# Feature Gap Analysis: agent-crawl vs crawl4ai

Comparison of **agent-crawl** (TypeScript, this repo) against **crawl4ai** (Python, v0.8.6).

---

## Summary

agent-crawl is a focused, security-hardened TypeScript library optimized for AI agent token pipelines. crawl4ai is a mature, feature-rich Python ecosystem covering crawling, extraction, and serving. The gaps below reflect crawl4ai capabilities that agent-crawl does not yet have.

---

## Feature Gaps

### 1. Crawling Strategies

| Feature | crawl4ai | agent-crawl |
|---------|----------|-------------|
| BFS crawling | Yes | Yes |
| DFS crawling | `DFSDeepCrawlStrategy` | No |
| Best-first / priority crawling | `BestFirstCrawlingStrategy` with URL scoring | No |
| Adaptive crawling (auto-stop) | Information foraging algorithms (coverage, consistency, saturation scoring) | No |
| URL seeding from Common Crawl index | `AsyncUrlSeeder` with sitemap + Common Crawl | No |
| Crawl crash recovery with callbacks | `resume_state`, `on_state_change` | Partial (disk state, but no callbacks) |
| Crawl cancellation | `should_cancel` callback, `cancel()` method | No |
| Prefetch mode (fast URL discovery) | 5-10x faster discovery skipping content extraction | No |
| Streaming results (async iterator) | Yes, yields results as discovered | No (batch only) |
| Local file crawling (`file://`) | Yes | No |
| Raw HTML input (`raw://`) | Yes | No |
| Multi-URL batch crawling | `arun_many()` with dispatchers | No dedicated API |

### 2. Content Extraction

| Feature | crawl4ai | agent-crawl |
|---------|----------|-------------|
| CSS selector extraction | `JsonCssExtractionStrategy` with nested/list fields | No |
| XPath extraction | `JsonXPathExtractionStrategy` | No |
| Regex extraction | `RegexExtractionStrategy` with 20+ built-in patterns | No |
| LLM-based extraction | Provider-agnostic via LiteLLM (OpenAI, Anthropic, Gemini, etc.) | No |
| Knowledge graph extraction | Entity + relationship extraction via Pydantic models | No |
| Cosine similarity clustering | `CosineStrategy` with hierarchical clustering | No |
| Table extraction | Scoring-based + LLM-powered, export to CSV/JSON/DataFrame | No |
| Schema auto-generation | LLM generates reusable CSS/XPath schemas from HTML samples | No |
| Content filters (pruning, BM25) | `PruningContentFilter`, `BM25ContentFilter`, `LLMContentFilter` | No (only main-content extraction) |

### 3. Chunking Strategies

| Feature | crawl4ai | agent-crawl |
|---------|----------|-------------|
| Token-aware chunking | Yes | Yes |
| Regex-based chunking | `RegexChunking` | No |
| Sliding window chunking | `SlidingWindowChunking` | No |
| Fixed-length word chunking | `FixedLengthWordChunking` | No |
| Sentence-based chunking (NLP) | `SentenceBasedChunking` via NLTK | No |
| Topic segmentation chunking | `TopicSegmentationChunking` via TextTiling | No |

### 4. Browser Automation & Anti-Detection

| Feature | crawl4ai | agent-crawl |
|---------|----------|-------------|
| Multi-browser support | Chromium, Firefox, WebKit | Chromium only |
| CDP remote browser connections | Yes | No |
| Browser pool (warm/hot/cold) | Managed pool with pre-warmed pages | Singleton instance |
| Persistent browser contexts | `user_data_dir`, `storage_state` | No |
| 3-tier automatic anti-bot escalation | Proxy escalation with retry | Basic stealth only |
| Shadow DOM flattening | `flatten_shadow_dom` | No |
| Consent/cookie popup removal | `remove_consent_popups` | No |
| Modal/overlay removal | `remove_overlay_elements` | No |
| Infinite scroll handling | `scan_full_page`, `scroll_delay`, `max_scroll_steps` | No |
| Virtual scroll handling | `VirtualScrollConfig` | No |
| iframe processing | `process_iframes` | No |
| Human interaction simulation | `simulate_user` | No |
| `magic` mode (auto popup handling) | Yes (experimental) | No |
| Random user agent generation | `user_agent_mode="random"` | Fixed rotation of 6 UAs |

### 5. JavaScript & Page Interaction

| Feature | crawl4ai | agent-crawl |
|---------|----------|-------------|
| Post-load JS execution | `js_code` | No |
| Pre-wait JS execution | `js_code_before_wait` | No |
| C4A-Script DSL | Human-readable scripting language for web automation | No |
| Multi-step session crawling | Session persistence across steps (e.g., "Load More" flows) | No |

### 6. Output Formats & Data Capture

| Feature | crawl4ai | agent-crawl |
|---------|----------|-------------|
| Markdown output | Yes | Yes |
| Markdown with citations (footnotes) | `markdown_with_citations` | No (citations only in chunks) |
| Fit markdown (LLM-optimized) | `fit_markdown` with content filtering | Partial (`optimizeTokens`) |
| Screenshot capture | Base64 PNG | No |
| PDF generation | Rendered page as PDF | No |
| MHTML snapshot | Single-file archive | No |
| Network request capture | Full request/response/failure logging | No |
| Console message capture | Browser console output | No |
| SSL certificate extraction | JSON/PEM/DER export | No |
| File download support | `accept_downloads`, configurable path | No |
| Raw/cleaned/fit HTML variants | Three HTML output levels | No (markdown only) |

### 7. Markdown Generation

| Feature | crawl4ai | agent-crawl |
|---------|----------|-------------|
| Ignore links option | `ignore_links` | No |
| Ignore images option | `ignore_images` | No |
| Body width control | `body_width` | No |
| Skip internal links | `skip_internal_links` | No |
| Content source selection | `raw_html`, `cleaned_html`, `fit_html` | Single pipeline |
| Custom markdown generators | Pluggable strategy | No |

### 8. Authentication & Identity

| Feature | crawl4ai | agent-crawl |
|---------|----------|-------------|
| Cookie injection | `BrowserConfig.cookies` | No |
| Custom HTTP headers | Yes (auth tokens, etc.) | No (only User-Agent rotation) |
| Persistent auth state | `storage_state`, `user_data_dir` | No |
| Locale/timezone/geolocation spoofing | `locale`, `timezone_id`, `geolocation` | No |
| Browser profile management | Browser profiler for creating/managing profiles | No |

### 9. Proxy Support

| Feature | crawl4ai | agent-crawl |
|---------|----------|-------------|
| Proxy configuration | `ProxyConfig` with auth | No |
| Proxy rotation strategies | `ProxyRotationStrategy` | No |
| Per-crawl proxy config | Yes | No |
| Auto proxy escalation | 3-tier anti-bot system | No |

### 10. Hooks & Extensibility

| Feature | crawl4ai | agent-crawl |
|---------|----------|-------------|
| Lifecycle hooks | 8 hook points (browser created, before/after goto, etc.) | No |
| String-based hooks (API-safe) | Yes | No |
| Custom extraction strategies | Pluggable via base classes | No |
| Custom content filters | Pluggable via base classes | No |
| Custom chunking strategies | Pluggable via base classes | No |

### 11. Serving & Deployment

| Feature | crawl4ai | agent-crawl |
|---------|----------|-------------|
| REST API server | `/crawl`, `/crawl/stream`, `/crawl/job`, `/html`, `/screenshot`, `/pdf`, etc. | No |
| WebSocket streaming | Real-time data streaming | No |
| MCP server | SSE + WebSocket endpoints for Claude Code, OpenAI Agents, Cursor | No |
| Docker images | Multi-arch (AMD64/ARM64), GPU support, Docker Compose | No |
| Monitoring dashboard | Real-time `/monitor` with CPU/memory/browser pool stats | No |
| Health endpoint | `/monitor/health` | No |
| CLI tool | `crwl` command with YAML configs, multiple output formats | No |

### 12. Concurrency & Rate Limiting

| Feature | crawl4ai | agent-crawl |
|---------|----------|-------------|
| Per-host rate limiting | Yes | Yes |
| Memory-adaptive concurrency | `MemoryAdaptiveDispatcher` adjusts based on system RAM | No |
| Semaphore-based concurrency | `SemaphoreDispatcher` | No (fixed concurrency) |
| Exponential backoff with jitter | `RateLimiter` with configurable delays | Basic retry only |
| Rate limit code detection (429, 503) | Auto-detect and backoff | No |
| URL-specific config overrides | Pattern matching (glob, lambda, AND/OR) | No |

### 13. Media Handling

| Feature | crawl4ai | agent-crawl |
|---------|----------|-------------|
| Image extraction with metadata | Responsive formats, srcset, picture elements | No |
| Image relevance scoring | `image_score_threshold` | No |
| Audio/video extraction | Yes | No |
| Wait for images to load | `wait_for_images` | No |
| Lazy load handling | Scroll simulation | No |

### 14. Link Analysis

| Feature | crawl4ai | agent-crawl |
|---------|----------|-------------|
| Basic link discovery | Yes | Yes |
| Link quality scoring | `score_links` with metrics | No |
| External link filtering | `exclude_external_links` | No (same-origin only) |
| Social media link filtering | `exclude_social_media_links`, `exclude_social_media_domains` | No |
| Domain exclusion lists | `exclude_domains` | No |

---

## What agent-crawl Does Well (Relative Strengths)

| Feature | Notes |
|---------|-------|
| SSRF protection | Multi-layer defense: IPv4/IPv6 private ranges, DNS reserved zones, IPv4-mapped IPv6, octal/hex notation |
| Input/output sanitization | Dangerous protocol stripping, header security, request smuggling prevention |
| State file security | Atomic writes, size caps, schema validation, origin re-validation |
| Token-optimized output | Purpose-built for LLM context windows with heading-path citations |
| Hybrid fetch mode | Smart static-first with auto browser fallback (saves resources) |
| Zero-config caching | In-memory LRU + disk KV with HTTP ETag/Last-Modified support |
| TypeScript type safety | Zod schemas + TypeScript interfaces for config validation |
| Lightweight footprint | Minimal dependencies (cheerio, playwright-core, zod) |
| Structured metadata | Open Graph, Twitter Card, JSON-LD extraction built-in |

---

## Priority Gaps (Recommended Next Steps)

1. ~~**Structured data extraction** (CSS/XPath/regex strategies) -- highest value, LLM-free~~ **DONE in v3.1.0**
2. ~~**Proxy support** -- essential for production crawling at scale~~ **DONE in v3.2.0**
3. ~~**Custom headers / cookie injection** -- required for authenticated crawling~~ **DONE in v3.2.0**
4. ~~**JavaScript execution** -- post-load JS for interactive pages~~ **DONE in v3.3.0**
5. ~~**Screenshot/PDF capture** -- useful for visual verification and archival~~ **DONE in v3.4.0**
6. ~~**DFS + priority crawling strategies** -- better crawl efficiency~~ **DONE in v3.5.0**
7. ~~**Hooks/plugin system** -- extensibility for custom use cases~~ **DONE in v3.6.0**
8. ~~**CLI tool** -- developer ergonomics~~ **DONE in v3.7.0**
9. ~~**Infinite scroll / lazy load handling** -- modern SPA support~~ **DONE in v3.8.0**
10. ~~**MCP server** -- direct integration with AI coding tools~~ **DONE in v3.9.0**
