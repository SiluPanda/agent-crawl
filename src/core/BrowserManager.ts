import { chromium, Browser, BrowserContext, BrowserContextOptions, Page, Route } from 'playwright-core';
import { StealthLevel, ProxyConfig, CookieDef } from '../types.js';
import { isPrivateHost, sanitizeUrlForLog } from './UrlUtils.js';

export interface BrowserPageResult {
    html: string;
    status: number;
    headers: Record<string, string>;
    finalUrl?: string;
}

export interface BrowserPageOptions {
    stealth?: boolean;
    stealthLevel?: StealthLevel;
    proxy?: ProxyConfig;
    headers?: Record<string, string>;
    cookies?: CookieDef[];
    jsCode?: string[];
}

/**
 * Manages Headless Browser instances (Playwright).
 * Implements Singleton pattern to share browser instance across requests.
 * Automatic idle cleanup to save memory.
 */
export class BrowserManager {
    private browser: Browser | null = null;
    private static instance: BrowserManager;
    private idleTimeout: NodeJS.Timeout | null = null;
    private readonly IDLE_TIME_MS = 5000; // 5 seconds idle before close
    private activePages = 0; // Track active getPage() calls to prevent premature close
    private closing: Promise<void> | null = null; // Serialize close operations

    // Singleton
    static getInstance(): BrowserManager {
        if (!BrowserManager.instance) {
            BrowserManager.instance = new BrowserManager();
        }
        return BrowserManager.instance;
    }

    private launchPromise: Promise<Browser> | null = null;

    private readonly DEFAULT_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
    private readonly STEALTH_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36';
    private readonly STEALTH_SEC_CH_UA = '"Not_A Brand";v="99", "Chromium";v="123", "Google Chrome";v="123"';

    async launch(): Promise<Browser> {
        // Wait for any in-progress close to finish before launching
        if (this.closing) {
            await this.closing;
        }

        // Check if existing browser is still valid and connected
        if (this.browser && this.browser.isConnected()) {
            return this.browser;
        }

        // Browser exists but disconnected - clean up
        if (this.browser) {
            this.browser = null;
            this.launchPromise = null;
        }

        // Prevent race conditions during concurrent launches
        if (!this.launchPromise) {
            this.launchPromise = (async () => {
                try {
                    console.log('[BrowserManager] Launching new browser instance...');
                    const browser = await chromium.launch({
                        headless: true,
                        args: [
                            '--no-sandbox',
                            '--disable-setuid-sandbox',
                            '--disable-gpu',
                            '--disable-dev-shm-usage',
                            '--disable-extensions',
                            '--disable-background-networking',
                            '--disable-default-apps',
                            '--disable-sync',
                            '--no-first-run',
                        ]
                    });
                    this.browser = browser;

                    // Listen for unexpected disconnection to clean up state
                    browser.on('disconnected', () => {
                        if (this.browser === browser) {
                            this.browser = null;
                            this.launchPromise = null;
                        }
                    });

                    return browser;
                } catch (e) {
                    this.launchPromise = null;
                    console.error("Failed to launch browser. Make sure browsers are installed (npx playwright install).");
                    throw e;
                }
            })();
        }

        return this.launchPromise;
    }

    /**
     * Get page content using Playwright.
     * Includes optimizations:
     * - Blocks images/media/fonts to save bandwidth
     * - Wait for specifc selectors
     * - Auto-closes context
     */
    private static readonly OVERALL_TIMEOUT_MS = 45_000; // 45s hard cap for entire getPage
    private static readonly MAX_PAGE_CONTENT_BYTES = 20 * 1024 * 1024; // 20MB cap for page content
    private static readonly MAX_CONCURRENT_PAGES = 10; // Limit concurrent browser contexts to prevent OOM
    private static readonly MAX_RESPONSE_HEADERS = 200;
    private static readonly MAX_HEADER_VALUE_LEN = 8192;

