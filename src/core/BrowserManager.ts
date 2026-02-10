import { chromium, Browser, BrowserContext, BrowserContextOptions, Page, Route } from 'playwright-core';
import { StealthLevel } from '../types.js';

export interface BrowserPageResult {
    html: string;
    status: number;
    headers: Record<string, string>;
    finalUrl?: string;
}

export interface BrowserPageOptions {
    stealth?: boolean;
    stealthLevel?: StealthLevel;
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
                        args: ['--no-sandbox', '--disable-setuid-sandbox']
                    });
                    this.browser = browser;
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
    async getPage(url: string, waitForSelector?: string, options: BrowserPageOptions = {}): Promise<BrowserPageResult> {
        const stealth = options.stealth ?? false;
        const stealthLevel = options.stealthLevel ?? 'balanced';
        const browser = await this.launch();
        const context = await browser.newContext(this.getContextOptions(stealth));
        if (stealth) {
            await this.applyStealth(context, stealthLevel);
        }
        const page = await context.newPage();

        // Set default timeout for all operations to prevent hangs
        page.setDefaultTimeout(15000); // 15 seconds max for any operation

        this.clearIdleTimer(); // We are active

        try {
            // Optimization: Block unnecessary resources
            // This drastically reduces load time and bandwidth usage
            const blockedResourceTypes = stealth
                ? ['image', 'font', 'media']
                : ['image', 'stylesheet', 'font', 'media'];
            await page.route('**/*', (route: Route) => {
                const request = route.request();
                const resourceType = request.resourceType();
                if (blockedResourceTypes.includes(resourceType)) {
                    return route.abort();
                }
                return route.continue();
            });

            const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });

            // Try to dismiss cookie consent banners
            await this.dismissCookieBanners(page);

            if (waitForSelector) {
                await page.waitForSelector(waitForSelector, { timeout: 10000 });
            }

            // Extract content
            const content = await page.content();
            return {
                html: content,
                status: response?.status() ?? 200,
                headers: response?.headers() ?? {},
                finalUrl: response?.url(),
            };
        } catch (e: any) {
            console.error(`[BrowserManager] Failed to load ${url}: ${e.message}`);
            throw e;
        } finally {
            await context.close().catch(() => {});
            this.resetIdleTimer();
        }
    }

    private getContextOptions(stealth: boolean): BrowserContextOptions {
        if (!stealth) {
            return {
                userAgent: this.DEFAULT_USER_AGENT,
            };
        }

        return {
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
        };
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

    async close() {
        this.launchPromise = null;
        if (this.browser) {
            console.log('[BrowserManager] Closing browser instance (idle).');
            await this.browser.close();
            this.browser = null;
        }
    }

    /**
     * Attempt to dismiss cookie consent banners by clicking common accept buttons.
     * Fails silently if no banner is found.
     */
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

        for (const selector of acceptSelectors) {
            try {
                const button = await page.$(selector);
                if (button && await button.isVisible()) {
                    await button.click();
                    // Wait briefly for banner to disappear
                    await page.waitForTimeout(300);
                    return;
                }
            } catch {
                // Selector not found or click failed, continue to next
            }
        }
    }
}
