import { safeHttpUrl, isPrivateHost } from './UrlUtils.js';

export interface RobotsRuleSet {
    disallow: string[];
    allow: string[];
    crawlDelayMs?: number;
}

export interface RobotsTxt {
    origin: string;
    rules: RobotsRuleSet;
}

function matchUserAgent(header: string, ua: string): boolean {
    const h = header.trim().toLowerCase();
    const u = ua.trim().toLowerCase();
    if (!h) return false;
    if (h === '*') return true;
    return u.includes(h);
}

const MAX_ROBOTS_RULES = 10_000; // Cap per section to prevent memory exhaustion
const MAX_ROBOTS_SECTIONS = 100;

export function parseRobotsTxt(origin: string, content: string, userAgent: string): RobotsTxt {
    // Strip UTF-8 BOM if present (common in Windows-created files)
    if (content.charCodeAt(0) === 0xFEFF) content = content.slice(1);

    const lines = content
        .split(/\r?\n/)
        .map((l) => l.replace(/#.*/, '').trim())
        .filter(Boolean);

    type Section = { agents: string[]; disallow: string[]; allow: string[]; crawlDelaySec?: number };
    const sections: Section[] = [];
    let current: Section | null = null;

    for (const line of lines) {
        const idx = line.indexOf(':');
        if (idx === -1) continue;
        const key = line.slice(0, idx).trim().toLowerCase();
        const value = line.slice(idx + 1).trim();

        if (key === 'user-agent') {
            if (!current || (current && current.disallow.length + current.allow.length > 0)) {
                if (sections.length >= MAX_ROBOTS_SECTIONS) break;
                current = { agents: [], disallow: [], allow: [] };
                sections.push(current);
            }
            if (current.agents.length < 100) current.agents.push(value);
            continue;
        }

        if (!current) continue;

        if (key === 'disallow') {
            if (current.disallow.length < MAX_ROBOTS_RULES) current.disallow.push(value);
        } else if (key === 'allow') {
            if (current.allow.length < MAX_ROBOTS_RULES) current.allow.push(value);
        } else if (key === 'crawl-delay') {
            const n = Number(value);
            // Cap at 300s to prevent DoS via malicious robots.txt (Infinity, huge values)
            if (!Number.isNaN(n) && n >= 0 && Number.isFinite(n)) {
                current.crawlDelaySec = Math.min(n, 300);
            }
        }
    }

    // Prefer the most specific matching section: non-* match wins, otherwise *.
    const matching = sections.filter((s) => s.agents.some((a) => matchUserAgent(a, userAgent)));
    const best =
        matching.find((s) => s.agents.some((a) => a.trim() !== '*')) ??
        matching.find((s) => s.agents.some((a) => a.trim() === '*')) ??
        null;

    const rules: RobotsRuleSet = {
        disallow: best?.disallow ?? [],
        allow: best?.allow ?? [],
        crawlDelayMs: best?.crawlDelaySec != null ? Math.round(best.crawlDelaySec * 1000) : undefined,
    };

    return { origin, rules };
}

/**
 * Match a URL path against a robots.txt pattern.
 * Supports * (wildcard) and $ (end anchor) per the robots.txt spec.
 * Uses segment-based matching to avoid ReDoS from malicious patterns.
 */
function robotsPatternMatch(pattern: string, urlPath: string): boolean {
    // Limit pattern length to prevent abuse
    if (pattern.length > 2048) return false;

    const hasEndAnchor = pattern.endsWith('$');
    const rawPattern = hasEndAnchor ? pattern.slice(0, -1) : pattern;

    // Split pattern on * wildcards into literal segments
    const segments = rawPattern.split('*');

    // Limit number of wildcard segments to prevent quadratic matching
    if (segments.length > 20) return false;

    let pos = 0;

    // First segment must match at the start (prefix)
    if (segments[0]) {
        if (!urlPath.startsWith(segments[0])) return false;
        pos = segments[0].length;
    }

    // Middle segments: find each one after the previous match position
    for (let i = 1; i < segments.length; i++) {
        const seg = segments[i];
        if (!seg) continue; // consecutive wildcards (**)
        const idx = urlPath.indexOf(seg, pos);
        if (idx === -1) return false;
        pos = idx + seg.length;
    }

    // If $ anchor, the path must be fully consumed
    if (hasEndAnchor && pos !== urlPath.length) return false;

    return true;
}

function pathAllowed(urlPath: string, rules: RobotsRuleSet): boolean {
    // Robots matching: longest matching pattern wins; ties go to allow.
    let bestType: 'allow' | 'disallow' | null = null;
    let bestLen = -1;

    for (const d of rules.disallow) {
        if (!d) continue;
        if (!robotsPatternMatch(d, urlPath)) continue;
        if (d.length > bestLen) {
            bestType = 'disallow';
            bestLen = d.length;
        }
    }

    // Allow is checked second with >= so that ties favor allow (per spec)
    for (const a of rules.allow) {
        if (!a) continue;
        if (!robotsPatternMatch(a, urlPath)) continue;
        if (a.length >= bestLen) {
            bestType = 'allow';
            bestLen = a.length;
        }
    }

    return bestType === 'disallow' ? false : true;
}

export function isAllowedByRobots(url: string, robots: RobotsTxt): boolean {
    const u = safeHttpUrl(url);
    if (!u) return false;
    if (u.origin !== robots.origin) return false;
    // Robots.txt matching operates on the full path + query string
    const pathWithQuery = u.search ? `${u.pathname}${u.search}` : u.pathname;
    return pathAllowed(pathWithQuery, robots.rules);
}

const ROBOTS_MAX_BYTES = 1_000_000; // 1MB limit for robots.txt

async function readTextWithLimit(response: Response, maxBytes: number): Promise<string | null> {
    const body = response.body;
    if (!body) {
        // Pre-flight Content-Length check before reading entire body
        const cl = Number(response.headers.get('content-length') || '0');
        if (Number.isFinite(cl) && cl > maxBytes) return null;
        const text = await response.text();
        if (new TextEncoder().encode(text).byteLength > maxBytes) return null;
        return text;
    }
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            if (value) {
                total += value.byteLength;
                if (total > maxBytes) {
                    return null;
                }
                chunks.push(value);
            }
        }
    } catch {
        return null;
    } finally {
        await reader.cancel().catch(() => {});
    }
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
        merged.set(c, offset);
        offset += c.byteLength;
    }
    return new TextDecoder('utf-8', { fatal: false }).decode(merged);
}

