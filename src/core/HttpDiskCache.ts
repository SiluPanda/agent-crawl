import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export interface HttpDiskCacheOptions {
    dir: string;
    ttlMs: number;
    maxEntries: number;
}

export interface HttpCacheEntry {
    ts: number;
    url: string;
    status: number;
    headers: Record<string, string>;
    etag?: string;
    lastModified?: string;
    bodyFile: string;
}

export class HttpDiskCache {
    private pruning = false;

    constructor(private readonly options: HttpDiskCacheOptions) {}

    private async ensureDir(): Promise<void> {
        await fs.mkdir(this.options.dir, { recursive: true });
    }

    private key(url: string): string {
        return createHash('sha256').update(url).digest('hex');
    }

    private metaPath(url: string): string {
        return path.join(this.options.dir, `${this.key(url)}.meta.json`);
    }

    private bodyPath(url: string): string {
        return path.join(this.options.dir, `${this.key(url)}.body.txt`);
    }

    private isValidEntry(parsed: unknown): parsed is HttpCacheEntry {
        if (parsed === null || typeof parsed !== 'object') return false;
        const p = parsed as Record<string, unknown>;
        return (
            typeof p.ts === 'number' &&
            typeof p.url === 'string' &&
            typeof p.status === 'number' &&
            typeof p.bodyFile === 'string' &&
            p.headers !== null &&
            typeof p.headers === 'object'
        );
    }

    async get(url: string): Promise<{ entry: HttpCacheEntry; body: string } | null> {
        await this.ensureDir();
        const meta = this.metaPath(url);
        try {
            const raw = await fs.readFile(meta, 'utf-8');
            const parsed: unknown = JSON.parse(raw);
            if (!this.isValidEntry(parsed)) return null;
            const entry = parsed;
            if (Date.now() - entry.ts > this.options.ttlMs) {
                await this.delete(url).catch(() => {});
                return null;
            }
            // Sanitize bodyFile to prevent path traversal from tampered cache entries
            const safeBodyFile = path.basename(entry.bodyFile);
            const body = await fs.readFile(path.join(this.options.dir, safeBodyFile), 'utf-8');
            return { entry, body };
        } catch {
            return null;
        }
    }

    async set(url: string, status: number, headers: Record<string, string>, body: string): Promise<void> {
        await this.ensureDir();
        const bodyFile = path.basename(this.bodyPath(url));
        const metaFile = this.metaPath(url);
        const tmpMeta = `${metaFile}.tmp`;
        const bodyFilePath = path.join(this.options.dir, bodyFile);
        const tmpBody = `${bodyFilePath}.tmp`;

        const etag = headers['etag'] || headers['ETag'];
        const lastModified = headers['last-modified'] || headers['Last-Modified'];

        const entry: HttpCacheEntry = {
            ts: Date.now(),
            url,
            status,
            headers,
            etag,
            lastModified,
            bodyFile,
        };

        try {
            await fs.writeFile(tmpBody, body, 'utf-8');
            await fs.rename(tmpBody, bodyFilePath);
        } catch (e) {
            await fs.unlink(tmpBody).catch(() => {});
            throw e;
        }
        try {
            await fs.writeFile(tmpMeta, JSON.stringify(entry), 'utf-8');
            await fs.rename(tmpMeta, metaFile);
        } catch (e) {
            await fs.unlink(tmpMeta).catch(() => {});
            throw e;
        }

        await this.prune().catch(() => {});
    }

    async delete(url: string): Promise<void> {
        const meta = this.metaPath(url);
        const body = this.bodyPath(url);
        await fs.unlink(meta).catch(() => {});
        await fs.unlink(body).catch(() => {});
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
        const metas = entries.filter((e) => e.isFile() && e.name.endsWith('.meta.json'));
        if (metas.length <= this.options.maxEntries) return;

        const statResults = await Promise.all(
            metas.map(async (e) => {
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
        await Promise.all(
            toDelete.map(async (f) => {
                try {
                    const raw = await fs.readFile(f.p, 'utf-8');
                    const entry = JSON.parse(raw) as HttpCacheEntry;
                    await fs.unlink(f.p).catch(() => {});
                    if (entry?.bodyFile) {
                        await fs.unlink(path.join(this.options.dir, path.basename(entry.bodyFile))).catch(() => {});
                    }
                } catch {
                    await fs.unlink(f.p).catch(() => {});
                }
            })
        );
    }
}

