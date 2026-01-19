import { chromium, Browser, BrowserContext, Page, Route } from 'playwright-core';

/**
 * Manages Headless Browser instances (Playwright).
 * Implements Singleton pattern to share browser instance across requests.
 * Automatic idle cleanup to save memory.
 */
export class BrowserManager {
    private browser: Browser | null = null;
    private static instance: BrowserManager;
    private idleTimeout: NodeJS.Timeout | null = null;
    private readonly IDLE_TIME_MS = 30000; // 30 seconds idle close

    // Singleton
    static getInstance(): BrowserManager {
        if (!BrowserManager.instance) {
            BrowserManager.instance = new BrowserManager();
        }
        return BrowserManager.instance;
    }

    private launchPromise: Promise<Browser> | null = null;

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
    async getPage(url: string, waitForSelector?: string): Promise<string> {
        const browser = await this.launch();
        const context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        });
        const page = await context.newPage();

        // Set default timeout for all operations to prevent hangs
        page.setDefaultTimeout(15000); // 15 seconds max for any operation

        this.clearIdleTimer(); // We are active

        try {
            // Optimization: Block unnecessary resources
            // This drastically reduces load time and bandwidth usage
            await page.route('**/*', (route: Route) => {
                const request = route.request();
                const resourceType = request.resourceType();
                if (['image', 'stylesheet', 'font', 'media'].includes(resourceType)) {
                    return route.abort();
                }
                return route.continue();
            });

            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });


            if (waitForSelector) {
                await page.waitForSelector(waitForSelector, { timeout: 10000 });
            }

            // Extract content
            const content = await page.content();

            await context.close();
            this.resetIdleTimer();

            return content;
        } catch (e: any) {
            console.error(`[BrowserManager] Failed to load ${url}: ${e.message}`);
            await context.close();
            this.resetIdleTimer();
            throw e;
        }
    }

    private resetIdleTimer() {
        this.clearIdleTimer();
        this.idleTimeout = setTimeout(() => this.close(), this.IDLE_TIME_MS);
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
}