const ROBOTS_MAX_REDIRECTS = 5;

export async function fetchRobotsTxt(origin: string, userAgent: string): Promise<RobotsTxt | null> {
    let currentUrl = `${origin.replace(/\/$/, '')}/robots.txt`;
    // SSRF defense-in-depth: validate the constructed robots.txt URL
    try {
        const parsed = new URL(currentUrl);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
        if (isPrivateHost(parsed.hostname)) return null;
        // Strip userinfo
        parsed.username = '';
        parsed.password = '';
        currentUrl = parsed.href;
    } catch {
        return null;
    }
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10_000);
    try {
        // Manual redirect handling to prevent SSRF via robots.txt redirect
        let res: Response | null = null;
        for (let i = 0; i <= ROBOTS_MAX_REDIRECTS; i++) {
            res = await fetch(currentUrl, {
                headers: { 'User-Agent': userAgent, 'Accept': 'text/plain,*/*' },
                signal: controller.signal,
                redirect: 'manual',
            });
            const isRedirect = res.status === 301 || res.status === 302 || res.status === 303 || res.status === 307 || res.status === 308;
            if (!isRedirect) break;

            const location = res.headers.get('location');
            await res.body?.cancel().catch(() => {});
            if (!location) return null;

            let nextUrl: URL;
            try { nextUrl = new URL(location, currentUrl); } catch { return null; }
            // Strip userinfo to prevent credential injection
            nextUrl.username = '';
            nextUrl.password = '';
            if (isPrivateHost(nextUrl.hostname)) return null;
            if (nextUrl.protocol !== 'http:' && nextUrl.protocol !== 'https:') return null;
            currentUrl = nextUrl.href;
            // Reject excessively long redirect URLs
            if (currentUrl.length > 8192) return null;

            if (i === ROBOTS_MAX_REDIRECTS) return null;
        }
        if (!res || !res.ok) {
            await res?.body?.cancel().catch(() => {});
            return null;
        }
        const rawCL = res.headers.get('content-length');
        const contentLength = rawCL ? Number(rawCL) : 0;
        if (Number.isFinite(contentLength) && contentLength > 0 && contentLength > ROBOTS_MAX_BYTES) {
            await res.body?.cancel().catch(() => {});
            return null;
        }
        const text = await readTextWithLimit(res, ROBOTS_MAX_BYTES);
        if (!text) return null;
        return parseRobotsTxt(origin, text, userAgent);
    } catch {
        return null;
    } finally {
        clearTimeout(timeoutId);
    }
}
