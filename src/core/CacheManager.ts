import { ScrapedPage } from '../types.js';

/**
 * Simple in-memory LRU (Least Recently Used) cache.
 * Prevents redundant fetches for the same URL + Config combination.
 */
export class CacheManager {
    private cache: Map<string, { data: ScrapedPage; timestamp: number }>;
    private readonly ttl: number; // Time to live in ms
    private readonly maxSize: number;

    constructor(ttl = 60000 * 5, maxSize = 100) { // Default 5 mins, 100 items
        this.cache = new Map();
        // Guard NaN: NaN comparisons always return false, making TTL checks pass for expired items
        this.ttl = Number.isFinite(ttl) ? Math.max(0, ttl) : 60000 * 5;
        this.maxSize = Number.isFinite(maxSize) ? Math.max(1, maxSize) : 100;
    }

    /**
     * Retrieve item and update its position (LRU).
     * Preserves original timestamp for TTL expiry.
     */
    get(key: string): ScrapedPage | null {
        const item = this.cache.get(key);
        if (!item) return null;

        if (Date.now() - item.timestamp > this.ttl) {
            this.cache.delete(key);
            return null;
        }

        // Re-insert to refresh LRU order but keep original timestamp for TTL
        this.cache.delete(key);
        this.cache.set(key, item);

        // Deep-copy to prevent caller mutations from corrupting the cache.
        // structuredClone handles nested objects (metadata, links, chunks).
        try {
            return structuredClone(item.data);
        } catch {
            // Non-cloneable value (shouldn't happen with JSON-like ScrapedPage, but defensive)
            this.cache.delete(key);
            return null;
        }
    }

    set(key: string, data: ScrapedPage): void {
        // Delete first to update LRU position if key already exists
        this.cache.delete(key);
        if (this.cache.size >= this.maxSize) {
            // Evict oldest (first key in iteration)
            const oldestKey = this.cache.keys().next().value;
            if (oldestKey) {
                this.cache.delete(oldestKey);
            }
        }
        // Store a deep copy to isolate from caller mutations
        try {
            this.cache.set(key, { data: structuredClone(data), timestamp: Date.now() });
        } catch {
            // Non-cloneable value — skip caching rather than crashing
        }
    }

    clear(): void {
        this.cache.clear();
    }
}
