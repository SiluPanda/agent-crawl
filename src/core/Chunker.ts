import { ContentChunk } from '../types.js';

function approxTokens(text: string): number {
    return Math.max(1, Math.ceil(text.length / 4));
}

function slugify(input: string): string {
    return input
        .toLowerCase()
        .trim()
        .replace(/[^\w\s-]/g, '')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .slice(0, 80);
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

    const maxTokens = Math.max(50, options.maxTokens);
    const overlapChars = Math.max(0, options.overlapTokens) * 4;

    const chunks: ContentChunk[] = [];
    let buf = '';
    let bufPath: string[] = [];
    let lastChunkTail = '';

    const emit = () => {
        const text = buf.trim();
        if (!text) return;
        const id = `chunk_${chunks.length + 1}`;
        const anchorHeading = bufPath.length ? bufPath[bufPath.length - 1] : '';
        const anchor = anchorHeading ? slugify(anchorHeading) : undefined;
        chunks.push({
            id,
            text,
            approxTokens: approxTokens(text),
            headingPath: bufPath,
            citation: { url: options.url, anchor },
        });
        lastChunkTail = overlapChars > 0 ? text.slice(Math.max(0, text.length - overlapChars)) : '';
    };

    for (const block of blocks) {
        const candidate = (buf ? `${buf}\n\n${block.text}` : block.text).trim();
        if (approxTokens(candidate) <= maxTokens) {
            buf = candidate;
            bufPath = block.headingPath;
            continue;
        }

        // Emit current chunk and start a new one with optional overlap.
        emit();
        buf = (lastChunkTail ? `${lastChunkTail}\n\n${block.text}` : block.text).trim();
        bufPath = block.headingPath;
    }
    emit();

    return chunks;
}

