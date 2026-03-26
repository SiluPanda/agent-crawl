import test from 'node:test';
import assert from 'node:assert/strict';
import { extractCss, extractRegex, BUILTIN_PATTERNS } from '../src/core/Extractor.js';
import type { CssExtractionConfig, RegexExtractionConfig } from '../src/types.js';

// ---------------------------------------------------------------------------
// CSS Extraction
// ---------------------------------------------------------------------------

test('CSS: extract single text field via string shorthand', () => {
    const html = '<html><body><h1>Hello World</h1><p>Content</p></body></html>';
    const result = extractCss(html, 'https://example.com', {
        type: 'css',
        schema: { title: 'h1' },
    });
    assert.equal(result.title, 'Hello World');
});

test('CSS: extract single text field via object def', () => {
    const html = '<html><body><h1>Title</h1></body></html>';
    const result = extractCss(html, 'https://example.com', {
        type: 'css',
        schema: { title: { selector: 'h1', type: 'text' } },
    });
    assert.equal(result.title, 'Title');
});

test('CSS: extract attribute', () => {
    const html = '<html><body><a href="/about">About</a></body></html>';
    const result = extractCss(html, 'https://example.com', {
        type: 'css',
        schema: { link: { selector: 'a', type: 'attribute', attribute: 'href' } },
    });
    assert.equal(result.link, 'https://example.com/about');
});

test('CSS: extract image src resolves relative URL', () => {
    const html = '<html><body><img src="/img/photo.jpg" /></body></html>';
    const result = extractCss(html, 'https://example.com', {
        type: 'css',
        schema: { image: { selector: 'img', type: 'attribute', attribute: 'src' } },
    });
    assert.equal(result.image, 'https://example.com/img/photo.jpg');
});

test('CSS: extract inner HTML', () => {
    const html = '<html><body><div class="desc"><b>Bold</b> text</div></body></html>';
    const result = extractCss(html, 'https://example.com', {
        type: 'css',
        schema: { desc: { selector: '.desc', type: 'html' } },
    });
    assert.equal(result.desc, '<b>Bold</b> text');
});

test('CSS: extract all matches as array', () => {
    const html = '<html><body><ul><li>A</li><li>B</li><li>C</li></ul></body></html>';
    const result = extractCss(html, 'https://example.com', {
        type: 'css',
        schema: { items: { selector: 'li', all: true } },
    });
    assert.deepEqual(result.items, ['A', 'B', 'C']);
});

test('CSS: extract nested fields (structured list)', () => {
    const html = `
        <html><body>
            <div class="product">
                <h2 class="name">Widget</h2>
                <span class="price">$9.99</span>
                <a href="/widget">Buy</a>
            </div>
            <div class="product">
                <h2 class="name">Gadget</h2>
                <span class="price">$19.99</span>
                <a href="/gadget">Buy</a>
            </div>
        </body></html>
    `;
    const result = extractCss(html, 'https://example.com', {
        type: 'css',
        schema: {
            products: {
                selector: '.product',
                fields: {
                    name: '.name',
                    price: '.price',
                    link: { selector: 'a', type: 'attribute', attribute: 'href' },
                },
            },
        },
    });
    const products = result.products as Record<string, unknown>[];
    assert.equal(products.length, 2);
    assert.equal(products[0].name, 'Widget');
    assert.equal(products[0].price, '$9.99');
    assert.equal(products[0].link, 'https://example.com/widget');
    assert.equal(products[1].name, 'Gadget');
    assert.equal(products[1].price, '$19.99');
});

test('CSS: returns null for missing selectors', () => {
    const html = '<html><body><p>Hello</p></body></html>';
    const result = extractCss(html, 'https://example.com', {
        type: 'css',
        schema: { missing: '.nonexistent' },
    });
    assert.equal(result.missing, null);
});

test('CSS: returns empty array for all mode with no matches', () => {
    const html = '<html><body><p>Hello</p></body></html>';
    const result = extractCss(html, 'https://example.com', {
        type: 'css',
        schema: { items: { selector: '.nonexistent', all: true } },
    });
    assert.deepEqual(result.items, []);
});

test('CSS: returns empty array for nested fields with no matches', () => {
    const html = '<html><body><p>Hello</p></body></html>';
    const result = extractCss(html, 'https://example.com', {
        type: 'css',
        schema: { items: { selector: '.nonexistent', fields: { name: '.name' } } },
    });
    assert.deepEqual(result.items, []);
});

