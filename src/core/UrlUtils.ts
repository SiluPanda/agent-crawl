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

export function safeHttpUrl(input: string): URL | null {
    try {
        const u = new URL(input);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
        return u;
    } catch {
        return null;
    }
}

