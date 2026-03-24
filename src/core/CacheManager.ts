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
        this.ttl = ttl;
        this.maxSize = maxSize;
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

        return item.data;
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
        this.cache.set(key, { data, timestamp: Date.now() });
    }

    clear(): void {
        this.cache.clear();
    }
}
