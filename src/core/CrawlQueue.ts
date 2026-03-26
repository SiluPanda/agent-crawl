import type { CrawlStrategy } from '../types.js';

export interface QueueItem {
    url: string;
    depth: number;
    score?: number;
}

export interface ICrawlQueue {
    push(item: QueueItem): void;
    shift(): QueueItem | undefined;
    readonly length: number;
    toArray(): QueueItem[];
}

/** FIFO queue with cursor optimization (O(1) dequeue). */
class BfsQueue implements ICrawlQueue {
    private items: QueueItem[] = [];
    private head = 0;

    push(item: QueueItem) { this.items.push(item); }

    shift(): QueueItem | undefined {
        if (this.head >= this.items.length) return undefined;
        const item = this.items[this.head++];
        // Compact periodically to release consumed entries for GC
        if (this.head > 10_000) {
            this.items = this.items.slice(this.head);
            this.head = 0;
        }
        return item;
    }

    get length() { return this.items.length - this.head; }

    toArray(): QueueItem[] { return this.items.slice(this.head); }
}

/** LIFO stack — newly discovered links processed first (depth-first). */
class DfsQueue implements ICrawlQueue {
    private items: QueueItem[] = [];

    push(item: QueueItem) { this.items.push(item); }

    shift(): QueueItem | undefined { return this.items.pop(); }

    get length() { return this.items.length; }

    toArray(): QueueItem[] { return [...this.items]; }
}

/** Priority queue — highest-scored URLs dequeued first. */
class BestFirstQueue implements ICrawlQueue {
    private items: QueueItem[] = [];

    push(item: QueueItem) { this.items.push(item); }

    shift(): QueueItem | undefined {
        if (this.items.length === 0) return undefined;
        let maxIdx = 0;
        let maxScore = this.items[0].score ?? 0;
        for (let i = 1; i < this.items.length; i++) {
            const s = this.items[i].score ?? 0;
            if (s > maxScore) { maxScore = s; maxIdx = i; }
        }
        // Remove and return the highest-score item
        const [item] = this.items.splice(maxIdx, 1);
        return item;
    }

    get length() { return this.items.length; }

    toArray(): QueueItem[] { return [...this.items]; }
}

/**
 * Score a URL by counting how many priority keywords appear in it.
 * Higher score = higher crawl priority.
 */
export function scoreUrl(url: string, keywords: string[]): number {
    if (!keywords.length) return 0;
    const lower = url.toLowerCase();
    let score = 0;
    for (const kw of keywords) {
        if (lower.includes(kw.toLowerCase())) score++;
    }
    return score;
}

/** Create a crawl queue for the given strategy. */
export function createCrawlQueue(strategy: CrawlStrategy): ICrawlQueue {
    switch (strategy) {
        case 'dfs': return new DfsQueue();
        case 'bestfirst': return new BestFirstQueue();
        case 'bfs':
        default: return new BfsQueue();
    }
}
