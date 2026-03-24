import { NodeHtmlMarkdown } from 'node-html-markdown';
import * as cheerio from 'cheerio';

export interface MarkdownifierOptions {
    extractMainContent?: boolean;
    optimizeTokens?: boolean;
}

export interface ExtractedContent {
    title: string;
    links: string[];
    markdown: string;
    structured?: {
        canonicalUrl?: string;
        openGraph?: Record<string, string>;
        twitter?: Record<string, string>;
        jsonLd?: unknown[];
    };
}

// Maximum HTML input size (20MB) — prevents excessive memory use in cheerio/markdown conversion
const MAX_HTML_INPUT_BYTES = 20 * 1024 * 1024;

// Maximum title length — prevents OOM from malicious <title> tags
const MAX_TITLE_LENGTH = 2000;

// Dangerous URL protocols that should be stripped to prevent XSS in markdown output
const DANGEROUS_PROTOCOLS = /^(javascript|data|vbscript|blob):/i;

/**
 * Converts HTML to clean, token-optimized Markdown.
 * Includes noise reduction (ads, scripts) and main content extraction.
 */
export class Markdownifier {
    private markdownConverter: NodeHtmlMarkdown;

    constructor() {
        this.markdownConverter = new NodeHtmlMarkdown({
            codeBlockStyle: 'fenced',
            bulletMarker: '*',
            emDelimiter: '*',
            strongDelimiter: '**',
            strikeDelimiter: '~~',
            maxConsecutiveNewlines: 3,
            useInlineLinks: false,
            textReplace: [
                [/\u00A0/g, ' '], // Normalize non-breaking spaces
            ],
        });
    }

