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

    if (stripTrailingSlash && u.pathname.length > 1 && u.pathname.endsWith('/')) {
        u.pathname = u.pathname.slice(0, -1);
    }

    return u.href;
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
    /^\[0*:0*:0*:0*:0*:0*:0*:[01]\]$/, // Expanded IPv6 loopback variants
    /\.local$/i,
    /\.internal$/i,
];

export function isPrivateHost(hostname: string): boolean {
    if (PRIVATE_HOST_PATTERNS.some((p) => p.test(hostname))) return true;

    // Handle IPv4-mapped IPv6 in hex form: [::ffff:7f00:1]
    // Node.js normalizes [::ffff:127.0.0.1] to this form
    const v4MappedHex = hostname.match(/^\[::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})\]$/i);
    if (v4MappedHex) {
        const hi = parseInt(v4MappedHex[1], 16);
        const lo = parseInt(v4MappedHex[2], 16);
        const a = (hi >> 8) & 0xff, b = hi & 0xff;
        const c = (lo >> 8) & 0xff, d = lo & 0xff;
        const ipv4 = `${a}.${b}.${c}.${d}`;
        return isPrivateHost(ipv4);
    }

    // Handle IPv4-mapped IPv6 in dotted-quad form: [::ffff:127.0.0.1]
    const v4MappedDotted = hostname.match(/^\[::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\]$/i);
    if (v4MappedDotted) {
        return isPrivateHost(v4MappedDotted[1]);
    }

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

