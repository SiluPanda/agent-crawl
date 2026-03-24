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

export function parseRobotsTxt(origin: string, content: string, userAgent: string): RobotsTxt {
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
                current = { agents: [], disallow: [], allow: [] };
                sections.push(current);
            }
            current.agents.push(value);
            continue;
        }

        if (!current) continue;

        if (key === 'disallow') {
            current.disallow.push(value);
        } else if (key === 'allow') {
            current.allow.push(value);
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

    for (const a of rules.allow) {
        if (!a) continue;
        if (!robotsPatternMatch(a, urlPath)) continue;
        if (a.length > bestLen) {
            bestType = 'allow';
            bestLen = a.length;
        }
    }

    for (const d of rules.disallow) {
        if (!d) continue;
        if (!robotsPatternMatch(d, urlPath)) continue;
        if (d.length > bestLen) {
            bestType = 'disallow';
            bestLen = d.length;
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
                    await reader.cancel().catch(() => {});
                    return null;
                }
                chunks.push(value);
            }
        }
    } catch {
        return null;
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
            const isRedirect = res.status >= 301 && res.status <= 308 && res.status !== 304;
            if (!isRedirect) break;

            const location = res.headers.get('location');
            res.body?.cancel().catch(() => {});
            if (!location) return null;

            let nextUrl: URL;
            try { nextUrl = new URL(location, currentUrl); } catch { return null; }
            if (isPrivateHost(nextUrl.hostname)) return null;
            if (nextUrl.protocol !== 'http:' && nextUrl.protocol !== 'https:') return null;
            currentUrl = nextUrl.href;

            if (i === ROBOTS_MAX_REDIRECTS) return null;
        }
        if (!res || !res.ok) {
            res?.body?.cancel().catch(() => {});
            return null;
        }
        const contentLength = Number(res.headers.get('content-length') || '0');
        if (contentLength > ROBOTS_MAX_BYTES) {
            res.body?.cancel().catch(() => {});
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
