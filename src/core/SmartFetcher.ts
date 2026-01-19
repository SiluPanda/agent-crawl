import { FetchOptions, FetchResult } from '../types.js';

const USER_AGENTS = [
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36 Edg/119.0.0.0',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1',
];

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

    async fetch(url: string, options: FetchOptions = {}): Promise<FetchResult> {
        const { retries = 2, timeout = 10000 } = options;
        let attempt = 0;

        while (attempt <= retries) {
            try {
                const controller = new AbortController();
                const id = setTimeout(() => controller.abort(), timeout);

                const response = await fetch(url, {
                    method: options.method || 'GET',
                    headers: {
                        'User-Agent': this.getNextUserAgent(),
                        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
                        'Accept-Language': 'en-US,en;q=0.9',
                        'Accept-Encoding': 'gzip, deflate, br',
                        ...options.headers,
                    },
                    signal: controller.signal,
                });

                clearTimeout(id);

                // Auth required
                if (response.status === 403 || response.status === 401) {
                    return {
                        url,
                        html: '',
                        status: response.status,
                        headers: Object.fromEntries(response.headers.entries()),
                        isStaticSuccess: false,
                    };
                }

                // Server error - retry
                if (!response.ok && response.status >= 500) {
                    throw new Error(`Server error: ${response.status}`);
                }

                const html = await response.text();

                // Intelligent JS detection
                const needsJS = this.requiresJavaScript(html, response.headers);

                return {
                    url,
                    html,
                    status: response.status,
                    headers: Object.fromEntries(response.headers.entries()),
                    isStaticSuccess: !needsJS,
                };

            } catch (error) {
                attempt++;
                if (attempt > retries) {
                    return {
                        url,
                        html: '',
                        status: 0,
                        headers: {},
                        isStaticSuccess: false,
                    };
                }
                // Exponential backoff
                await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
            }
        }

        return {
            url,
            html: '',
            status: 0,
            headers: {},
            isStaticSuccess: false
        };
    }
}