    private escapeHtml(value: string): string {
        return value
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    /**
     * Pre-normalize links/images before markdown conversion.
     * This preserves prior behavior previously implemented via Turndown custom rules.
     */
    private normalizeLinksAndImages($: ReturnType<typeof cheerio.load>): void {
        // Remove decorative/empty links and strip dangerous protocols
        $('a').each((_, elem) => {
            const $link = $(elem);
            const text = $link.text().trim();
            const href = ($link.attr('href') || '').trim();

            if (!text) {
                $link.remove();
                return;
            }

            // Strip dangerous protocols (javascript:, data:, vbscript:, blob:)
            // to prevent XSS if markdown output is rendered by consumers
            if (href && DANGEROUS_PROTOCOLS.test(href)) {
                $link.replaceWith(this.escapeHtml(text));
                return;
            }

            // Keep readable text even if href is malformed/empty.
            // Escape to prevent injecting HTML from link text content.
            if (!href) {
                $link.replaceWith(this.escapeHtml(text));
            }
        });

        // Replace meaningful images with alt text and drop decorative images.
        $('img').each((_, elem) => {
            const $img = $(elem);
            const alt = ($img.attr('alt') || '').trim();
            if (alt && alt.length > 3 && !alt.match(/\.(png|jpg|jpeg|gif|svg|webp)$/i)) {
                $img.replaceWith(`<span>[Image: ${this.escapeHtml(alt)}]</span>`);
            } else {
                $img.remove();
            }
        });

        // Drop figure blocks that became empty after image normalization.
        $('figure').each((_, elem) => {
            const $figure = $(elem);
            const cleaned = $figure.text().replace(/\[Image:.*?\]/g, '').trim();
            if (!cleaned) {
                $figure.remove();
            }
        });
    }

    /**
     * Scores content blocks for main content extraction
     * Based on Readability.js algorithm principles.
     * Higher score = more likely to be the main article content.
     */
    private scoreContentBlock($: ReturnType<typeof cheerio.load>, element: cheerio.Element): number {
        let score = 0;
        const $elem = $(element);
        const text = $elem.text();

        // Positive signals
        score += Math.min(text.length / 100, 10); // Long text is good
        score += ($elem.find('p').length) * 2; // Paragraphs are good
        score += ($elem.find('article').length) * 5; // Article tags are very good

        // Negative signals
        score -= ($elem.find('form').length) * 3; // Forms are usually not content
        score -= ($elem.find('input').length) * 2; // Inputs are not content

        // Check class/id names for common boilerplate patterns
        const classAndId = ($elem.attr('class') || '') + ($elem.attr('id') || '');
        if (/comment|sidebar|footer|header|nav|menu/i.test(classAndId)) score -= 3;
        if (/content|article|main|post|entry/i.test(classAndId)) score += 5;

        return score;
    }

    /**
     * Extract title from HTML
     */
    extractTitle(html: string): string {
        if (html.length > MAX_HTML_INPUT_BYTES) html = html.slice(0, MAX_HTML_INPUT_BYTES);
        const $ = cheerio.load(html);

        // Try multiple strategies
        const title = $('title').first().text() ||
            $('meta[property="og:title"]').attr('content') ||
            $('meta[name="twitter:title"]').attr('content') ||
            $('h1').first().text() ||
            '';

        const trimmed = title.trim();
        return trimmed.length > MAX_TITLE_LENGTH ? trimmed.slice(0, MAX_TITLE_LENGTH) : trimmed;
    }

    /**
     * Extract all absolute links from HTML
     */
    extractLinks(html: string, baseUrl: string): string[] {
        if (html.length > MAX_HTML_INPUT_BYTES) html = html.slice(0, MAX_HTML_INPUT_BYTES);
        const $ = cheerio.load(html);
        const links = new Set<string>();
        const maxLinks = 10_000;

        let baseOrigin: string;
        try {
            baseOrigin = new URL(baseUrl).origin;
        } catch {
            return []; // Invalid base URL, return empty
        }

        $('a[href]').each((_, elem) => {
            if (links.size >= maxLinks) return false; // stop iteration
            const href = $(elem).attr('href');
            if (!href) return;
            if (DANGEROUS_PROTOCOLS.test(href.trim())) return;

            try {
                const parsed = new URL(href, baseUrl);
                if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return;
                // Same-origin check via parsed origin, NOT string prefix
                // (startsWith is fooled by userinfo: example.com@evil.com or subdomain: example.com.evil.com)
                if (parsed.origin !== baseOrigin) return;
                parsed.hash = '';
                links.add(parsed.href);
            } catch {
                // Invalid URL, ignore
            }
        });

        return Array.from(links);
    }

    cleanHtml(html: string, options: MarkdownifierOptions = {}): string {
        if (html.length > MAX_HTML_INPUT_BYTES) {
            html = html.slice(0, MAX_HTML_INPUT_BYTES);
        }
        const $ = cheerio.load(html);

        // Module B: The Cleaner (NoiseReducer)
        $('script').remove();
        $('style').remove();
        $('svg').remove();
        $('[style*="display: none"], [style*="display:none"]').remove();
        $('[style*="visibility: hidden"], [style*="visibility:hidden"]').remove();

        // Remove common non-content elements
        $('nav').remove();
        $('footer').remove();
        $('header').remove();
        $('.advertisement, .ad, [class*="social"]').remove();

        // Remove cookie consent banners and GDPR notices
        $('[class*="cookie"], [id*="cookie"], [class*="consent"], [id*="consent"]').remove();
        $('[class*="gdpr"], [id*="gdpr"], [class*="privacy-banner"], [id*="privacy-banner"]').remove();
        $('.cc-banner, .cc-window, #CybotCookiebotDialog, #onetrust-consent-sdk').remove();
        $('[aria-label*="cookie"], [aria-label*="consent"]').remove();

        // LLM-friendly cleaning: Remove visually hidden content
        $('.vh, .visually-hidden, .sr-only, .screen-reader-only').remove();
        $('[aria-hidden="true"]').remove();
        $('[class*="hidden"]').each((_, el) => {
            const className = $(el).attr('class') || '';
            if (/\b(hidden|visually-hidden)\b/i.test(className)) {
                $(el).remove();
            }
        });

        // Remove images with srcset (complex responsive images)
        $('img[srcset]').remove();

        this.normalizeLinksAndImages($);

        // Extract main content BEFORE stripping class/id attributes, since
        // scoring relies on class/id heuristics (e.g. "article", "sidebar").
        let result: string;
        if (options.extractMainContent) {
            result = this.extractMainContentFromCheerio($);
        } else {
            result = $.html();
        }

        // Strip all class and style attributes for cleaner output
        const $clean = cheerio.load(result);
        $clean('*').removeAttr('class').removeAttr('style').removeAttr('srcset');
        return $clean.html();
    }

    /**
     * Optimize markdown for token efficiency
     */
    private optimizeTokens(markdown: string): string {
        // Split into code blocks and non-code segments to preserve code formatting.
        // Uses indexOf-based scanning instead of regex to avoid ReDoS on large inputs
        // with unmatched ``` markers.
        const parts: string[] = [];
        let scanPos = 0;
        while (scanPos < markdown.length) {
            const openIdx = markdown.indexOf('```', scanPos);
            if (openIdx === -1) {
                parts.push(markdown.slice(scanPos));
                break;
            }
            // Find end of opening fence line
            let fenceEnd = markdown.indexOf('\n', openIdx + 3);
            if (fenceEnd === -1) {
                parts.push(markdown.slice(scanPos));
                break;
            }
            const closeIdx = markdown.indexOf('\n```', fenceEnd);
            if (closeIdx === -1) {
                parts.push(markdown.slice(scanPos));
                break;
            }
            // Push text before code block as non-code, then the code block itself
            if (openIdx > scanPos) parts.push(markdown.slice(scanPos, openIdx));
            const blockEnd = closeIdx + 4; // +4 for \n```
            // Skip optional language info after closing ```
            let blockEndFull = blockEnd;
            while (blockEndFull < markdown.length && markdown[blockEndFull] !== '\n') blockEndFull++;
            parts.push(markdown.slice(openIdx, blockEndFull));
            scanPos = blockEndFull;
        }
        const optimized = parts.map((part) => {
            // Code blocks start with ``` — preserve as-is
            if (part.startsWith('```')) return part;

            // Non-code content: apply whitespace optimization
            let text = part;
            text = text.replace(/\n{3,}/g, '\n\n'); // Max 2 consecutive newlines
            text = text.replace(/[ \t]+/g, ' '); // Collapse spaces
            text = text.replace(/\[]\(\)/g, ''); // Remove empty links
            text = text.split('\n').map(line => line.trim()).join('\n');
            return text;
        });
        markdown = optimized.join('');

        // Remove repetitive patterns (like navigation items)
        const lines = markdown.split('\n');
        const uniqueLines: string[] = [];
        const seen = new Set<string>();
        const maxSeenSize = 50_000; // Cap to prevent excessive memory use
        const maxOutputLines = 500_000; // Cap output lines to prevent memory exhaustion
        let inCodeBlock = false;

        for (const line of lines) {
            if (uniqueLines.length >= maxOutputLines) break;

            // Track code block boundaries for dedup skipping
            if (line.startsWith('```')) inCodeBlock = !inCodeBlock;

            // Never deduplicate inside code blocks or code block markers themselves
            if (inCodeBlock || line === '' || line.startsWith('#') || line.startsWith('```') || !seen.has(line) || line.length > 100) {
                uniqueLines.push(line);
                if (!inCodeBlock && !line.startsWith('```') && line.length > 0 && line.length < 100 && seen.size < maxSeenSize) {
                    seen.add(line);
                }
            }
        }

        return uniqueLines.join('\n').trim();
    }

    convert(html: string, options: MarkdownifierOptions = {}): string {
        const cleanedHtml = this.cleanHtml(html, options);
        let markdown = this.markdownConverter.translate(cleanedHtml);

        markdown = this.cleanForLLM(markdown);

        if (options.optimizeTokens) {
            markdown = this.optimizeTokens(markdown);
        }

        return markdown;
    }

    /**
     * Optimized batch extraction - parses HTML only once for all operations.
     * Use this instead of calling extractTitle, extractLinks, and convert separately.
     */
    extractAll(html: string, baseUrl: string, options: MarkdownifierOptions = {}): ExtractedContent {
        if (html.length > MAX_HTML_INPUT_BYTES) {
            html = html.slice(0, MAX_HTML_INPUT_BYTES);
        }
        const $ = cheerio.load(html);

        // Structured metadata (JSON-LD / OpenGraph / Twitter / canonical).
        // Use Object.create(null) to prevent prototype pollution from malicious meta tags
        // (e.g. <meta property="__proto__" content="...">)
        const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
        const MAX_META_ENTRIES = 100;
        const MAX_META_VALUE_LENGTH = 4096;
        const MAX_META_KEY_LENGTH = 200;
        const openGraph: Record<string, string> = Object.create(null);
        const twitter: Record<string, string> = Object.create(null);
        let ogCount = 0;
        $('meta[property^="og:"]').each((_, el) => {
            if (ogCount >= MAX_META_ENTRIES) return false;
            const rawKey = ($(el).attr('property') || '').trim();
            const rawValue = ($(el).attr('content') || '').trim();
            if (!rawKey || !rawValue || DANGEROUS_KEYS.has(rawKey)) return;
            const key = rawKey.length > MAX_META_KEY_LENGTH ? rawKey.slice(0, MAX_META_KEY_LENGTH) : rawKey;
            const value = rawValue.length > MAX_META_VALUE_LENGTH ? rawValue.slice(0, MAX_META_VALUE_LENGTH) : rawValue;
            openGraph[key] = value; ogCount++;
        });
        let twCount = 0;
        $('meta[name^="twitter:"]').each((_, el) => {
            if (twCount >= MAX_META_ENTRIES) return false;
            const rawKey = ($(el).attr('name') || '').trim();
            const rawValue = ($(el).attr('content') || '').trim();
            if (!rawKey || !rawValue || DANGEROUS_KEYS.has(rawKey)) return;
            const key = rawKey.length > MAX_META_KEY_LENGTH ? rawKey.slice(0, MAX_META_KEY_LENGTH) : rawKey;
            const value = rawValue.length > MAX_META_VALUE_LENGTH ? rawValue.slice(0, MAX_META_VALUE_LENGTH) : rawValue;
            twitter[key] = value; twCount++;
        });
        const rawCanonical = ($('link[rel="canonical"]').attr('href') || '').trim();
        let canonicalUrl: string | undefined;
        if (rawCanonical && rawCanonical.length <= 8192) {
            try {
                const cu = new URL(rawCanonical, baseUrl);
                if ((cu.protocol === 'http:' || cu.protocol === 'https:') && cu.href.length <= 8192) {
                    canonicalUrl = cu.href;
                }
            } catch {
                // Malformed canonical URL — drop it
            }
        }

        const jsonLd: unknown[] = [];
        const maxJsonLdBlocks = 50;
        const maxJsonLdTotalChars = 2_000_000; // 2MB total cap for all JSON-LD blocks
        let jsonLdTotalChars = 0;
        $('script[type="application/ld+json"]').each((_, el) => {
            if (jsonLd.length >= maxJsonLdBlocks) return false;
            if (jsonLdTotalChars >= maxJsonLdTotalChars) return false;
            const text = $(el).text().trim();
            if (!text || text.length > 500_000) return; // Skip huge individual blocks (500KB)
            try {
                const parsed = JSON.parse(text);
                jsonLdTotalChars += text.length;
                if (Array.isArray(parsed)) {
                    for (const item of parsed.slice(0, maxJsonLdBlocks - jsonLd.length)) {
                        jsonLd.push(item);
                    }
                } else {
                    jsonLd.push(parsed);
                }
            } catch {
                // ignore invalid JSON-LD blocks
            }
        });

        // Extract title (single parse)
        const title = $('title').first().text() ||
            $('meta[property="og:title"]').attr('content') ||
            $('meta[name="twitter:title"]').attr('content') ||
            $('h1').first().text() ||
            '';

        // Extract links (before cleaning removes elements)
        const links = new Set<string>();
        const maxLinks = 10_000; // Cap to prevent memory issues on link-heavy pages
        let baseOrigin: string;
        try {
            baseOrigin = new URL(baseUrl).origin;
            $('a[href]').each((_, elem) => {
                if (links.size >= maxLinks) return false; // stop iteration
                const href = $(elem).attr('href');
                if (!href) return;
                // Skip dangerous protocols before attempting URL parse
                if (DANGEROUS_PROTOCOLS.test(href.trim())) return;
                try {
                    const parsed = new URL(href, baseUrl);
                    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return;
                    if (parsed.origin !== baseOrigin) return;
                    parsed.hash = '';
                    links.add(parsed.href);
                } catch {
                    // Invalid URL, ignore
                }
            });
        } catch {
            // Invalid base URL
        }

        // Clean HTML (reusing cheerio instance)
        $('script, style, svg').remove();
        $('[style*="display: none"], [style*="display:none"], [style*="visibility: hidden"], [style*="visibility:hidden"]').remove();
        $('nav, footer, header').remove();
        $('.advertisement, .ad, [class*="social"]').remove();

        // Remove cookie consent banners and GDPR notices
        $('[class*="cookie"], [id*="cookie"], [class*="consent"], [id*="consent"]').remove();
        $('[class*="gdpr"], [id*="gdpr"], [class*="privacy-banner"], [id*="privacy-banner"]').remove();
        $('.cc-banner, .cc-window, #CybotCookiebotDialog, #onetrust-consent-sdk').remove();
        $('[aria-label*="cookie"], [aria-label*="consent"]').remove();

        // LLM-friendly cleaning: Remove visually hidden content
        $('.vh, .visually-hidden, .sr-only, .screen-reader-only').remove();
        $('[aria-hidden="true"]').remove();
        $('[class*="hidden"]').each((_, el) => {
            const className = $(el).attr('class') || '';
            // Only remove if it's a visibility class, not "hidden-feature" etc
            if (/\b(hidden|visually-hidden)\b/i.test(className)) {
                $(el).remove();
            }
        });

        // Remove images with srcset (complex responsive images)
        $('img[srcset]').remove();

        this.normalizeLinksAndImages($);

        // Remove Wikipedia-style navboxes and templates (|v|t|e navigation)
        $('[role="navigation"]').remove();
        $('table').each((_, table) => {
            const $table = $(table);
            const text = $table.text();
            // Remove navboxes (contain v·t·e or v|t|e patterns)
            if (/\b[vV]\s*[·•|]\s*[tT]\s*[·•|]\s*[eE]\b/.test(text)) {
                $table.remove();
            }
        });

        // Simplify tables: if a table has nested tables, convert to text
        $('table').each((_, table) => {
            const $table = $(table);
            if ($table.find('table').length > 0) {
                const text = $table.text().replace(/\s+/g, ' ').trim();
                $table.replaceWith(`<p>${this.escapeHtml(text)}</p>`);
            }
        });

        // Extract main content BEFORE stripping class/id attributes, since
        // scoring relies on class/id heuristics (e.g. "article", "sidebar").
        let cleanedHtml: string;
        if (options.extractMainContent) {
            cleanedHtml = this.extractMainContentFromCheerio($);
        } else {
            cleanedHtml = $.html();
        }

        // Strip all class and style attributes for cleaner markdown output.
        // Done after main content extraction so scoring heuristics still work.
        const $clean = cheerio.load(cleanedHtml);
        $clean('*').removeAttr('class').removeAttr('style').removeAttr('srcset');
        cleanedHtml = $clean.html();

        // Convert to markdown
        let markdown = this.markdownConverter.translate(cleanedHtml);

        // LLM-friendly post-processing
        markdown = this.cleanForLLM(markdown);

        if (options.optimizeTokens) {
            markdown = this.optimizeTokens(markdown);
        }

        const trimmedTitle = title.trim();
        return {
            title: trimmedTitle.length > MAX_TITLE_LENGTH ? trimmedTitle.slice(0, MAX_TITLE_LENGTH) : trimmedTitle,
            links: Array.from(links),
            markdown,
            structured: {
                canonicalUrl,
                openGraph: Object.keys(openGraph).length ? openGraph : undefined,
                twitter: Object.keys(twitter).length ? twitter : undefined,
                jsonLd: jsonLd.length ? jsonLd : undefined,
            },
        };
    }

    /**
     * Extract main content from an existing cheerio instance
     */
    private extractMainContentFromCheerio($: ReturnType<typeof cheerio.load>): string {
        const candidates: Array<{ element: cheerio.Element, score: number }> = [];
        // Cap candidates to prevent O(n²) scoring on deeply nested DOMs.
        // Each candidate's .text() traverses its subtree, so scoring thousands is expensive.
        const MAX_CANDIDATES = 200;

        $('div, article, section, main').each((_, elem) => {
            if (candidates.length >= MAX_CANDIDATES) return false; // stop iteration
            const score = this.scoreContentBlock($, elem);
            if (score > 0) {
                candidates.push({ element: elem, score });
            }
        });

        candidates.sort((a, b) => b.score - a.score);

        if (candidates.length > 0) {
            return $(candidates[0].element).html() || '';
        }

        return $('body').html() || '';
    }

    /**
     * Clean markdown for LLM consumption
     * Removes Wikipedia-style citations, navbox remnants, and other noise
     */
    private cleanForLLM(markdown: string): string {
        let cleaned = markdown;

        // Remove Wikipedia-style citation references like [\[1\]](#cite_note-1) or \[1\]
        cleaned = cleaned.replace(/\\\[\d+\\\]/g, '');
        cleaned = cleaned.replace(/\[\\\[\d+\\\]\]\([^)]*\)/g, '');
        cleaned = cleaned.replace(/\[\[(\d+|[a-z])\]\]\([^)]*\)/g, '');

