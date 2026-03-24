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
    private pruning = false;

    constructor(private readonly options: DiskKvOptions) {}

    private keyToFilename(key: string): string {
        const hash = createHash('sha256').update(key).digest('hex');
        return path.join(this.options.dir, `${hash}.json`);
    }

    private async ensureDir(): Promise<void> {
        await fs.mkdir(this.options.dir, { recursive: true });
    }

    private isValidStored(parsed: unknown): parsed is Stored<T> {
        return (
            parsed !== null &&
            typeof parsed === 'object' &&
            'ts' in parsed &&
            typeof (parsed as any).ts === 'number' &&
            'value' in parsed
        );
    }

    async get(key: string): Promise<T | null> {
        await this.ensureDir();
        const filename = this.keyToFilename(key);
        try {
            const raw = await fs.readFile(filename, 'utf-8');
            const parsed: unknown = JSON.parse(raw);
            if (!this.isValidStored(parsed)) return null;
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
        try {
            await fs.writeFile(tmp, JSON.stringify(payload), 'utf-8');
            await fs.rename(tmp, filename);
        } catch (e) {
            await fs.unlink(tmp).catch(() => {});
            throw e;
        }
        await this.prune().catch(() => {});
    }

    private async prune(): Promise<void> {
        if (this.pruning) return;
        this.pruning = true;
        try {
            await this.pruneImpl();
        } finally {
            this.pruning = false;
        }
    }

    private async pruneImpl(): Promise<void> {
        const entries = await fs.readdir(this.options.dir, { withFileTypes: true });
        const jsonFiles = entries.filter((e) => e.isFile() && e.name.endsWith('.json'));
        if (jsonFiles.length <= this.options.maxEntries) return;

        const statResults = await Promise.all(
            jsonFiles.map(async (e) => {
                const p = path.join(this.options.dir, e.name);
                try {
                    const st = await fs.stat(p);
                    return { p, mtimeMs: st.mtimeMs };
                } catch {
                    return null; // File deleted between readdir and stat
                }
            })
        );
        const stats = statResults.filter((s): s is NonNullable<typeof s> => s !== null);
        if (stats.length <= this.options.maxEntries) return;
        stats.sort((a, b) => a.mtimeMs - b.mtimeMs);

        const toDelete = stats.slice(0, Math.max(0, stats.length - this.options.maxEntries));
        await Promise.all(toDelete.map((f) => fs.unlink(f.p).catch(() => {})));
    }
}

