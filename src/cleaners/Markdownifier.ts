import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import * as cheerio from 'cheerio';

export interface MarkdownifierOptions {
    extractMainContent?: boolean;
    optimizeTokens?: boolean;
}

export interface ExtractedContent {
    title: string;
    links: string[];
    markdown: string;
}

/**
 * Converts HTML to clean, token-optimized Markdown.
 * Includes noise reduction (ads, scripts) and main content extraction.
 */
export class Markdownifier {
    private turndownService: TurndownService;

    constructor() {
        this.turndownService = new TurndownService({
            codeBlockStyle: 'fenced',
            headingStyle: 'atx',
            // Strip HTML tags that can't be converted cleanly
            emDelimiter: '*',
            strongDelimiter: '**',
        });

        // Enable GFM tables, strikethrough, and task lists
        this.turndownService.use(gfm);

        // Custom rule to strip decorative links but keep semantic ones
        this.turndownService.addRule('semanticLinks', {
            filter: (node) => {
                return node.nodeName === 'A' &&
                    (!node.textContent || node.textContent.trim().length === 0);
            },
            replacement: () => '' // Strip empty/decorative links
        });

        // Strip images entirely or keep only alt text for LLM consumption
        this.turndownService.addRule('stripImages', {
            filter: 'img',
            replacement: (_content, node) => {
                const alt = (node as HTMLElement).getAttribute('alt');
                // Only keep meaningful alt text (not empty, not just file names)
                if (alt && alt.length > 3 && !alt.match(/\.(png|jpg|jpeg|gif|svg|webp)$/i)) {
                    return `[Image: ${alt}]`;
                }
                return '';
            }
        });

        // Strip srcset and other heavy attributes from any remaining HTML
        this.turndownService.addRule('cleanupHtml', {
            filter: (node) => {
                // Clean up any element that has srcset
                return node.nodeType === 1 && (node as HTMLElement).hasAttribute('srcset');
            },
            replacement: (_content, node) => {
                // Just return the text content
                return (node as HTMLElement).textContent || '';
            }
        });

        // Remove figure/figcaption if they only contain images
        this.turndownService.addRule('stripFigures', {
            filter: 'figure',
            replacement: (content) => {
                // If content is empty or only whitespace after image removal, skip
                const cleaned = content.replace(/\[Image:.*?\]/g, '').trim();
                return cleaned ? cleaned + '\n\n' : '';
            }
        });

        // Keep table structure - let GFM plugin handle table conversion
        this.turndownService.keep(['table', 'thead', 'tbody', 'tr', 'th', 'td']);
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
     * Extract main content using content scoring
     */
    private extractMainContent(html: string): string {
        const $ = cheerio.load(html);
        const candidates: Array<{ element: cheerio.Element, score: number }> = [];

        // Find all potential content containers
        $('div, article, section, main').each((_, elem) => {
            const score = this.scoreContentBlock($, elem);
            if (score > 0) {
                candidates.push({ element: elem, score });
            }
        });

        // Sort by score and take the best
        candidates.sort((a, b) => b.score - a.score);

        if (candidates.length > 0) {
            return $(candidates[0].element).html() || '';
        }

        // Fallback to body if no good candidate
        return $('body').html() || '';
    }

    /**
     * Extract title from HTML
     */
    extractTitle(html: string): string {
        const $ = cheerio.load(html);

        // Try multiple strategies
        const title = $('title').first().text() ||
            $('meta[property="og:title"]').attr('content') ||
            $('meta[name="twitter:title"]').attr('content') ||
            $('h1').first().text() ||
            '';

        return title.trim();
    }

    /**
     * Extract all absolute links from HTML
     */
    extractLinks(html: string, baseUrl: string): string[] {
        const $ = cheerio.load(html);
        const links = new Set<string>();

        let baseOrigin: string;
        try {
            baseOrigin = new URL(baseUrl).origin;
        } catch {
            return []; // Invalid base URL, return empty
        }

        $('a[href]').each((_, elem) => {
            const href = $(elem).attr('href');
            if (!href) return;

            try {
                // Resolve relative URLs to absolute
                const absoluteUrl = new URL(href, baseUrl).href;

                // Only keep http(s) links
                if (!absoluteUrl.startsWith('http')) return;

                // Remove hash fragments
                const cleanUrl = absoluteUrl.split('#')[0];

                // Check if same origin (optional, but good default practice for crawler)
                if (cleanUrl.startsWith(baseOrigin)) {
                    links.add(cleanUrl);
                }
            } catch (e) {
                // Invalid URL, ignore
            }
        });

        return Array.from(links);
    }

    cleanHtml(html: string, options: MarkdownifierOptions = {}): string {
        const $ = cheerio.load(html);

        // Module B: The Cleaner (NoiseReducer)
        $('script').remove();
        $('style').remove();
        $('svg').remove();
        $('[style*="display: none"]').remove();
        $('[style*="visibility: hidden"]').remove();

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

        // Remove images with srcset (complex responsive images)
        $('img[srcset]').remove();

        // Strip all class and style attributes for cleaner output
        $('*').removeAttr('class').removeAttr('style').removeAttr('srcset');

        // Extract main content if requested
        if (options.extractMainContent) {
            const mainContent = this.extractMainContent($.html());
            return mainContent;
        }

        return $.html();
    }

    /**
     * Optimize markdown for token efficiency
     */
    private optimizeTokens(markdown: string): string {
        // Remove excessive whitespace
        markdown = markdown.replace(/\n{3,}/g, '\n\n'); // Max 2 consecutive newlines
        markdown = markdown.replace(/[ \t]+/g, ' '); // Collapse spaces

        // Remove empty links
        markdown = markdown.replace(/\[]\(\)/g, '');

        // Trim lines
        markdown = markdown.split('\n').map(line => line.trim()).join('\n');

        // Remove repetitive patterns (like navigation items)
        // This is a simple heuristic - could be enhanced
        const lines = markdown.split('\n');
        const uniqueLines: string[] = [];
        const seen = new Set<string>();

        for (const line of lines) {
            // Keep headers and non-repetitive content
            if (line.startsWith('#') || !seen.has(line) || line.length > 100) {
                uniqueLines.push(line);
                if (line.length < 100) seen.add(line);
            }
        }

        return uniqueLines.join('\n').trim();
    }

    convert(html: string, options: MarkdownifierOptions = {}): string {
        const cleanedHtml = this.cleanHtml(html, options);
        let markdown = this.turndownService.turndown(cleanedHtml);

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
        const $ = cheerio.load(html);

        // Extract title (single parse)
        const title = $('title').first().text() ||
            $('meta[property="og:title"]').attr('content') ||
            $('meta[name="twitter:title"]').attr('content') ||
            $('h1').first().text() ||
            '';

        // Extract links (before cleaning removes elements)
        const links = new Set<string>();
        let baseOrigin: string;
        try {
            baseOrigin = new URL(baseUrl).origin;
            $('a[href]').each((_, elem) => {
                const href = $(elem).attr('href');
                if (!href) return;
                try {
                    const absoluteUrl = new URL(href, baseUrl).href;
                    if (!absoluteUrl.startsWith('http')) return;
                    const cleanUrl = absoluteUrl.split('#')[0];
                    if (cleanUrl.startsWith(baseOrigin)) {
                        links.add(cleanUrl);
                    }
                } catch {
                    // Invalid URL, ignore
                }
            });
        } catch {
            // Invalid base URL
        }

        // Clean HTML (reusing cheerio instance)
        $('script, style, svg').remove();
        $('[style*="display: none"], [style*="visibility: hidden"]').remove();
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

        // Strip all class and style attributes for cleaner output
        $('*').removeAttr('class').removeAttr('style').removeAttr('srcset');

        // Simplify tables: if a table has complex classes or nested tables, convert to text
        $('table').each((_, table) => {
            const $table = $(table);
            // If table has nested tables or too many attributes, replace with text
            if ($table.find('table').length > 0) {
                const text = $table.text().replace(/\s+/g, ' ').trim();
                $table.replaceWith(`<p>${text}</p>`);
            }
        });

        let cleanedHtml: string;
        if (options.extractMainContent) {
            cleanedHtml = this.extractMainContentFromCheerio($);
        } else {
            cleanedHtml = $.html();
        }

        // Convert to markdown
        let markdown = this.turndownService.turndown(cleanedHtml);

        // LLM-friendly post-processing
        markdown = this.cleanForLLM(markdown);

        if (options.optimizeTokens) {
            markdown = this.optimizeTokens(markdown);
        }

        return {
            title: title.trim(),
            links: Array.from(links),
            markdown,
        };
    }

    /**
     * Extract main content from an existing cheerio instance
     */
    private extractMainContentFromCheerio($: ReturnType<typeof cheerio.load>): string {
        const candidates: Array<{ element: cheerio.Element, score: number }> = [];

        $('div, article, section, main').each((_, elem) => {
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
        cleaned = cleaned.replace(/\|\s*\n?\s*\*\s*\[v\]\([^)]*\)\s*\n?\s*\*\s*\[t\]\([^)]*\)\s*\n?\s*\*\s*\[e\]\([^)]*\)/gi, '');
        cleaned = cleaned.replace(/\[v\]\([^)]*\)\s*[·•|]\s*\[t\]\([^)]*\)\s*[·•|]\s*\[e\]\([^)]*\)/gi, '');

        // Remove "Retrieved from" Wikipedia footers
        cleaned = cleaned.replace(/Retrieved from "[^"]*"/gi, '');

        // Remove Wikipedia category links
        cleaned = cleaned.replace(/\[Categories?\]\([^)]*\):[^\n]*/gi, '');

        // Clean up multiple consecutive blank lines
        cleaned = cleaned.replace(/\n{4,}/g, '\n\n\n');

        // Remove lines that are just pipe characters (table remnants)
        cleaned = cleaned.replace(/^\s*\|[\s|]*\|?\s*$/gm, '');

        // Clean up orphaned list markers
        cleaned = cleaned.replace(/^\s*\*\s*$/gm, '');

        return cleaned.trim();
    }
}
