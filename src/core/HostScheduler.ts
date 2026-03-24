export class HostScheduler {
    private inflightByHost = new Map<string, number>();
    private lastStartByHost = new Map<string, number>();
    private cleanupTimers = new Map<string, NodeJS.Timeout>();
    private readonly perHostConcurrency: number;
    private readonly minDelayMs: number;
    private static readonly MAX_ACQUIRE_WAIT_MS = 120_000; // 2 minute max wait
    private static readonly MAX_TRACKED_HOSTS = 10_000; // Cap to prevent memory leaks

    constructor(perHostConcurrency: number, minDelayMs: number) {
        // Guard: concurrency of 0 would cause acquire() to spin forever
        this.perHostConcurrency = Math.max(1, Number.isFinite(perHostConcurrency) ? perHostConcurrency : 1);
        // Guard: NaN minDelayMs would make waitForDelay === 0 always false, spinning until deadline
        this.minDelayMs = Number.isFinite(minDelayMs) ? Math.max(0, Math.min(minDelayMs, 60_000)) : 0;
    }

    async run<T>(host: string, fn: () => Promise<T>): Promise<T> {
        await this.acquire(host);
        try {
            return await fn();
        } finally {
            this.release(host);
        }
    }

    private async acquire(host: string): Promise<void> {
        // Sweep stale entries if maps grow too large (defense-in-depth)
        if (this.lastStartByHost.size > HostScheduler.MAX_TRACKED_HOSTS) {
            const now = Date.now();
            for (const [h, ts] of this.lastStartByHost) {
                if (!this.inflightByHost.has(h) && (now - ts) > this.minDelayMs) {
                    this.lastStartByHost.delete(h);
                }
            }
        }

        const deadline = Date.now() + HostScheduler.MAX_ACQUIRE_WAIT_MS;
        while (true) {
            const inflight = this.inflightByHost.get(host) ?? 0;
            const lastStart = this.lastStartByHost.get(host) ?? 0;
            const now = Date.now();

            if (now > deadline) {
                throw new Error(`HostScheduler: timed out waiting to acquire slot for ${host}`);
            }

            const waitForDelay = Math.max(0, this.minDelayMs - (now - lastStart));

            if (inflight < this.perHostConcurrency && waitForDelay <= 0) {
                this.inflightByHost.set(host, inflight + 1);
                this.lastStartByHost.set(host, now);
                return;
            }

            const sleepMs = Math.min(waitForDelay > 0 ? waitForDelay : 25, 1000);
            await new Promise((r) => setTimeout(r, sleepMs));
        }
    }

    private release(host: string): void {
        const inflight = this.inflightByHost.get(host) ?? 0;
        if (inflight <= 1) {
            this.inflightByHost.delete(host);
            // Keep lastStartByHost so minDelayMs is enforced for the next request.
            // Schedule cleanup after the delay window to prevent unbounded map growth.
            if (this.minDelayMs > 0) {
                // Cancel any existing cleanup timer to prevent accumulation
                const existing = this.cleanupTimers.get(host);
                if (existing) clearTimeout(existing);
                const timer = setTimeout(() => {
                    this.cleanupTimers.delete(host);
                    // Only delete if no new requests started for this host
                    if (!this.inflightByHost.has(host)) {
                        this.lastStartByHost.delete(host);
                    }
                }, this.minDelayMs);
                timer.unref();
                this.cleanupTimers.set(host, timer);
            } else {
                this.lastStartByHost.delete(host);
            }
            return;
        }
        this.inflightByHost.set(host, inflight - 1);
    }
}

