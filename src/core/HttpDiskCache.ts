import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

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
    private dirEnsured = false;

    constructor(private readonly options: HttpDiskCacheOptions) {
        // Clamp to sane limits; guard NaN to prevent non-expiring entries / disabled pruning
        const ttl = Number.isFinite(options.ttlMs) ? options.ttlMs : 5 * 60_000;
        const max = Number.isFinite(options.maxEntries) ? options.maxEntries : 1000;
        this.options = {
            ...options,
            ttlMs: Math.max(1000, Math.min(ttl, 7 * 24 * 60 * 60_000)), // 1s to 7 days
            maxEntries: Math.max(1, Math.min(max, 100_000)),
        };
    }

    private async ensureDir(): Promise<void> {
        if (this.dirEnsured) return;
        await fs.mkdir(this.options.dir, { recursive: true });
        this.dirEnsured = true;
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

    private static readonly MAX_META_BYTES = 1 * 1024 * 1024; // 1MB cap for meta files
    private static readonly MAX_BODY_BYTES = 50 * 1024 * 1024; // 50MB cap for body files

    private isValidEntry(parsed: unknown): parsed is HttpCacheEntry {
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
        const p = parsed as Record<string, unknown>;
        if (
            typeof p.ts !== 'number' ||
            !Number.isFinite(p.ts) ||
            typeof p.url !== 'string' ||
            typeof p.status !== 'number' ||
            !Number.isFinite(p.status) ||
            typeof p.bodyFile !== 'string' ||
            p.headers === null ||
            typeof p.headers !== 'object' ||
            Array.isArray(p.headers)
        ) return false;
        // Verify all header values are strings and cap count (defense against tampered cache files)
        const headerEntries = Object.entries(p.headers as Record<string, unknown>);
        if (headerEntries.length > 200) return false;
        for (const [, v] of headerEntries) {
            if (typeof v !== 'string') return false;
        }
        return true;
    }

    async get(url: string): Promise<{ entry: HttpCacheEntry; body: string } | null> {
        await this.ensureDir();
        const meta = this.metaPath(url);
        try {
            // Size check to prevent OOM from tampered cache files
            const metaStat = await fs.stat(meta);
            if (metaStat.size > HttpDiskCache.MAX_META_BYTES) {
                await this.delete(url).catch(() => {});
                return null;
            }
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
            const bodyFilePath = path.join(this.options.dir, safeBodyFile);
            const bodyStat = await fs.stat(bodyFilePath);
            if (bodyStat.size > HttpDiskCache.MAX_BODY_BYTES) {
                await this.delete(url).catch(() => {});
                return null;
            }
            const body = await fs.readFile(bodyFilePath, 'utf-8');
            return { entry, body };
        } catch {
            return null;
        }
    }

    private static readonly SENSITIVE_HEADERS = new Set([
        'set-cookie', 'authorization', 'proxy-authorization',
        'cookie', 'www-authenticate', 'proxy-authenticate',
    ]);

    private static readonly MAX_CACHED_HEADERS = 100;
    private static readonly MAX_HEADER_VALUE_LENGTH = 4096;

    private sanitizeHeaders(headers: Record<string, string>): Record<string, string> {
        const sanitized: Record<string, string> = Object.create(null);
        let count = 0;
        for (const [key, value] of Object.entries(headers)) {
            if (count >= HttpDiskCache.MAX_CACHED_HEADERS) break;
            // Skip sensitive headers and non-string values (defense against tampered data)
            if (typeof key !== 'string' || typeof value !== 'string') continue;
            if (HttpDiskCache.SENSITIVE_HEADERS.has(key.toLowerCase())) continue;
            sanitized[key] = value.length > HttpDiskCache.MAX_HEADER_VALUE_LENGTH
                ? value.slice(0, HttpDiskCache.MAX_HEADER_VALUE_LENGTH)
                : value;
            count++;
        }
        return sanitized;
    }

    private isPathSafe(filePath: string): boolean {
        const resolved = path.resolve(filePath);
        const dirResolved = path.resolve(this.options.dir);
        return resolved.startsWith(dirResolved + path.sep) || resolved === dirResolved;
    }

    async set(url: string, status: number, headers: Record<string, string>, body: string): Promise<void> {
        await this.ensureDir();
        const bodyFile = path.basename(this.bodyPath(url));
        const metaFile = this.metaPath(url);
        if (!this.isPathSafe(metaFile) || !this.isPathSafe(path.join(this.options.dir, bodyFile))) {
            throw new Error('Path traversal detected');
        }
        // Unique tmp filenames to prevent race conditions between concurrent writes
        const suffix = `${process.pid}.${randomBytes(4).toString('hex')}`;
        const tmpMeta = `${metaFile}.${suffix}.tmp`;
        const bodyFilePath = path.join(this.options.dir, bodyFile);
        const tmpBody = `${bodyFilePath}.${suffix}.tmp`;

        // Case-insensitive header lookup — HTTP/1.1 headers can have mixed case
        const findHeader = (name: string): string | undefined => {
            const lower = name.toLowerCase();
            for (const [k, v] of Object.entries(headers)) {
                if (k.toLowerCase() === lower) return v;
            }
            return undefined;
        };
        const etag = findHeader('etag');
        const lastModified = findHeader('last-modified');

        const entry: HttpCacheEntry = {
            ts: Date.now(),
            url,
            status,
            headers: this.sanitizeHeaders(headers),
            etag,
            lastModified,
            bodyFile,
        };

        if (Buffer.byteLength(body, 'utf-8') > HttpDiskCache.MAX_BODY_BYTES) {
            throw new Error(`Cache body too large to write (max ${HttpDiskCache.MAX_BODY_BYTES} bytes)`);
        }
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
            // Prune even on failure so the orphaned body file (written above) gets cleaned up
            await this.prune().catch(() => {});
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

    // SHA-256 hex hash patterns for cache files
    private static readonly META_FILE_PATTERN = /^[0-9a-f]{64}\.meta\.json$/;
    private static readonly BODY_FILE_PATTERN = /^[0-9a-f]{64}\.body\.txt$/;

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

        // Only process files matching expected cache filename patterns to avoid pruning non-cache files
        const metas = entries.filter((e) => e.isFile() && HttpDiskCache.META_FILE_PATTERN.test(e.name));

        // Clean up orphaned body files — .body.txt files without a matching .meta.json
        const metaHashes = new Set(metas.map((e) => e.name.replace('.meta.json', '')));
        const bodyFiles = entries.filter((e) => e.isFile() && HttpDiskCache.BODY_FILE_PATTERN.test(e.name));
        for (const body of bodyFiles) {
            const hash = body.name.replace('.body.txt', '');
            if (!metaHashes.has(hash)) {
                await fs.unlink(path.join(this.options.dir, body.name)).catch(() => {});
            }
        }

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
                // Derive body filename from meta hash to avoid reading meta files (prevents I/O + OOM)
                const metaBase = path.basename(f.p);
                const hash = metaBase.replace('.meta.json', '');
                const bodyFile = path.join(this.options.dir, `${hash}.body.txt`);
                await fs.unlink(f.p).catch(() => {});
                await fs.unlink(bodyFile).catch(() => {});
            })
        );
    }
}