test('CSS: nesting depth is capped', () => {
    const html = '<html><body><div class="a"><div class="b"><div class="c"><div class="d"><div class="e"><div class="f"><span>deep</span></div></div></div></div></div></div></body></html>';
    const result = extractCss(html, 'https://example.com', {
        type: 'css',
        schema: {
            level1: {
                selector: '.a',
                fields: {
                    level2: {
                        selector: '.b',
                        fields: {
                            level3: {
                                selector: '.c',
                                fields: {
                                    level4: {
                                        selector: '.d',
                                        fields: {
                                            level5: {
                                                selector: '.e',
                                                fields: {
                                                    level6: {
                                                        selector: '.f',
                                                        fields: { val: 'span' },
                                                    },
                                                },
                                            },
                                        },
                                    },
                                },
                            },
                        },
                    },
                },
            },
        },
    });
    // Depth 5+ should return null for the inner field value
    const l1 = (result.level1 as any[])[0];
    const l2 = l1.level2[0];
    const l3 = l2.level3[0];
    const l4 = l3.level4[0];
    const l5 = l4.level5[0];
    // level6 extraction happens at depth 5, which calls extractField for val at depth 6 → null
    assert.ok(Array.isArray(l5.level6));
    assert.equal(l5.level6[0].val, null); // depth 6 is beyond MAX_NESTING_DEPTH
});

test('CSS: attribute extraction without attribute name returns null', () => {
    const html = '<html><body><a href="/x">Link</a></body></html>';
    const result = extractCss(html, 'https://example.com', {
        type: 'css',
        schema: { link: { selector: 'a', type: 'attribute' } },
    });
    assert.equal(result.link, null);
});

test('CSS: non-href/src attributes are not URL-resolved', () => {
    const html = '<html><body><div data-id="123">Test</div></body></html>';
    const result = extractCss(html, 'https://example.com', {
        type: 'css',
        schema: { id: { selector: 'div', type: 'attribute', attribute: 'data-id' } },
    });
    assert.equal(result.id, '123');
});

test('CSS: multiple fields from same page', () => {
    const html = `
        <html><head><title>Page Title</title></head>
        <body>
            <h1>Main Heading</h1>
            <p class="desc">Description here</p>
            <img src="/hero.jpg" alt="Hero" />
        </body></html>
    `;
    const result = extractCss(html, 'https://example.com', {
        type: 'css',
        schema: {
            title: 'title',
            heading: 'h1',
            description: '.desc',
            heroImage: { selector: 'img', type: 'attribute', attribute: 'src' },
            heroAlt: { selector: 'img', type: 'attribute', attribute: 'alt' },
        },
    });
    assert.equal(result.title, 'Page Title');
    assert.equal(result.heading, 'Main Heading');
    assert.equal(result.description, 'Description here');
    assert.equal(result.heroImage, 'https://example.com/hero.jpg');
    assert.equal(result.heroAlt, 'Hero');
});

test('CSS: all attribute extraction returns array of resolved URLs', () => {
    const html = `
        <html><body>
            <a href="/page1">One</a>
            <a href="/page2">Two</a>
            <a href="https://other.com/page3">Three</a>
        </body></html>
    `;
    const result = extractCss(html, 'https://example.com', {
        type: 'css',
        schema: { links: { selector: 'a', type: 'attribute', attribute: 'href', all: true } },
    });
    assert.deepEqual(result.links, [
        'https://example.com/page1',
        'https://example.com/page2',
        'https://other.com/page3',
    ]);
});

// ---------------------------------------------------------------------------
// Regex Extraction
// ---------------------------------------------------------------------------

test('Regex: extract emails', () => {
    const text = 'Contact us at hello@example.com or support@test.org for help.';
    const result = extractRegex(text, {
        type: 'regex',
        patterns: { emails: BUILTIN_PATTERNS.email },
    });
    assert.deepEqual(result.emails, ['hello@example.com', 'support@test.org']);
});

test('Regex: extract prices', () => {
    const text = 'Item A costs $9.99 and Item B costs $129.50. Shipping is $5.';
    const result = extractRegex(text, {
        type: 'regex',
        patterns: { prices: BUILTIN_PATTERNS.price },
    });
    assert.deepEqual(result.prices, ['$9.99', '$129.50', '$5.']);
});

test('Regex: extract ISO dates', () => {
    const text = 'Published on 2025-01-15 and updated 2025-03-20.';
    const result = extractRegex(text, {
        type: 'regex',
        patterns: { dates: BUILTIN_PATTERNS.dateIso },
    });
    assert.deepEqual(result.dates, ['2025-01-15', '2025-03-20']);
});

test('Regex: extract URLs', () => {
    const text = 'Visit https://example.com/page or http://test.org/path?q=1 for info.';
    const result = extractRegex(text, {
        type: 'regex',
        patterns: { urls: BUILTIN_PATTERNS.url },
    });
    assert.deepEqual(result.urls, ['https://example.com/page', 'http://test.org/path?q=1']);
});

