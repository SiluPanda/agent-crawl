const TRACKING_PARAMS = [
    /^utm_/i,
    /^fbclid$/i,
    /^gclid$/i,
    /^dclid$/i,
    /^msclkid$/i,
    /^mc_cid$/i,
    /^mc_eid$/i,
];

export interface UrlNormalizeOptions {
    stripHash?: boolean; // default: true
    stripTrackingParams?: boolean; // default: true
    stripTrailingSlash?: boolean; // default: true (except for "/")
    lowercaseHostname?: boolean; // default: true
}

export function normalizeUrl(input: string, options: UrlNormalizeOptions = {}): string {
    const {
        stripHash = true,
        stripTrackingParams = true,
        stripTrailingSlash = true,
        lowercaseHostname = true,
    } = options;

    const u = new URL(input);

    // Strip userinfo to prevent credential leakage in cache keys and logs
    u.username = '';
    u.password = '';

    if (lowercaseHostname) u.hostname = u.hostname.toLowerCase();
    if (stripHash) u.hash = '';

    // Drop default ports.
    if ((u.protocol === 'http:' && u.port === '80') || (u.protocol === 'https:' && u.port === '443')) {
        u.port = '';
    }

    if (stripTrackingParams && u.searchParams) {
        for (const key of Array.from(u.searchParams.keys())) {
            if (TRACKING_PARAMS.some((re) => re.test(key))) {
                u.searchParams.delete(key);
            }
        }
        // Stable ordering.
        u.searchParams.sort();
    }

    // Normalize unnecessary percent encoding (e.g. %41 → A) for dedup accuracy.
    // Decode per-segment to preserve encoded path separators (%2F ≠ /).
    try {
        u.pathname = u.pathname
            .split('/')
            .map(seg => {
                try { return encodeURIComponent(decodeURIComponent(seg)); }
                catch { return seg; }
            })
            .join('/');
    } catch {
        // Invalid percent encoding — keep as-is
    }

    if (stripTrailingSlash && u.pathname.length > 1 && u.pathname.endsWith('/')) {
        u.pathname = u.pathname.slice(0, -1);
    }

    const href = u.href;
    // Cap output length to prevent URL explosion from query param manipulation
    if (href.length > 8192) {
        throw new Error('Normalized URL exceeds maximum length');
    }
    return href;
}

