import { ContentChunk } from '../types.js';

function approxTokens(text: string): number {
    return Math.max(1, Math.ceil(text.length / 4));
}

function slugify(input: string): string | undefined {
    const result = input
        .toLowerCase()
        .trim()
        .replace(/[^\w\s-]/g, '')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .slice(0, 80);
    return result || undefined; // Return undefined instead of empty string
}

export interface ChunkerOptions {
    url: string;
    maxTokens: number;
    overlapTokens: number;
}

export function chunkMarkdown(markdown: string, options: ChunkerOptions): ContentChunk[] {
    const lines = markdown.split('\n');
    const blocks: Array<{ headingPath: string[]; text: string }> = [];

    let headingPath: string[] = [];
    let current: string[] = [];
    let currentPath: string[] = [];

    const flush = () => {
        const text = current.join('\n').trim();
        if (text) blocks.push({ headingPath: currentPath, text });
        current = [];
    };

    for (const line of lines) {
        const m = /^(#{1,6})\s+(.*)$/.exec(line);
        if (m) {
            flush();
            const level = m[1].length;
            const title = m[2].trim();
            headingPath = headingPath.slice(0, level - 1);
            headingPath.push(title);
            currentPath = [...headingPath];
            current.push(line);
        } else {
            if (current.length === 0) currentPath = [...headingPath];
            current.push(line);
        }
    }
    flush();

    const maxTokens = Math.max(50, Number.isFinite(options.maxTokens) ? options.maxTokens : 1200);
    const maxChars = maxTokens * 4;
    // Clamp overlap to less than maxTokens to prevent oversized chunks
    const rawOverlap = Math.max(0, Number.isFinite(options.overlapTokens) ? options.overlapTokens : 0);
    const overlapChars = Math.min(rawOverlap, Math.floor(maxTokens * 0.5)) * 4;

    const MAX_CHUNKS = 10_000;
    const chunks: ContentChunk[] = [];
    let buf = '';
    let bufPath: string[] = [];
    let lastChunkTail = '';

    const emitText = (text: string, path: string[]) => {
        text = text.trim();
        if (!text || chunks.length >= MAX_CHUNKS) return;
        // Snapshot path so chunks don't share a mutable reference
        const safePath = [...path];

        // If text still exceeds maxChars, split at word/sentence boundaries
        if (text.length > maxChars) {
            let remaining = text;
            while (remaining.length > maxChars && chunks.length < MAX_CHUNKS) {
                // Find a split point: prefer sentence end, then word boundary
                let splitAt = maxChars;
                const sentenceEnd = remaining.lastIndexOf('. ', maxChars);
                if (sentenceEnd > maxChars * 0.5) {
                    splitAt = sentenceEnd + 1; // include the period
                } else {
                    const wordBreak = remaining.lastIndexOf(' ', maxChars);
                    if (wordBreak > maxChars * 0.3) {
                        splitAt = wordBreak;
                    }
                }
                const piece = remaining.slice(0, splitAt).trim();
                if (piece) {
                    const id = `chunk_${chunks.length + 1}`;
                    const anchorHeading = safePath.length ? safePath[safePath.length - 1] : '';
                    const anchor = anchorHeading ? slugify(anchorHeading) : undefined;
                    chunks.push({ id, text: piece, approxTokens: approxTokens(piece), headingPath: safePath, citation: { url: options.url, anchor } });
                }
                remaining = remaining.slice(splitAt).trim();
            }
            if (remaining && chunks.length < MAX_CHUNKS) {
                const id = `chunk_${chunks.length + 1}`;
                const anchorHeading = safePath.length ? safePath[safePath.length - 1] : '';
                const anchor = anchorHeading ? slugify(anchorHeading) : undefined;
                chunks.push({ id, text: remaining, approxTokens: approxTokens(remaining), headingPath: safePath, citation: { url: options.url, anchor } });
                lastChunkTail = overlapChars > 0 ? remaining.slice(Math.max(0, remaining.length - overlapChars)) : '';
            }
            return;
        }

        const id = `chunk_${chunks.length + 1}`;
        const anchorHeading = safePath.length ? safePath[safePath.length - 1] : '';
        const anchor = anchorHeading ? slugify(anchorHeading) : undefined;
        chunks.push({
            id,
            text,
            approxTokens: approxTokens(text),
            headingPath: safePath,
            citation: { url: options.url, anchor },
        });
        lastChunkTail = overlapChars > 0 ? text.slice(Math.max(0, text.length - overlapChars)) : '';
    };

    const emit = () => {
        emitText(buf, bufPath);
        buf = '';
    };

    for (const block of blocks) {
        const candidate = (buf ? `${buf}\n\n${block.text}` : block.text).trim();
        if (approxTokens(candidate) <= maxTokens) {
            buf = candidate;
            bufPath = block.headingPath;
            continue;
        }

        // Emit current buffer before processing this block.
        emit();

        // If the block itself exceeds maxTokens, split it at line boundaries.
        if (approxTokens(block.text) > maxTokens) {
            const blockLines = block.text.split('\n');
            let lineBuf = lastChunkTail || '';
            for (const ln of blockLines) {
                const next = lineBuf ? `${lineBuf}\n${ln}` : ln;
                if (next.length > maxChars && lineBuf) {
                    buf = lineBuf.trim();
                    bufPath = block.headingPath;
                    emit();
                    lineBuf = (lastChunkTail ? `${lastChunkTail}\n${ln}` : ln);
                } else {
                    lineBuf = next;
                }
            }
            buf = lineBuf.trim();
            bufPath = block.headingPath;
        } else {
            const withOverlap = lastChunkTail ? `${lastChunkTail}\n\n${block.text}` : block.text;
            // If overlap pushes over limit, drop it to avoid oversized chunks
            buf = (withOverlap.length > maxChars && lastChunkTail ? block.text : withOverlap).trim();
            bufPath = block.headingPath;
        }
    }
    emit();

    return chunks;
}

