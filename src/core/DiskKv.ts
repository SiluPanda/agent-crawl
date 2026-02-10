import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

export interface DiskKvOptions {
    dir: string;
    ttlMs: number;
    maxEntries: number;
}

type Stored<T> = { ts: number; value: T };

export class DiskKv<T> {
    constructor(private readonly options: DiskKvOptions) {}

    private keyToFilename(key: string): string {
        const hash = createHash('sha256').update(key).digest('hex');
        return path.join(this.options.dir, `${hash}.json`);
    }

    private async ensureDir(): Promise<void> {
        await fs.mkdir(this.options.dir, { recursive: true });
    }

    async get(key: string): Promise<T | null> {
        await this.ensureDir();
        const filename = this.keyToFilename(key);
        try {
            const raw = await fs.readFile(filename, 'utf-8');
            const parsed = JSON.parse(raw) as Stored<T>;
            if (!parsed || typeof parsed.ts !== 'number') return null;
            if (Date.now() - parsed.ts > this.options.ttlMs) {
                await fs.unlink(filename).catch(() => {});
                return null;
            }
            return parsed.value ?? null;
        } catch {
            return null;
        }
    }

    async set(key: string, value: T): Promise<void> {
        await this.ensureDir();
        const filename = this.keyToFilename(key);
        const tmp = `${filename}.tmp`;
        const payload: Stored<T> = { ts: Date.now(), value };
        await fs.writeFile(tmp, JSON.stringify(payload), 'utf-8');
        await fs.rename(tmp, filename);
        await this.prune().catch(() => {});
    }

    private async prune(): Promise<void> {
        const entries = await fs.readdir(this.options.dir, { withFileTypes: true });
        const jsonFiles = entries.filter((e) => e.isFile() && e.name.endsWith('.json'));
        if (jsonFiles.length <= this.options.maxEntries) return;

        const stats = await Promise.all(
            jsonFiles.map(async (e) => {
                const p = path.join(this.options.dir, e.name);
                const st = await fs.stat(p);
                return { p, mtimeMs: st.mtimeMs };
            })
        );
        stats.sort((a, b) => a.mtimeMs - b.mtimeMs);

        const toDelete = stats.slice(0, Math.max(0, stats.length - this.options.maxEntries));
        await Promise.all(toDelete.map((f) => fs.unlink(f.p).catch(() => {})));
    }
}