const PRIVATE_HOST_PATTERNS = [
    /^localhost$/i,
    /^127\.\d+\.\d+\.\d+$/,
    /^127\.\d+$/,               // Short IPv4 (127.1 → 127.0.0.1)
    /^10\.\d+\.\d+\.\d+$/,
    /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/,
    /^192\.168\.\d+\.\d+$/,
    /^169\.254\.\d+\.\d+$/,     // Link-local / APIPA
    /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+$/, // CGNAT 100.64.0.0/10
    /^198\.1[89]\.\d+\.\d+$/,   // RFC 2544 benchmarking
    /^240\.\d+\.\d+\.\d+$/,     // Class E / reserved
    /^255\.255\.255\.255$/,      // Broadcast
    /^0\.0\.0\.0$/,
    /^0$/,                      // Short form of 0.0.0.0
    /^\[::1?\]$/,               // IPv6 loopback
    /^\[fd[0-9a-f]{2}:/i,      // IPv6 ULA
    /^\[fe80:/i,                // IPv6 link-local
    /^\[0*:0*:0*:0*:0*:0*:0*:0*[01]\]$/, // Expanded IPv6 loopback variants (0*[01] handles zero-padded 0001)
    /\.local$/i,
    /\.internal$/i,
    /\.localhost$/i,              // RFC 6761 reserved
    /\.test$/i,                   // RFC 6761 reserved (documentation/testing)
    /\.invalid$/i,                // RFC 6761 reserved (always invalid)
    /\.example$/i,                // RFC 6761 reserved (documentation)
];

/**
 * Parse an IPv4 address string (dotted-quad) into a 32-bit number.
 * Returns null if the string is not a valid IPv4 address.
 */
function parseIPv4(ip: string): number | null {
    const parts = ip.split('.');
    if (parts.length !== 4) return null;
    let result = 0;
    for (const part of parts) {
        // Reject octal (leading zeros) and non-numeric parts
        if (!/^\d{1,3}$/.test(part) || (part.length > 1 && part[0] === '0')) return null;
        const n = Number(part);
        if (n > 255) return null;
        result = (result << 8) | n;
    }
    return result >>> 0; // unsigned 32-bit
}

/**
 * Check if a 32-bit IPv4 address falls in a private/reserved range.
 */
function isPrivateIPv4(ip: number): boolean {
    // 127.0.0.0/8 — loopback
    if ((ip >>> 24) === 127) return true;
    // 10.0.0.0/8 — private
    if ((ip >>> 24) === 10) return true;
    // 172.16.0.0/12 — private
    if ((ip >>> 20) === (172 << 4 | 1)) return true; // 0xAC1 = 172.16-31
    // 192.168.0.0/16 — private
    if ((ip >>> 16) === (192 << 8 | 168)) return true;
    // 169.254.0.0/16 — link-local
    if ((ip >>> 16) === (169 << 8 | 254)) return true;
    // 100.64.0.0/10 — CGNAT
    if ((ip >>> 22) === (100 << 2 | 1)) return true; // 100.64-127
    // 198.18.0.0/15 — benchmarking
    if ((ip >>> 17) === (198 << 7 | 9)) return true; // 198.18-19
    // 192.0.0.0/24 — IETF protocol assignments
    if ((ip >>> 8) === (192 << 16 | 0 << 8 | 0)) return true;
    // 192.0.2.0/24 — TEST-NET-1 (documentation)
    if ((ip >>> 8) === (192 << 16 | 0 << 8 | 2)) return true;
    // 198.51.100.0/24 — TEST-NET-2 (documentation)
    if ((ip >>> 8) === (198 << 16 | 51 << 8 | 100)) return true;
    // 203.0.113.0/24 — TEST-NET-3 (documentation)
    if ((ip >>> 8) === (203 << 16 | 0 << 8 | 113)) return true;
    // 240.0.0.0/4 — reserved (Class E)
    if ((ip >>> 28) === 0xF) return true;
    // 0.0.0.0/8 — "this" network
    if ((ip >>> 24) === 0) return true;
    // 255.255.255.255 — broadcast
    if (ip === 0xFFFFFFFF) return true;
    return false;
}

export function isPrivateHost(hostname: string): boolean {
    // Empty hostname (e.g. from malformed URL `http:///path`) — treat as private
    if (!hostname) return true;

    // Strip DNS trailing dot (e.g. "localhost." → "localhost") so patterns match.
    // Trailing dots are valid DNS syntax and resolve to the same host.
    if (hostname.endsWith('.')) hostname = hostname.slice(0, -1);
    if (!hostname) return true; // Was just a dot

    // Strip IPv6 zone IDs (e.g. [::1%25eth0] → [::1]) which could bypass loopback checks.
    // Zone IDs are valid per RFC 6874 but irrelevant for SSRF host classification.
    if (hostname.startsWith('[') && hostname.includes('%')) {
        const pctIdx = hostname.indexOf('%');
        if (pctIdx > 0 && hostname.endsWith(']')) {
            hostname = hostname.slice(0, pctIdx) + ']';
        }
    }

    if (PRIVATE_HOST_PATTERNS.some((p) => p.test(hostname))) return true;

    // Numeric IPv4 check: catches decimal (e.g. 2130706433) and dotted-quad
    const ipv4 = parseIPv4(hostname);
    if (ipv4 !== null && isPrivateIPv4(ipv4)) return true;

    // Decimal IP (e.g. http://2130706433 which is 127.0.0.1)
    if (/^\d+$/.test(hostname)) {
        const n = Number(hostname);
        if (n >= 0 && n <= 0xFFFFFFFF && isPrivateIPv4(n >>> 0)) return true;
    }

    // Hex IP (e.g. 0x7f000001 = 127.0.0.1) — defense-in-depth, URL() usually normalizes these
    if (/^0x[0-9a-f]+$/i.test(hostname)) {
        const n = parseInt(hostname, 16);
        if (n >= 0 && n <= 0xFFFFFFFF && isPrivateIPv4(n >>> 0)) return true;
    }

    // Octal/hex-per-octet IPs (e.g. 0177.0.0.1 or 0x7f.0.0.1) — defense-in-depth
    if (/^[0-9a-fx.]+$/i.test(hostname) && hostname.includes('.')) {
        const parts = hostname.split('.');
        if (parts.length === 4) {
            let valid = true;
            let result = 0;
            for (const part of parts) {
                let n: number;
                if (part.startsWith('0x') || part.startsWith('0X')) {
                    n = parseInt(part, 16);
                } else if (part.length > 1 && part[0] === '0') {
                    n = parseInt(part, 8); // octal
                } else {
                    n = Number(part);
                }
                if (!Number.isFinite(n) || n < 0 || n > 255) { valid = false; break; }
                result = (result << 8) | n;
            }
            if (valid && isPrivateIPv4(result >>> 0)) return true;
        }
    }

    // Handle IPv4-mapped IPv6 in hex form: [::ffff:7f00:1]
    // Node.js normalizes [::ffff:127.0.0.1] to this form
    const v4MappedHex = hostname.match(/^\[::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})\]$/i);
    if (v4MappedHex) {
        const hi = parseInt(v4MappedHex[1], 16);
        const lo = parseInt(v4MappedHex[2], 16);
        const a = (hi >> 8) & 0xff, b = hi & 0xff;
        const c = (lo >> 8) & 0xff, d = lo & 0xff;
        const ipv4Str = `${a}.${b}.${c}.${d}`;
        return isPrivateHost(ipv4Str);
    }

    // Handle IPv4-mapped IPv6 in dotted-quad form: [::ffff:127.0.0.1]
    const v4MappedDotted = hostname.match(/^\[::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\]$/i);
    if (v4MappedDotted) {
        return isPrivateHost(v4MappedDotted[1]);
    }

    // IPv4-compatible IPv6 addresses [::x:y] (deprecated RFC 4291, but defense in depth)
    // Node.js normalizes [::127.0.0.1] to [::7f00:1]
    const v4CompatHex = hostname.match(/^\[::([0-9a-f]{1,4}):([0-9a-f]{1,4})\]$/i);
    if (v4CompatHex) {
        const hi = parseInt(v4CompatHex[1], 16);
        const lo = parseInt(v4CompatHex[2], 16);
        const ipv4 = ((hi << 16) | lo) >>> 0;
        if (isPrivateIPv4(ipv4)) return true;
    }

    // Catch-all: bare IPv6 loopback/unspecified without brackets (unlikely but defensive)
    if (hostname === '::1' || hostname === '::' || hostname === '::0') return true;
    // Bracketed [::0] (unspecified address — Node normalizes to [::] but handle directly)
    if (/^\[::0*\]$/.test(hostname)) return true;

    return false;
}

/**
 * Sanitize a URL for safe logging — strips userinfo (user:pass@) and truncates query strings.
 * Prevents credential/token leaks in console output.
 */
export function sanitizeUrlForLog(input: string): string {
    try {
        const u = new URL(input);
        u.username = '';
        u.password = '';
        // Truncate long query strings that may contain tokens
        if (u.search.length > 100) {
            u.search = u.search.slice(0, 100) + '…';
        }
        return u.href;
    } catch {
        // If URL is malformed, truncate and return safely
        return input.length > 200 ? input.slice(0, 200) + '…' : input;
    }
}

export function safeHttpUrl(input: string, { allowPrivate = true }: { allowPrivate?: boolean } = {}): URL | null {
    try {
        const u = new URL(input);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
        if (!allowPrivate && isPrivateHost(u.hostname)) return null;
        return u;
    } catch {
        return null;
    }
}

