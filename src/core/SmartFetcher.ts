import { FetchOptions, FetchResult, HttpCacheConfig } from '../types.js';
import { HttpDiskCache } from './HttpDiskCache.js';
import { isPrivateHost } from './UrlUtils.js';

const USER_AGENTS = [
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36 Edg/119.0.0.0',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1',
];

const DEFAULT_MAX_RESPONSE_BYTES = 50 * 1024 * 1024; // 50MB safety limit

/**
 * Handles static HTTP fetching with advanced features:
 * - User-Agent rotation to avoid bot detection
 * - Intelligent detection of client-side rendered (CSR) sites
 * - Automatic retries with exponential backoff
 */
export class SmartFetcher {
    private userAgentIndex = 0;

    private getNextUserAgent(): string {
        const ua = USER_AGENTS[this.userAgentIndex];
        this.userAgentIndex = (this.userAgentIndex + 1) % USER_AGENTS.length;
        return ua;
    }

    private httpCacheFromOptions(httpCache: boolean | HttpCacheConfig | undefined): HttpDiskCache | null {
        if (!httpCache) return null;
        const cfg = typeof httpCache === 'boolean' ? {} : httpCache;
        const enabled = cfg.enabled ?? true;
        if (!enabled) return null;
        const dir = cfg.dir ?? '.cache/agent-crawl/http';
        const ttlMs = cfg.ttlMs ?? 5 * 60_000;
        const maxEntries = cfg.maxEntries ?? 1000;
        return new HttpDiskCache({ dir, ttlMs, maxEntries });
    }

    /**
     * Detect if content likely requires JavaScript rendering to be useful.
     * Uses heuristics like content length, presence of SPA div hooks, etc.
     */
    private requiresJavaScript(html: string, headers: Headers): boolean {
        const lowerHtml = html.toLowerCase();

        // Extract text content once for reuse (strip all HTML tags)
        const textContent = html.replace(/<[^>]*>/g, '').trim();

        // Check 1: Very short content often implies a loader or redirect
        if (html.length < 500 && !lowerHtml.includes('<body')) {
            return true;
        }

        // Check 2: Common SPA frameworks often have empty root divs
        const spaIndicators = [
            'id="root"',
            'id="app"',
            'data-reactroot',
            'ng-version',
            '__NEXT_DATA__',
            'nuxt',
        ];
        if (spaIndicators.some(indicator => lowerHtml.includes(indicator.toLowerCase()))) {
            // Has SPA indicator but no substantial content (likely not SSR'd)
            if (textContent.length < 200) {
                return true;
            }
        }

        // Check 3: Content-Type suggests SPA
        const contentType = headers.get('content-type') || '';
        if (contentType.includes('application/json')) {
            return true;
        }

        // Check 4: Has script tags but minimal HTML content
        const scriptCount = (html.match(/<script/gi) || []).length;
        if (scriptCount > 3 && textContent.length < 300) {
            return true;
        }

        return false;
    }

    private getErrorMessage(error: unknown): string {
        if (error instanceof Error) {
            if (error.name === 'AbortError') {
                return 'Request timed out';
            }
            return error.message;
        }
        return 'Unknown fetch error';
    }

    private async wait(ms: number): Promise<void> {
        await new Promise((resolve) => setTimeout(resolve, ms));
    }

    private async readBodyWithLimit(response: Response, maxBytes: number): Promise<string> {
        // Node fetch exposes a web ReadableStream.
        const body = response.body;
        if (!body) {
            // Fallback for environments where body stream is unavailable
            const text = await response.text();
            // Use byte length, not character count, for accurate limit check
            if (new TextEncoder().encode(text).byteLength > maxBytes) {
                throw new Error(`Response too large (>${maxBytes} bytes)`);
            }
            return text;
        }

        const reader = body.getReader();
        // Pre-allocate a buffer and grow as needed to avoid excessive chunk fragmentation
        let buffer = new Uint8Array(Math.min(maxBytes, 256 * 1024)); // Start with 256KB or maxBytes
        let total = 0;

        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            if (value) {
                total += value.byteLength;
                if (total > maxBytes) {
                    try {
                        await reader.cancel();
                    } catch {
                        // ignore
                    }
                    throw new Error(`Response too large (>${maxBytes} bytes)`);
                }
                // Grow buffer if needed
                if (total > buffer.byteLength) {
                    const newSize = Math.min(maxBytes, buffer.byteLength * 2);
                    const newBuffer = new Uint8Array(Math.max(newSize, total));
                    newBuffer.set(buffer.subarray(0, total - value.byteLength));
                    buffer = newBuffer;
                }
                buffer.set(value, total - value.byteLength);
            }
        }

