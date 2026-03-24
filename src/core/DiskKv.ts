import { createHash, randomBytes } from 'node:crypto';
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
    private dirEnsured = false;

    constructor(private readonly options: DiskKvOptions) {
        // Clamp to sane limits; guard NaN to prevent non-expiring entries / disabled pruning
        const ttl = Number.isFinite(options.ttlMs) ? options.ttlMs : 5 * 60_000;
        const max = Number.isFinite(options.maxEntries) ? options.maxEntries : 1000;
        this.options = {
            ...options,
            ttlMs: Math.max(1000, Math.min(ttl, 7 * 24 * 60 * 60_000)), // 1s to 7 days
            maxEntries: Math.max(1, Math.min(max, 100_000)),
        };
    }

    private keyToFilename(key: string): string {
        const hash = createHash('sha256').update(key).digest('hex');
        return path.join(this.options.dir, `${hash}.json`);
    }

    private async ensureDir(): Promise<void> {
        if (this.dirEnsured) return;
        await fs.mkdir(this.options.dir, { recursive: true });
        this.dirEnsured = true;
    }

    private static readonly MAX_FILE_BYTES = 50 * 1024 * 1024; // 50MB safety cap per entry

    private isValidStored(parsed: unknown): parsed is Stored<T> {
        return (
            parsed !== null &&
            typeof parsed === 'object' &&
            !Array.isArray(parsed) &&
            'ts' in parsed &&
            typeof (parsed as any).ts === 'number' &&
            Number.isFinite((parsed as any).ts) &&
            'value' in parsed
        );
    }

    async get(key: string): Promise<T | null> {
        await this.ensureDir();
        const filename = this.keyToFilename(key);
        try {
            // Size check to prevent OOM from tampered cache files
            const stat = await fs.stat(filename);
            if (stat.size > DiskKv.MAX_FILE_BYTES) {
                await fs.unlink(filename).catch(() => {});
                return null;
            }
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

    private isPathSafe(filePath: string): boolean {
        const resolved = path.resolve(filePath);
        const dirResolved = path.resolve(this.options.dir);
        return resolved.startsWith(dirResolved + path.sep) || resolved === dirResolved;
    }

    async set(key: string, value: T): Promise<void> {
        await this.ensureDir();
        const filename = this.keyToFilename(key);
        if (!this.isPathSafe(filename)) throw new Error('Path traversal detected');
        // Unique tmp filename to prevent race conditions between concurrent writes
        const suffix = `${process.pid}.${randomBytes(4).toString('hex')}`;
        const tmp = `${filename}.${suffix}.tmp`;
        const payload: Stored<T> = { ts: Date.now(), value };
        const json = JSON.stringify(payload);
        const jsonBytes = Buffer.byteLength(json, 'utf-8');
        if (jsonBytes > DiskKv.MAX_FILE_BYTES) {
            throw new Error(`Cache entry too large to write (${jsonBytes} bytes, max ${DiskKv.MAX_FILE_BYTES})`);
        }
        try {
            await fs.writeFile(tmp, json, 'utf-8');
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

    // SHA-256 hex hash pattern: 64 hex chars followed by .json
    private static readonly CACHE_FILE_PATTERN = /^[0-9a-f]{64}\.json$/;

    private async pruneImpl(): Promise<void> {
        const entries = await fs.readdir(this.options.dir, { withFileTypes: true });

        // Clean up stale .tmp files older than 5 minutes (orphaned from crashed writes)
        const tmpFiles = entries.filter((e) => e.isFile() && e.name.endsWith('.tmp'));
        for (const tmp of tmpFiles) {
            const p = path.join(this.options.dir, tmp.name);
            try {
                const st = await fs.stat(p);
                if (Date.now() - st.mtimeMs > 5 * 60_000) {
                    await fs.unlink(p).catch(() => {});
                }
            } catch { /* already deleted */ }
        }

        // Only process files matching expected cache filename pattern to avoid pruning non-cache files
        const jsonFiles = entries.filter((e) => e.isFile() && DiskKv.CACHE_FILE_PATTERN.test(e.name));
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