    async getPage(url: string, waitForSelector?: string, options: BrowserPageOptions = {}): Promise<BrowserPageResult> {
        if (url.length > 8192) {
            throw new Error(`URL too long (${url.length} chars)`);
        }

        // SSRF protection: reject non-HTTP protocols and private/internal hosts
        // Strip userinfo to prevent credential injection via URL (user:pass@host)
        try {
            const parsed = new URL(url);
            if (parsed.username || parsed.password) {
                parsed.username = '';
                parsed.password = '';
                url = parsed.href;
            }
            if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
                throw new Error(`Non-HTTP protocol blocked: ${parsed.protocol}`);
            }
            if (isPrivateHost(parsed.hostname)) {
                throw new Error('Request to private/internal host blocked');
            }
        } catch (e: any) {
            const msg = typeof e?.message === 'string' ? e.message : '';
            if (msg.includes('private/internal') || msg.includes('protocol blocked')) throw e;
            throw new Error(`Invalid URL: ${sanitizeUrlForLog(url)}`);
        }

        // Reserve a page slot atomically — increment now, decrement in finally.
        // This prevents N callers from passing the gate before any increment.
        await this.acquirePageSlot();

        // Overall timeout to prevent cumulative hangs across launch + navigate + wait + extract
        let timeoutTimer: NodeJS.Timeout | undefined;
        try {
            const result = await Promise.race([
                this.getPageInner(url, waitForSelector, options),
                new Promise<never>((_, reject) => {
                    timeoutTimer = setTimeout(() => reject(new Error(`Browser page load timed out after ${BrowserManager.OVERALL_TIMEOUT_MS}ms`)), BrowserManager.OVERALL_TIMEOUT_MS);
                    timeoutTimer.unref();
                }),
            ]);
            return result;
        } finally {
            if (timeoutTimer) clearTimeout(timeoutTimer);
            // Slot release happens in getPageInner's finally — NOT here.
            // On timeout, getPageInner continues running; releasing the slot
            // here would let new contexts exceed MAX_CONCURRENT_PAGES.
        }
    }

    private async acquirePageSlot(): Promise<void> {
        const deadline = Date.now() + BrowserManager.OVERALL_TIMEOUT_MS;
        while (this.activePages >= BrowserManager.MAX_CONCURRENT_PAGES) {
            if (Date.now() > deadline) {
                throw new Error('Timed out waiting for available browser page slot');
            }
            await new Promise(r => setTimeout(r, 100));
        }
        // Increment immediately after the check — no awaits between check and increment
        this.activePages++;
    }

    private async getPageInner(url: string, waitForSelector?: string, options: BrowserPageOptions = {}): Promise<BrowserPageResult> {
        // Top-level try/finally guarantees the page slot is released even if
        // launch() or newContext() throw before we enter the context try/finally.
        try {
            return await this.getPageImpl(url, waitForSelector, options);
        } finally {
            this.activePages = Math.max(0, this.activePages - 1);
            this.resetIdleTimer();
        }
    }

    private async getPageImpl(url: string, waitForSelector?: string, options: BrowserPageOptions = {}): Promise<BrowserPageResult> {
        const stealth = options.stealth ?? false;
        const stealthLevel = options.stealthLevel ?? 'balanced';
        const contextOpts = this.getContextOptions(options);
        let browser = await this.launch();
        let context: BrowserContext;
        try {
            context = await browser.newContext(contextOpts);
        } catch {
            // Browser may have disconnected between launch() and newContext() — retry once
            this.browser = null;
            this.launchPromise = null;
            browser = await this.launch();
            context = await browser.newContext(contextOpts);
        }

        this.clearIdleTimer(); // We are active

        try {
            if (stealth) {
                await this.applyStealth(context, stealthLevel);
            }

            // Inject cookies before page navigation
            if (options.cookies?.length) {
                const parsedUrl = new URL(url);
                const playwrightCookies = options.cookies.map(c => ({
                    name: c.name,
                    value: c.value,
                    domain: c.domain ?? parsedUrl.hostname,
                    path: c.path ?? '/',
                }));
                await context.addCookies(playwrightCookies);
            }

            const page = await context.newPage();

            // Set default timeout for all operations to prevent hangs
            page.setDefaultTimeout(15000); // 15 seconds max for any operation
            // Optimization: Block unnecessary resources
            // This drastically reduces load time and bandwidth usage
            // Block websocket/eventsource to prevent long-lived connections and data exfiltration.
            // Block ping to prevent beacon tracking via <a ping="...">.
            const blockedResourceTypes = stealth
                ? ['image', 'font', 'media', 'websocket', 'eventsource', 'manifest', 'ping']
                : ['image', 'stylesheet', 'font', 'media', 'websocket', 'eventsource', 'manifest', 'ping'];
            await page.route('**/*', (route: Route) => {
                const request = route.request();

                // SSRF protection: block ALL requests to private/internal hosts
                // This intercepts redirects and sub-resources BEFORE the connection is made
                try {
                    const reqUrl = new URL(request.url());
                    if (isPrivateHost(reqUrl.hostname)) {
                        return route.abort('blockedbyclient');
                    }
                    if (reqUrl.protocol !== 'http:' && reqUrl.protocol !== 'https:') {
                        return route.abort('blockedbyclient');
                    }
                } catch {
                    return route.abort('blockedbyclient');
                }

                const resourceType = request.resourceType();
                if (blockedResourceTypes.includes(resourceType)) {
                    return route.abort();
                }
                return route.continue();
            });

            const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });

            // Secondary SSRF check on the final URL (defense in depth)
            const finalUrl = response?.url() ?? page.url();
            try {
                const finalParsed = new URL(finalUrl);
                if (isPrivateHost(finalParsed.hostname)) {
                    throw new Error('Redirect to private/internal host blocked');
                }
            } catch (e: any) {
                const emsg = typeof e?.message === 'string' ? e.message : '';
                if (emsg.includes('private/internal')) throw e;
                throw new Error(`Navigation resulted in invalid URL: ${sanitizeUrlForLog(finalUrl)}`);
            }

            // Try to dismiss cookie consent banners
            await this.dismissCookieBanners(page);

            if (waitForSelector) {
                // Limit selector length to prevent abuse
                const safeSelector = waitForSelector.slice(0, 500);
                await page.waitForSelector(safeSelector, { timeout: 10000 });
            }

            // Execute user-provided JavaScript after page load + waitFor
            if (options.jsCode?.length) {
                for (const script of options.jsCode) {
                    await page.evaluate(script).catch((err: Error) => {
                        // Log but don't fail — JS errors are non-fatal
                        console.warn(`[BrowserManager] jsCode error: ${err.message?.slice(0, 200) ?? 'Unknown'}`);
                    });
                    // Brief settle time between scripts for DOM mutations to propagate
                    await page.waitForTimeout(100);
                }
                // Wait for network to settle after JS execution (dynamic content may load)
                await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
            }

            // Extract content with size limit to prevent OOM from enormous DOMs
            const content = await page.content();
            if (Buffer.byteLength(content, 'utf-8') > BrowserManager.MAX_PAGE_CONTENT_BYTES) {
                throw new Error(`Page content too large (>${BrowserManager.MAX_PAGE_CONTENT_BYTES} bytes)`);
            }
            // Cap response headers to prevent memory exhaustion from malicious servers
            const rawHeaders = response?.headers() ?? {};
            const cappedHeaders: Record<string, string> = Object.create(null);
            let hdrCount = 0;
            for (const [k, v] of Object.entries(rawHeaders)) {
                if (hdrCount >= BrowserManager.MAX_RESPONSE_HEADERS) break;
                cappedHeaders[k] = typeof v === 'string' && v.length > BrowserManager.MAX_HEADER_VALUE_LEN
                    ? v.slice(0, BrowserManager.MAX_HEADER_VALUE_LEN) : String(v);
                hdrCount++;
            }
            return {
                html: content,
                status: response?.status() ?? 200,
                headers: cappedHeaders,
                finalUrl,
            };
        } catch (e: any) {
            const errDetail = e instanceof Error ? e.message : String(e);
            console.error(`[BrowserManager] Failed to load ${sanitizeUrlForLog(url)}: ${errDetail.length > 500 ? errDetail.slice(0, 500) + '...' : errDetail}`);
            throw e;
        } finally {
            await context.close().catch(() => {});
        }
    }

    private getContextOptions(options: BrowserPageOptions): BrowserContextOptions {
        const stealth = options.stealth ?? false;
        const proxy = options.proxy;
        const customHeaders = options.headers;

        const base: BrowserContextOptions = stealth
            ? {
                userAgent: this.STEALTH_USER_AGENT,
                viewport: { width: 1366, height: 768 },
                locale: 'en-US',
                timezoneId: 'America/New_York',
                colorScheme: 'light',
                deviceScaleFactor: 1,
                isMobile: false,
                hasTouch: false,
                extraHTTPHeaders: {
                    'Accept-Language': 'en-US,en;q=0.9',
                    'sec-ch-ua': this.STEALTH_SEC_CH_UA,
                    'sec-ch-ua-mobile': '?0',
                    'sec-ch-ua-platform': '"Windows"',
                    'Upgrade-Insecure-Requests': '1',
                },
            }
            : {
                userAgent: this.DEFAULT_USER_AGENT,
            };

        // Merge custom headers into extraHTTPHeaders (custom headers take precedence)
        if (customHeaders && Object.keys(customHeaders).length > 0) {
            base.extraHTTPHeaders = { ...(base.extraHTTPHeaders ?? {}), ...customHeaders };
        }

        // Set proxy at context level
        if (proxy) {
            base.proxy = {
                server: proxy.url,
                ...(proxy.username ? { username: proxy.username } : {}),
                ...(proxy.password ? { password: proxy.password } : {}),
            };
        }

        return base;
    }

    private async applyStealth(context: BrowserContext, level: StealthLevel): Promise<void> {
        await context.addInitScript(this.getStealthInitScript(level));
    }

    private getStealthInitScript(level: StealthLevel): string {
        const balancedEnhancements = level === 'balanced'
            ? `
        const originalGetParameter = WebGLRenderingContext.prototype.getParameter;
        WebGLRenderingContext.prototype.getParameter = function(parameter) {
            if (parameter === 37445) return 'Intel Inc.';
            if (parameter === 37446) return 'Intel Iris OpenGL Engine';
            return originalGetParameter.call(this, parameter);
        };

        if (typeof WebGL2RenderingContext !== 'undefined') {
            const originalGetParameter2 = WebGL2RenderingContext.prototype.getParameter;
            WebGL2RenderingContext.prototype.getParameter = function(parameter) {
                if (parameter === 37445) return 'Intel Inc.';
                if (parameter === 37446) return 'Intel Iris OpenGL Engine';
                return originalGetParameter2.call(this, parameter);
            };
        }

        patchGetter(Navigator.prototype, 'userAgentData', {
            brands: [
                { brand: 'Chromium', version: '123' },
                { brand: 'Google Chrome', version: '123' },
            ],
            mobile: false,
            platform: 'Windows',
            getHighEntropyValues: async () => ({
                architecture: 'x86',
                bitness: '64',
                model: '',
                platform: 'Windows',
                platformVersion: '10.0.0',
                uaFullVersion: '123.0.0.0',
                wow64: false,
                fullVersionList: [
                    { brand: 'Chromium', version: '123.0.0.0' },
                    { brand: 'Google Chrome', version: '123.0.0.0' },
                ],
            }),
            toJSON: () => ({
                brands: [
                    { brand: 'Chromium', version: '123' },
                    { brand: 'Google Chrome', version: '123' },
                ],
                mobile: false,
                platform: 'Windows',
            }),
        });
            `
            : '';

        return `
(() => {
    const patchGetter = (obj, prop, value) => {
        try {
            Object.defineProperty(obj, prop, {
                get: () => value,
                configurable: true,
            });
        } catch {
            // Ignore non-configurable properties
        }
    };

    patchGetter(Navigator.prototype, 'webdriver', undefined);
    patchGetter(Navigator.prototype, 'languages', ['en-US', 'en']);
    patchGetter(Navigator.prototype, 'platform', 'Win32');
    patchGetter(Navigator.prototype, 'hardwareConcurrency', 8);
    patchGetter(Navigator.prototype, 'deviceMemory', 8);
    patchGetter(Navigator.prototype, 'plugins', [1, 2, 3, 4, 5]);

    if (!window.chrome) {
        Object.defineProperty(window, 'chrome', {
            value: { runtime: {} },
            configurable: true,
        });
    } else if (!window.chrome.runtime) {
        window.chrome.runtime = {};
    }

    if (navigator.permissions && navigator.permissions.query) {
        const originalQuery = navigator.permissions.query.bind(navigator.permissions);
        navigator.permissions.query = (parameters) => {
            if (parameters && parameters.name === 'notifications') {
                return Promise.resolve({
                    state: Notification.permission,
                    onchange: null,
                    addEventListener: () => {},
                    removeEventListener: () => {},
                    dispatchEvent: () => false,
                });
            }
            return originalQuery(parameters);
        };
    }

    ${balancedEnhancements}
})();
        `;
    }

    private resetIdleTimer() {
        this.clearIdleTimer();
        this.idleTimeout = setTimeout(() => this.close(), this.IDLE_TIME_MS);
        // Don't keep the process alive just for idle cleanup
        this.idleTimeout.unref();
    }

    private clearIdleTimer() {
        if (this.idleTimeout) {
            clearTimeout(this.idleTimeout);
            this.idleTimeout = null;
        }
    }

    async close(force = false) {
        // Skip close if pages are still active (idle timer will retry), unless forced
        if (this.activePages > 0 && !force) return;

        // Clear idle timer to prevent stale timer from closing a future browser instance
        this.clearIdleTimer();

        if (this.closing) {
            return this.closing;
        }

        this.closing = (async () => {
            try {
                this.launchPromise = null;
                if (this.browser) {
                    console.log('[BrowserManager] Closing browser instance.');
                    const b = this.browser;
                    this.browser = null;
                    await b.close().catch(() => {});
                }
            } finally {
                this.closing = null;
            }
        })();

        return this.closing;
    }

    /**
     * Attempt to dismiss cookie consent banners by clicking common accept buttons.
     * Fails silently if no banner is found.
     */
    private static readonly COOKIE_BANNER_TIMEOUT_MS = 2000; // 2s max for banner dismissal

    private async dismissCookieBanners(page: Page): Promise<void> {
        const acceptSelectors = [
            // Common accept button patterns
            'button[id*="accept"]',
            'button[class*="accept"]',
            'button[id*="agree"]',
            'button[class*="agree"]',
            'button[id*="consent"]',
            'button[class*="consent"]',
            // Popular cookie consent libraries
            '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll',  // Cookiebot
            '#onetrust-accept-btn-handler',  // OneTrust
            '.cc-accept-all',  // CookieConsent
            '.cc-allow',
            '[data-cookiefirst-action="accept"]',  // CookieFirst
            '#accept-cookies',
            '.cookie-accept',
            // Generic patterns
            'button:has-text("Accept")',
            'button:has-text("Accept All")',
            'button:has-text("Allow")',
            'button:has-text("Allow All")',
            'button:has-text("I agree")',
            'button:has-text("Got it")',
            'button:has-text("OK")',
        ];

        const urlBefore = page.url();
        const deadline = Date.now() + BrowserManager.COOKIE_BANNER_TIMEOUT_MS;

        for (const selector of acceptSelectors) {
            if (Date.now() > deadline) return; // Time budget exhausted
            try {
                const button = await page.$(selector);
                if (button && await button.isVisible()) {
                    await button.click();
                    // Wait briefly for banner to disappear
                    await page.waitForTimeout(300);
                    // Guard: abort if the click triggered navigation (form submit, etc.)
                    if (page.url() !== urlBefore) return;
                    return;
                }
            } catch {
                // Selector not found or click failed, continue to next
            }
        }
    }
}