        // Remove empty citation links like [](#cite_note-...) or [](#cite_ref-...)
        cleaned = cleaned.replace(/\[\]\(#cite[^)]*\)/g, '');
        cleaned = cleaned.replace(/\[\]\(#[^)]*\)/g, '');

        // Remove remaining citation-style links like [a], [b], [c] references
        cleaned = cleaned.replace(/\\\[([a-z])\\\]/g, '');
        cleaned = cleaned.replace(/\[\\\[([a-z])\\\]\]\([^)]*\)/g, '');

        // Remove "Jump to content" and similar skip links
        cleaned = cleaned.replace(/\[Jump to [^\]]+\]\([^)]*\)/gi, '');
        cleaned = cleaned.replace(/\[Skip to [^\]]+\]\([^)]*\)/gi, '');

        // Remove navbox patterns that might have leaked through (v·t·e, v|t|e)
        // Note: use \s* without \n? to avoid overlapping quantifiers (ReDoS risk)
        cleaned = cleaned.replace(/\|\s*\*\s*\[v\]\([^)]*\)\s*\*\s*\[t\]\([^)]*\)\s*\*\s*\[e\]\([^)]*\)/gi, '');
        cleaned = cleaned.replace(/\[v\]\([^)]*\)\s*[·•|]\s*\[t\]\([^)]*\)\s*[·•|]\s*\[e\]\([^)]*\)/gi, '');

        // Remove "Retrieved from" Wikipedia footers
        cleaned = cleaned.replace(/Retrieved from "[^"]*"/gi, '');

        // Remove Wikipedia category links
        cleaned = cleaned.replace(/\[Categories?\]\([^)]*\):[^\n]*/gi, '');

        // Clean up multiple consecutive blank lines
        cleaned = cleaned.replace(/\n{4,}/g, '\n\n\n');

        // Remove lines that are just pipe characters and whitespace (table remnants).
        // Uses atomic-like pattern: match only pipes/spaces/tabs, no overlapping quantifiers.
        cleaned = cleaned.replace(/^[\s|]+$/gm, (m) => /\|/.test(m) ? '' : m);

        // Clean up orphaned list markers
        cleaned = cleaned.replace(/^\s*\*\s*$/gm, '');

        return cleaned.trim();
    }
}