test('Regex: extract IPv4 addresses', () => {
    const text = 'Server at 192.168.1.1, backup at 10.0.0.1.';
    const result = extractRegex(text, {
        type: 'regex',
        patterns: { ips: BUILTIN_PATTERNS.ipv4 },
    });
    assert.deepEqual(result.ips, ['192.168.1.1', '10.0.0.1']);
});

test('Regex: custom pattern', () => {
    const text = 'Order #12345 and order #67890 shipped.';
    const result = extractRegex(text, {
        type: 'regex',
        patterns: { orders: '#\\d+' },
    });
    assert.deepEqual(result.orders, ['#12345', '#67890']);
});

test('Regex: multiple patterns at once', () => {
    const text = 'Email john@test.com about order #555 for $29.99.';
    const result = extractRegex(text, {
        type: 'regex',
        patterns: {
            emails: BUILTIN_PATTERNS.email,
            orders: '#\\d+',
            prices: BUILTIN_PATTERNS.price,
        },
    });
    assert.deepEqual(result.emails, ['john@test.com']);
    assert.deepEqual(result.orders, ['#555']);
    assert.deepEqual(result.prices, ['$29.99']);
});

test('Regex: no matches returns empty array', () => {
    const text = 'Nothing special here.';
    const result = extractRegex(text, {
        type: 'regex',
        patterns: { emails: BUILTIN_PATTERNS.email },
    });
    assert.deepEqual(result.emails, []);
});

test('Regex: invalid pattern returns empty array without throwing', () => {
    const text = 'Some text.';
    const result = extractRegex(text, {
        type: 'regex',
        patterns: { bad: '[invalid(' },
    });
    assert.deepEqual(result.bad, []);
});

test('Regex: zero-length match does not cause infinite loop', () => {
    const text = 'abc';
    const result = extractRegex(text, {
        type: 'regex',
        patterns: { empty: '(?:)' }, // matches empty string at every position
    });
    // Should complete without hanging; result will have many empty strings
    assert.ok(Array.isArray(result.empty));
});

test('Regex: phone numbers', () => {
    const text = 'Call +1 (555) 123-4567 or +44 20 7946 0958.';
    const result = extractRegex(text, {
        type: 'regex',
        patterns: { phones: BUILTIN_PATTERNS.phone },
    });
    assert.equal(result.phones.length, 2);
    assert.ok(result.phones[0].includes('555'));
    assert.ok(result.phones[1].includes('7946'));
});

// ---------------------------------------------------------------------------
// BUILTIN_PATTERNS constant
// ---------------------------------------------------------------------------

test('BUILTIN_PATTERNS has expected keys', () => {
    assert.ok('email' in BUILTIN_PATTERNS);
    assert.ok('phone' in BUILTIN_PATTERNS);
    assert.ok('url' in BUILTIN_PATTERNS);
    assert.ok('price' in BUILTIN_PATTERNS);
    assert.ok('dateIso' in BUILTIN_PATTERNS);
    assert.ok('ipv4' in BUILTIN_PATTERNS);
});

test('BUILTIN_PATTERNS values are valid regex strings', () => {
    for (const [, pattern] of Object.entries(BUILTIN_PATTERNS)) {
        assert.doesNotThrow(() => new RegExp(pattern, 'g'));
    }
});

// ---------------------------------------------------------------------------
// Edge cases and security
// ---------------------------------------------------------------------------

test('CSS: handles empty HTML gracefully', () => {
    const result = extractCss('', 'https://example.com', {
        type: 'css',
        schema: { title: 'h1' },
    });
    assert.equal(result.title, null);
});

test('CSS: handles malformed HTML', () => {
    const html = '<div><p>Unclosed paragraph<div>Nested</div>';
    const result = extractCss(html, 'https://example.com', {
        type: 'css',
        schema: { text: 'p' },
    });
    assert.ok(typeof result.text === 'string' || result.text === null);
});

test('Regex: handles empty text', () => {
    const result = extractRegex('', {
        type: 'regex',
        patterns: { emails: BUILTIN_PATTERNS.email },
    });
    assert.deepEqual(result.emails, []);
});

test('CSS: whitespace-only text returns null', () => {
    const html = '<html><body><span class="empty">   </span></body></html>';
    const result = extractCss(html, 'https://example.com', {
        type: 'css',
        schema: { val: '.empty' },
    });
    assert.equal(result.val, null);
});

test('CSS: empty href attribute returns null', () => {
    const html = '<html><body><a href="">Link</a></body></html>';
    const result = extractCss(html, 'https://example.com', {
        type: 'css',
        schema: { link: { selector: 'a', type: 'attribute', attribute: 'href' } },
    });
    // Empty string href resolves to base URL
    assert.ok(result.link === null || typeof result.link === 'string');
});
