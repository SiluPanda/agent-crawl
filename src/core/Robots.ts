import { safeHttpUrl } from './UrlUtils.js';

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
            if (!Number.isNaN(n) && n >= 0) current.crawlDelaySec = n;
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

function pathAllowed(path: string, rules: RobotsRuleSet): boolean {
    // Basic robots matching: longest allow/disallow prefix wins.
    let bestType: 'allow' | 'disallow' | null = null;
    let bestLen = -1;

    for (const a of rules.allow) {
        if (!a) continue;
        if (!path.startsWith(a)) continue;
        if (a.length > bestLen) {
            bestType = 'allow';
            bestLen = a.length;
        }
    }

    for (const d of rules.disallow) {
        if (!d) continue;
        if (!path.startsWith(d)) continue;
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
    return pathAllowed(u.pathname, robots.rules);
}

export async function fetchRobotsTxt(origin: string, userAgent: string): Promise<RobotsTxt | null> {
    const robotsUrl = `${origin.replace(/\/$/, '')}/robots.txt`;
    try {
        const res = await fetch(robotsUrl, {
            headers: { 'User-Agent': userAgent, 'Accept': 'text/plain,*/*' },
        });
        if (!res.ok) return null;
        const text = await res.text();
        return parseRobotsTxt(origin, text, userAgent);
    } catch {
        return null;
    }
}
