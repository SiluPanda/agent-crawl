export class HostScheduler {
    private inflightByHost = new Map<string, number>();
    private lastStartByHost = new Map<string, number>();
    private readonly perHostConcurrency: number;
    private readonly minDelayMs: number;

    constructor(perHostConcurrency: number, minDelayMs: number) {
        // Guard: concurrency of 0 would cause acquire() to spin forever
        this.perHostConcurrency = Math.max(1, perHostConcurrency);
        this.minDelayMs = minDelayMs;
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
        while (true) {
            const inflight = this.inflightByHost.get(host) ?? 0;
            const lastStart = this.lastStartByHost.get(host) ?? 0;
            const now = Date.now();
            const waitForDelay = Math.max(0, this.minDelayMs - (now - lastStart));

            if (inflight < this.perHostConcurrency && waitForDelay === 0) {
                this.inflightByHost.set(host, inflight + 1);
                this.lastStartByHost.set(host, now);
                return;
            }

            const sleepMs = waitForDelay > 0 ? waitForDelay : 25;
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
                setTimeout(() => {
                    // Only delete if no new requests started for this host
                    if (!this.inflightByHost.has(host)) {
                        this.lastStartByHost.delete(host);
                    }
                }, this.minDelayMs).unref();
            } else {
                this.lastStartByHost.delete(host);
            }
            return;
        }
        this.inflightByHost.set(host, inflight - 1);
    }
}

