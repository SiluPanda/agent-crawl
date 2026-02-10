export class HostScheduler {
    private inflightByHost = new Map<string, number>();
    private lastStartByHost = new Map<string, number>();

    constructor(
        private readonly perHostConcurrency: number,
        private readonly minDelayMs: number
    ) {}

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
            return;
        }
        this.inflightByHost.set(host, inflight - 1);
    }
}

