import { FetchOptions, FetchResult, HttpCacheConfig, ProxyConfig, CookieDef } from '../types.js';
import { HttpDiskCache } from './HttpDiskCache.js';
import { isPrivateHost } from './UrlUtils.js';
import path from 'node:path';

const USER_AGENTS = [
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36 Edg/119.0.0.0',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1',
];

const DEFAULT_MAX_RESPONSE_BYTES = 50 * 1024 * 1024; // 50MB safety limit
const MAX_URL_LENGTH = 8192; // 8KB — matches common server limits

// Headers that callers should never override — could break HTTP semantics or enable request smuggling
const BLOCKED_REQUEST_HEADERS = new Set([
    'host', 'transfer-encoding', 'content-length', 'connection',
    'keep-alive', 'te', 'trailer', 'upgrade', 'proxy-authorization',
    'proxy-connection', 'sec-fetch-dest', 'sec-fetch-mode', 'sec-fetch-site',
]);

/**
 * Handles static HTTP fetching with advanced features:
 * - User-Agent rotation to avoid bot detection
 * - Intelligent detection of client-side rendered (CSR) sites
 * - Automatic retries with exponential backoff
 */
export class SmartFetcher {
    private userAgentIndex = 0;
    private httpCacheInstances = new Map<string, HttpDiskCache>();
    private static readonly MAX_CACHE_INSTANCES = 50;

    private getNextUserAgent(): string {
        const ua = USER_AGENTS[this.userAgentIndex];
        this.userAgentIndex = (this.userAgentIndex + 1) % USER_AGENTS.length;
        return ua;
    }

    private static safeCacheDir(dir: string): string {
        const segments = dir.split(/[\\/]/);
        if (segments.some(s => s === '..')) {
            throw new Error(`Path traversal not allowed in cache dir: ${dir.slice(0, 100)}`);
        }
        return dir;
    }

    private httpCacheFromOptions(httpCache: boolean | HttpCacheConfig | undefined): HttpDiskCache | null {
        if (!httpCache) return null;
        const cfg = typeof httpCache === 'boolean' ? {} : httpCache;
        const enabled = cfg.enabled ?? true;
        if (!enabled) return null;
        const dir = SmartFetcher.safeCacheDir(cfg.dir ?? '.cache/agent-crawl/http');
        const ttlMs = cfg.ttlMs ?? 5 * 60_000;
        const maxEntries = cfg.maxEntries ?? 1000;
        // Reuse instances with the same config to avoid redundant mkdir and pruning resets
        const cacheKey = `${dir}:${ttlMs}:${maxEntries}`;
        let instance = this.httpCacheInstances.get(cacheKey);
        if (!instance) {
            if (this.httpCacheInstances.size >= SmartFetcher.MAX_CACHE_INSTANCES) {
                const oldestKey = this.httpCacheInstances.keys().next().value;
                if (oldestKey) this.httpCacheInstances.delete(oldestKey);
            }
            instance = new HttpDiskCache({ dir, ttlMs, maxEntries });
            this.httpCacheInstances.set(cacheKey, instance);
        }
        return instance;
    }

    /**
     * Detect if content likely requires JavaScript rendering to be useful.
     * Uses heuristics like content length, presence of SPA div hooks, etc.
     */
    private requiresJavaScript(html: string, headers: Headers): boolean {
        // Only inspect the first 50KB — sufficient for SPA detection heuristics
        // and avoids expensive regex operations on multi-MB HTML
        const sample = html.length > 50_000 ? html.slice(0, 50_000) : html;
        const lowerHtml = sample.toLowerCase();

        // Extract text content once for reuse (strip all HTML tags).
        // Uses indexOf loop instead of regex to avoid O(n²) on pathological input
        // with many unclosed '<' characters.
        let textContent = '';
        {
            let i = 0;
            while (i < sample.length) {
                const open = sample.indexOf('<', i);
                if (open === -1) { textContent += sample.slice(i); break; }
                if (open > i) textContent += sample.slice(i, open);
                const close = sample.indexOf('>', open + 1);
                if (close === -1) break; // unclosed tag — stop, don't scan rest
                i = close + 1;
            }
            textContent = textContent.trim();
        }

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
        const scriptCount = (sample.match(/<script/gi) || []).length;
        if (scriptCount > 3 && textContent.length < 300) {
            return true;
        }

        return false;
    }

    private static readonly MAX_ERROR_MSG_LENGTH = 500;

    private getErrorMessage(error: unknown): string {
        if (error instanceof Error) {
            if (error.name === 'AbortError') {
                return 'Request timed out';
            }
            const msg = error.message;
            return msg.length > SmartFetcher.MAX_ERROR_MSG_LENGTH
                ? msg.slice(0, SmartFetcher.MAX_ERROR_MSG_LENGTH) + '...'
                : msg;
        }
        return 'Unknown fetch error';
    }

    private static readonly MAX_BACKOFF_MS = 10_000; // Cap individual backoff waits

