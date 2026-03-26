import * as cheerio from 'cheerio';
import type { CssFieldDef, CssExtractionConfig, RegexExtractionConfig } from '../types.js';

type $ = ReturnType<typeof cheerio.load>;

const MAX_RESULTS_PER_FIELD = 10_000;
const MAX_TEXT_LENGTH = 100_000;
const MAX_NESTING_DEPTH = 5;

/** Common regex patterns for convenience. */
export const BUILTIN_PATTERNS = {
    email: '[\\w.+-]+@[\\w.-]+\\.[a-zA-Z]{2,}',
    phone: '\\+?\\d[\\d\\s\\-()]{7,}\\d',
    url: 'https?://[^\\s<>"{}|\\\\^`\\[\\]]+',
    price: '[$£€]\\s?[\\d,]+\\.?\\d{0,2}',
    dateIso: '\\d{4}-\\d{2}-\\d{2}',
    ipv4: '(?:25[0-5]|2[0-4]\\d|[01]?\\d\\d?)\\.(?:25[0-5]|2[0-4]\\d|[01]?\\d\\d?)\\.(?:25[0-5]|2[0-4]\\d|[01]?\\d\\d?)\\.(?:25[0-5]|2[0-4]\\d|[01]?\\d\\d?)',
} as const;

function normalizeDef(def: string | CssFieldDef): CssFieldDef {
    if (typeof def === 'string') return { selector: def, type: 'text' };
    return def;
}

function truncate(s: string, max: number): string {
    return s.length > max ? s.slice(0, max) : s;
}

function extractField(
    $: $,
    context: ReturnType<$>,
    def: CssFieldDef,
    baseUrl: string,
    depth: number,
): unknown {
    if (depth > MAX_NESTING_DEPTH) return null;

    const type = def.type ?? 'text';
    const hasFields = def.fields && Object.keys(def.fields).length > 0;

    // When fields are present, always extract as list of objects
    if (hasFields) {
        const matches = context.find(def.selector);
        const results: Record<string, unknown>[] = [];
        const limit = Math.min(matches.length, MAX_RESULTS_PER_FIELD);
        for (let i = 0; i < limit; i++) {
            const el = $(matches[i]);
            const obj: Record<string, unknown> = {};
            for (const [key, subDef] of Object.entries(def.fields!)) {
                const normalized = normalizeDef(subDef);
                obj[key] = extractField($, el, normalized, baseUrl, depth + 1);
            }
            results.push(obj);
        }
        return results;
    }

    // Simple value extraction
    if (def.all) {
        const matches = context.find(def.selector);
        const results: string[] = [];
        const limit = Math.min(matches.length, MAX_RESULTS_PER_FIELD);
        for (let i = 0; i < limit; i++) {
            const el = $(matches[i]);
            const val = extractValue(el, type, def.attribute, baseUrl);
            if (val !== null) results.push(val);
        }
        return results;
    }

    // Single value extraction (first match)
    const el = context.find(def.selector).first();
    if (el.length === 0) return null;
    return extractValue(el, type, def.attribute, baseUrl);
}

function extractValue(
    el: ReturnType<$>,
    type: 'text' | 'attribute' | 'html',
    attribute: string | undefined,
    baseUrl: string,
): string | null {
    let val: string | undefined;
    switch (type) {
        case 'text':
            val = el.text()?.trim();
            break;
        case 'attribute':
            if (!attribute) return null;
            val = el.attr(attribute);
            // Resolve relative URLs for href/src attributes
            if (val && (attribute === 'href' || attribute === 'src')) {
                try { val = new URL(val, baseUrl).href; } catch { /* keep as-is */ }
            }
            break;
        case 'html':
            val = el.html() ?? undefined;
            break;
    }
    if (val === undefined || val === '') return null;
    return truncate(val, MAX_TEXT_LENGTH);
}

/**
 * Extract structured data from HTML using CSS selectors.
 * Returns a record keyed by the schema field names.
 */
export function extractCss(
    html: string,
    baseUrl: string,
    config: CssExtractionConfig,
): Record<string, unknown> {
    const $doc = cheerio.load(html);
    const root = $doc.root();
    const result: Record<string, unknown> = {};

    for (const [key, def] of Object.entries(config.schema)) {
        const normalized = normalizeDef(def);
        result[key] = extractField($doc, root, normalized, baseUrl, 0);
    }

    return result;
}

/**
 * Extract data from text using regex patterns.
 * Each pattern is matched globally; returns arrays of all matches.
 */
export function extractRegex(
    text: string,
    config: RegexExtractionConfig,
): Record<string, string[]> {
    const result: Record<string, string[]> = {};

    for (const [key, pattern] of Object.entries(config.patterns)) {
        try {
            const re = new RegExp(pattern, 'g');
            const matches: string[] = [];
            let m: RegExpExecArray | null;
            let guard = 0;
            while ((m = re.exec(text)) !== null && guard < MAX_RESULTS_PER_FIELD) {
                matches.push(truncate(m[0], MAX_TEXT_LENGTH));
                guard++;
                // Prevent infinite loops on zero-length matches
                if (m.index === re.lastIndex) re.lastIndex++;
            }
            result[key] = matches;
        } catch {
            // Invalid regex pattern — return empty array
            result[key] = [];
        }
    }

    return result;
}
