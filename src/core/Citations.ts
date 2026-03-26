/**
 * Convert inline markdown links to numbered footnote citations.
 *
 * Input:  "Visit [Example](https://example.com) and [Docs](https://docs.example.com)."
 * Output: "Visit Example[1] and Docs[2].\n\n---\n[1] https://example.com\n[2] https://docs.example.com"
 *
 * Deduplicates URLs — same URL gets the same footnote number.
 * Image references ![alt](url) are converted to "[Image: alt][N]".
 */
export function markdownToCitations(markdown: string): string {
    const urlToIndex = new Map<string, number>();
    const references: Array<{ index: number; url: string }> = [];
    let nextIndex = 1;

    const getIndex = (url: string): number => {
        const existing = urlToIndex.get(url);
        if (existing !== undefined) return existing;
        const idx = nextIndex++;
        urlToIndex.set(url, idx);
        references.push({ index: idx, url });
        return idx;
    };

    // Process the markdown — replace links with citations
    // Handle images first: ![alt](url) → [Image: alt][N]
    // Then regular links: [text](url) → text[N]
    // Preserve links inside code blocks (backtick-fenced)
    const parts: string[] = [];
    let i = 0;
    const len = markdown.length;

    while (i < len) {
        // Check for fenced code blocks (``` ... ```)
        if (markdown.startsWith('```', i)) {
            const endFence = markdown.indexOf('```', i + 3);
            if (endFence !== -1) {
                parts.push(markdown.slice(i, endFence + 3));
                i = endFence + 3;
                continue;
            }
        }

        // Check for inline code (`...`)
        if (markdown[i] === '`') {
            const endTick = markdown.indexOf('`', i + 1);
            if (endTick !== -1) {
                parts.push(markdown.slice(i, endTick + 1));
                i = endTick + 1;
                continue;
            }
        }

        // Check for image: ![alt](url)
        if (markdown[i] === '!' && i + 1 < len && markdown[i + 1] === '[') {
            const match = parseLink(markdown, i + 1);
            if (match) {
                const idx = getIndex(match.url);
                const alt = match.text || 'Image';
                parts.push(`[Image: ${alt}][${idx}]`);
                i = match.end;
                continue;
            }
        }

        // Check for link: [text](url)
        if (markdown[i] === '[') {
            const match = parseLink(markdown, i);
            if (match) {
                const idx = getIndex(match.url);
                parts.push(`${match.text}[${idx}]`);
                i = match.end;
                continue;
            }
        }

        parts.push(markdown[i]);
        i++;
    }

    let result = parts.join('');

    // Append reference list
    if (references.length > 0) {
        result += '\n\n---\n';
        for (const ref of references) {
            result += `[${ref.index}] ${ref.url}\n`;
        }
    }

    return result;
}

interface LinkMatch {
    text: string;
    url: string;
    end: number;
}

/** Parse a markdown link starting at `[` position. Returns null if not a valid link. */
function parseLink(s: string, start: number): LinkMatch | null {
    if (s[start] !== '[') return null;

    // Find the closing ]
    let depth = 0;
    let textEnd = -1;
    for (let j = start; j < s.length; j++) {
        if (s[j] === '[') depth++;
        else if (s[j] === ']') {
            depth--;
            if (depth === 0) { textEnd = j; break; }
        }
    }
    if (textEnd === -1) return null;

    // Must be followed by (
    if (textEnd + 1 >= s.length || s[textEnd + 1] !== '(') return null;

    // Find the closing )
    const urlStart = textEnd + 2;
    let parenDepth = 1;
    let urlEnd = -1;
    for (let j = urlStart; j < s.length; j++) {
        if (s[j] === '(') parenDepth++;
        else if (s[j] === ')') {
            parenDepth--;
            if (parenDepth === 0) { urlEnd = j; break; }
        }
    }
    if (urlEnd === -1) return null;

    const text = s.slice(start + 1, textEnd);
    let url = s.slice(urlStart, urlEnd).trim();

    // Strip optional title: [text](url "title")
    const titleMatch = url.match(/^(.+?)\s+"[^"]*"$/);
    if (titleMatch) url = titleMatch[1];

    // Skip empty URLs or fragment-only links
    if (!url || url.startsWith('#')) return null;

    return { text, url, end: urlEnd + 1 };
}