        return new TextDecoder('utf-8', { fatal: false }).decode(buffer.subarray(0, total));
    }

    private static readonly MAX_REDIRECTS = 10;

    private static readonly ACCEPT_CONTENT_TYPES = [
        'text/html',
        'application/xhtml+xml',
        'application/xml',
        'text/xml',
        'text/plain',
    ];

    private isAcceptableContentType(contentType: string): boolean {
        const ct = contentType.split(';')[0].trim().toLowerCase();
        return SmartFetcher.ACCEPT_CONTENT_TYPES.some((t) => ct === t) || ct === '';
    }

    async fetch(url: string, options: FetchOptions = {}): Promise<FetchResult> {
        const { retries = 2, timeout = 10000, maxResponseBytes, httpCache } = options;

        // SSRF protection: reject private/internal hosts at the network boundary
        try {
            const parsed = new URL(url);
            if (isPrivateHost(parsed.hostname)) {
                return {
                    url,
                    finalUrl: url,
                    html: '',
                    status: 0,
                    headers: {},
                    isStaticSuccess: false,
                    needsBrowser: false,
                    error: 'Request to private/internal host blocked',
                };
            }
        } catch {
            return {
                url,
                finalUrl: url,
                html: '',
                status: 0,
                headers: {},
                isStaticSuccess: false,
                needsBrowser: false,
                error: 'Invalid URL',
            };
        }

        const cache = this.httpCacheFromOptions(httpCache);
        // Look up cache once before retries — cache data doesn't change between attempts
        const cached = cache ? await cache.get(url) : null;
        const conditionalHeaders: Record<string, string> = {};
        if (cached?.entry.etag) conditionalHeaders['If-None-Match'] = cached.entry.etag;
        if (cached?.entry.lastModified) conditionalHeaders['If-Modified-Since'] = cached.entry.lastModified;

        for (let attempt = 0; attempt <= retries; attempt++) {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), timeout);

            try {

                // Manual redirect handling to validate each hop for SSRF
                let currentUrl = url;
                let response: Response | null = null;
                const ua = this.getNextUserAgent(); // Consistent UA across the redirect chain
                let currentMethod = options.method || 'GET';

                for (let redirectCount = 0; redirectCount <= SmartFetcher.MAX_REDIRECTS; redirectCount++) {
                    // Only send conditional/custom headers on the initial request, not redirect hops
                    const isInitialRequest = redirectCount === 0;
                    response = await fetch(currentUrl, {
                        method: currentMethod,
                        headers: {
                            'User-Agent': ua,
                            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
                            'Accept-Language': 'en-US,en;q=0.9',
                            'Accept-Encoding': 'gzip, deflate, br',
                            ...(isInitialRequest ? conditionalHeaders : {}),
                            ...(isInitialRequest ? options.headers : {}),
                        },
                        signal: controller.signal,
                        redirect: 'manual',
                    });

                    // 3xx redirects excluding 304 (Not Modified) and 300 (Multiple Choices without Location)
                    const status = response.status;
                    const isRedirect = status >= 301 && status <= 308 && status !== 304;
                    if (!isRedirect) break;

                    const location = response.headers.get('location');
                    if (!location) break;

                    // Drain redirect response body
                    response.body?.cancel().catch(() => {});

                    // HTTP spec: 301/302/303 change method to GET; 307/308 preserve method
                    if (status === 301 || status === 302 || status === 303) {
                        currentMethod = 'GET';
                    }

                    let nextUrl: URL;
                    try {
                        nextUrl = new URL(location, currentUrl);
                    } catch {
                        return {
                            url,
                            finalUrl: currentUrl,
                            html: '',
                            status,
                            headers: {},
                            isStaticSuccess: false,
                            needsBrowser: false,
                            error: `Invalid redirect location: ${location.slice(0, 200)}`,
                        };
                    }

                    // SSRF: validate redirect target is not a private host
                    if (isPrivateHost(nextUrl.hostname)) {
                        return {
                            url,
                            finalUrl: currentUrl,
                            html: '',
                            status: 0,
                            headers: {},
                            isStaticSuccess: false,
                            needsBrowser: false,
                            error: 'Redirect to private/internal host blocked',
                        };
                    }

                    // Only follow http/https redirects
                    if (nextUrl.protocol !== 'http:' && nextUrl.protocol !== 'https:') {
                        return {
                            url,
                            finalUrl: currentUrl,
                            html: '',
                            status: 0,
                            headers: {},
                            isStaticSuccess: false,
                            needsBrowser: false,
                            error: `Redirect to non-HTTP protocol blocked: ${nextUrl.protocol}`,
                        };
                    }

                    currentUrl = nextUrl.href;

                    if (redirectCount === SmartFetcher.MAX_REDIRECTS) {
                        return {
                            url,
                            finalUrl: currentUrl,
                            html: '',
                            status: 0,
                            headers: {},
                            isStaticSuccess: false,
                            needsBrowser: false,
                            error: 'Too many redirects',
                        };
                    }
                }

                if (!response) {
                    throw new Error('No response received');
                }

                const headers: Record<string, string> = {};
                response.headers.forEach((value, key) => {
                    headers[key] = value;
                });

                if (response.status === 304 && cached) {
                    response.body?.cancel().catch(() => {});
                    return {
                        url,
                        finalUrl: currentUrl,
                        html: cached.body,
                        status: 200,
                        headers: cached.entry.headers,
                        isStaticSuccess: true,
                        needsBrowser: false,
                        error: undefined,
                    };
                }

                if (!response.ok) {
                    const isRetryable = response.status >= 500 || response.status === 408 || response.status === 429;
                    // Always drain response body to release the socket
                    response.body?.cancel().catch(() => {});
                    if (isRetryable && attempt < retries) {
                        await this.wait(1000 * (attempt + 1));
                        continue;
                    }

                    return {
                        url,
                        finalUrl: currentUrl,
                        html: '',
                        status: response.status,
                        headers,
                        isStaticSuccess: false,
                        needsBrowser: false,
                        error: `HTTP ${response.status}`,
                    };
                }

                // Reject non-HTML content types early to avoid processing binary data
                const contentType = response.headers.get('content-type') || '';
                if (contentType && !this.isAcceptableContentType(contentType)) {
                    response.body?.cancel().catch(() => {});
                    return {
                        url,
                        finalUrl: currentUrl,
                        html: '',
                        status: response.status,
                        headers,
                        isStaticSuccess: false,
                        needsBrowser: false,
                        error: `Non-HTML content type: ${contentType.split(';')[0].trim()}`,
                    };
                }

                let html: string;
                const effectiveMaxBytes = (maxResponseBytes && maxResponseBytes > 0)
                    ? maxResponseBytes
                    : DEFAULT_MAX_RESPONSE_BYTES;
                const contentLength = Number(response.headers.get('content-length') || '0');
                if (contentLength && contentLength > effectiveMaxBytes) {
                    response.body?.cancel().catch(() => {});
                    return {
                        url,
                        finalUrl: currentUrl,
                        html: '',
                        status: response.status,
                        headers,
                        isStaticSuccess: false,
                        needsBrowser: false,
                        error: `Response too large (>${effectiveMaxBytes} bytes)`,
                    };
                }
                html = await this.readBodyWithLimit(response, effectiveMaxBytes);
                const needsJS = this.requiresJavaScript(html, response.headers);

                if (cache && !needsJS) {
                    await cache.set(url, response.status, headers, html).catch(() => {});
                }

                return {
                    url,
                    finalUrl: currentUrl,
                    html,
                    status: response.status,
                    headers,
                    isStaticSuccess: !needsJS,
                    needsBrowser: needsJS,
                    error: needsJS ? 'Detected client-side rendered content' : undefined,
                };
            } catch (error) {
                if (attempt >= retries) {
                    return {
                        url,
                        finalUrl: url,
                        html: '',
                        status: 0,
                        headers: {},
                        isStaticSuccess: false,
                        needsBrowser: false,
                        error: this.getErrorMessage(error),
                    };
                }
                await this.wait(1000 * (attempt + 1));
            } finally {
                clearTimeout(timeoutId);
            }
        }

        return {
            url,
            finalUrl: url,
            html: '',
            status: 0,
            headers: {},
            isStaticSuccess: false,
            needsBrowser: false,
            error: 'Unknown fetch error',
        };
    }
}