    private async wait(ms: number): Promise<void> {
        await new Promise((resolve) => setTimeout(resolve, Math.min(ms, SmartFetcher.MAX_BACKOFF_MS)));
    }

    private async readBodyWithLimit(response: Response, maxBytes: number): Promise<string> {
        // Node fetch exposes a web ReadableStream.
        const body = response.body;
        if (!body) {
            // Fallback for environments where body stream is unavailable.
            // Pre-flight Content-Length check to avoid reading oversized bodies.
            const clHeader = response.headers.get('content-length');
            if (clHeader) {
                const cl = Number(clHeader);
                if (Number.isFinite(cl) && cl > maxBytes) {
                    throw new Error(`Response too large (>${maxBytes} bytes)`);
                }
            }
            // Prefer arrayBuffer (gives byte-accurate size) but fall back to text
            if (typeof response.arrayBuffer === 'function') {
                const buf = await response.arrayBuffer();
                if (buf.byteLength > maxBytes) {
                    throw new Error(`Response too large (>${maxBytes} bytes)`);
                }
                return new TextDecoder('utf-8', { fatal: false }).decode(buf);
            }
            const text = await response.text();
            if (new TextEncoder().encode(text).byteLength > maxBytes) {
                throw new Error(`Response too large (>${maxBytes} bytes)`);
            }
            return text;
        }

        const reader = body.getReader();
        // Pre-allocate a buffer and grow as needed to avoid excessive chunk fragmentation
        let buffer = new Uint8Array(Math.min(maxBytes, 256 * 1024)); // Start with 256KB or maxBytes
        let total = 0;

        try {
            while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                if (value) {
                    total += value.byteLength;
                    if (total > maxBytes) {
                        throw new Error(`Response too large (>${maxBytes} bytes)`);
                    }
                    // Grow buffer if needed
                    if (total > buffer.byteLength) {
                        // Never allocate more than maxBytes to prevent excessive memory use
                        const newSize = Math.min(maxBytes, Math.max(buffer.byteLength * 2, total));
                        const newBuffer = new Uint8Array(newSize);
                        newBuffer.set(buffer.subarray(0, total - value.byteLength));
                        buffer = newBuffer;
                    }
                    buffer.set(value, total - value.byteLength);
                }
            }
        } finally {
            // Always release the reader to free the underlying TCP connection,
            // even on OOM during buffer growth or other unexpected errors.
            await reader.cancel().catch(() => {});
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

    private static proxyAgentCache = new Map<string, any>();

    private async getProxyDispatcher(proxy: ProxyConfig): Promise<any> {
        const cacheKey = proxy.url;
        const cached = SmartFetcher.proxyAgentCache.get(cacheKey);
        if (cached) return cached;

        try {
            const { ProxyAgent } = await import('undici');
            const opts: any = { uri: proxy.url };
            if (proxy.username || proxy.password) {
                opts.token = `Basic ${Buffer.from(`${proxy.username ?? ''}:${proxy.password ?? ''}`).toString('base64')}`;
            }
            const agent = new ProxyAgent(opts);
            // Cap cache size
            if (SmartFetcher.proxyAgentCache.size >= 20) {
                const oldest = SmartFetcher.proxyAgentCache.keys().next().value;
                if (oldest) SmartFetcher.proxyAgentCache.delete(oldest);
            }
            SmartFetcher.proxyAgentCache.set(cacheKey, agent);
            return agent;
        } catch {
            throw new Error('Proxy support requires undici. Install it with: npm install undici');
        }
    }

    private static formatCookieHeader(cookies: CookieDef[]): string {
        return cookies
            .map(c => `${c.name}=${c.value}`)
            .join('; ');
    }

    async fetch(url: string, options: FetchOptions = {}): Promise<FetchResult> {
        const rawRetries = options.retries ?? 2;
        const retries = Number.isFinite(rawRetries) ? Math.min(Math.max(0, rawRetries), 10) : 2;
        const rawTimeout = options.timeout ?? 10000;
        const timeout = Number.isFinite(rawTimeout) ? Math.min(Math.max(1000, rawTimeout), 120_000) : 10000;
        const { maxResponseBytes, httpCache, proxy, cookies } = options;

        // Reject excessively long URLs to prevent memory waste in cache keys/parsing
        if (url.length > MAX_URL_LENGTH) {
            return {
                url: url.slice(0, 200),
                finalUrl: url.slice(0, 200),
                html: '',
                status: 0,
                headers: {},
                isStaticSuccess: false,
                needsBrowser: false,
                error: `URL too long (${url.length} chars, max ${MAX_URL_LENGTH})`,
            };
        }

        // SSRF protection: reject private/internal hosts and non-HTTP protocols
        // Also strip userinfo to prevent credential injection via URL (user:pass@host)
        try {
            const parsed = new URL(url);
            if (parsed.username || parsed.password) {
                parsed.username = '';
                parsed.password = '';
                url = parsed.href;
            }
            if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
                return {
                    url,
                    finalUrl: url,
                    html: '',
                    status: 0,
                    headers: {},
                    isStaticSuccess: false,
                    needsBrowser: false,
                    error: `Non-HTTP protocol blocked: ${parsed.protocol}`,
                };
            }
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

        // Filter dangerous headers and cap value lengths from user-supplied options
        const safeUserHeaders: Record<string, string> = Object.create(null);
        if (options.headers) {
            for (const [k, v] of Object.entries(options.headers)) {
                if (typeof k !== 'string' || typeof v !== 'string') continue;
                if (BLOCKED_REQUEST_HEADERS.has(k.toLowerCase())) continue;
                // Cap individual header value length to prevent memory abuse
                safeUserHeaders[k] = v.length > 8192 ? v.slice(0, 8192) : v;
            }
        }

        // Resolve proxy dispatcher once before the retry loop
        let proxyDispatcher: any = undefined;
        if (proxy) {
            try {
                proxyDispatcher = await this.getProxyDispatcher(proxy);
            } catch (e) {
                return {
                    url,
                    finalUrl: url,
                    html: '',
                    status: 0,
                    headers: {},
                    isStaticSuccess: false,
                    needsBrowser: false,
                    error: e instanceof Error ? e.message : 'Failed to create proxy agent',
                };
            }
        }

        // Format cookies as header value
        const cookieHeader = cookies?.length ? SmartFetcher.formatCookieHeader(cookies) : undefined;

        const cache = this.httpCacheFromOptions(httpCache);
        // Look up cache once before retries — cache data doesn't change between attempts
        const cached = cache ? await cache.get(url) : null;
        const conditionalHeaders: Record<string, string> = {};
        if (cached?.entry.etag) conditionalHeaders['If-None-Match'] = cached.entry.etag;
        if (cached?.entry.lastModified) conditionalHeaders['If-Modified-Since'] = cached.entry.lastModified;

        for (let attempt = 0; attempt <= retries; attempt++) {
            // Create fresh controller per attempt so retries get a clean abort signal
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
                    const fetchOptions: any = {
                        method: currentMethod,
                        headers: {
                            'User-Agent': ua,
                            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
                            'Accept-Language': 'en-US,en;q=0.9',
                            'Accept-Encoding': 'gzip, deflate, br',
                            ...(isInitialRequest ? conditionalHeaders : {}),
                            ...(isInitialRequest ? safeUserHeaders : {}),
                            ...(isInitialRequest && cookieHeader ? { 'Cookie': cookieHeader } : {}),
                        },
                        signal: controller.signal,
                        redirect: 'manual',
                    };
                    if (proxyDispatcher) {
                        fetchOptions.dispatcher = proxyDispatcher;
                    }
                    response = await fetch(currentUrl, fetchOptions);

                    // Only follow standard redirect codes; skip 300 (Multiple Choices),
                    // 304 (Not Modified), 305 (Use Proxy), 306 (unused)
                    const status = response.status;
                    const isRedirect = status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
                    if (!isRedirect) break;

                    const location = response.headers.get('location');
                    if (!location) break;

                    // Drain redirect response body — await to release the socket before the next hop
                    await response.body?.cancel().catch(() => {});

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

                    // Strip userinfo from redirect target to prevent credential injection
                    nextUrl.username = '';
                    nextUrl.password = '';

                    // Check protocol BEFORE hostname — javascript:/data: URLs have empty
                    // hostnames which would trigger isPrivateHost with a misleading error.
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

                    currentUrl = nextUrl.href;

                    // Reject excessively long redirect URLs
                    if (currentUrl.length > MAX_URL_LENGTH) {
                        return {
                            url,
                            finalUrl: currentUrl.slice(0, 200),
                            html: '',
                            status: 0,
                            headers: {},
                            isStaticSuccess: false,
                            needsBrowser: false,
                            error: `Redirect URL too long (${currentUrl.length} chars, max ${MAX_URL_LENGTH})`,
                        };
                    }

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

                const headers: Record<string, string> = Object.create(null);
                let headerCount = 0;
                response.headers.forEach((value, key) => {
                    // Cap header count and value size to prevent memory exhaustion from malicious servers
                    if (headerCount >= 200) return;
                    headers[key] = value.length > 8192 ? value.slice(0, 8192) : value;
                    headerCount++;
                });

                if (response.status === 304 && cached) {
                    await response.body?.cancel().catch(() => {});
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
                    await response.body?.cancel().catch(() => {});
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
                    await response.body?.cancel().catch(() => {});
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
                const effectiveMaxBytes = (Number.isFinite(maxResponseBytes) && maxResponseBytes! > 0)
                    ? Math.min(maxResponseBytes!, DEFAULT_MAX_RESPONSE_BYTES)
                    : DEFAULT_MAX_RESPONSE_BYTES;
                const rawCL = response.headers.get('content-length');
                const contentLength = rawCL ? Number(rawCL) : 0;
                if (Number.isFinite(contentLength) && contentLength > 0 && contentLength > effectiveMaxBytes) {
                    await response.body?.cancel().catch(() => {});
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
