import test from 'node:test';
import assert from 'node:assert/strict';
import { Markdownifier } from '../src/cleaners/Markdownifier.js';

test('extractAll captures JSON-LD, OpenGraph, Twitter, and canonical', () => {
    const md = new Markdownifier();
    const html = `
      <html>
        <head>
          <title>Title</title>
          <link rel="canonical" href="https://example.com/canon" />
          <meta property="og:title" content="OG Title" />
          <meta name="twitter:card" content="summary" />
          <script type="application/ld+json">{"@type":"Article","headline":"Hello"}</script>
        </head>
        <body><h1>H</h1><p>Body</p></body>
      </html>
    `;

    const out = md.extractAll(html, 'https://example.com/', { optimizeTokens: false });
    assert.equal(out.structured?.canonicalUrl, 'https://example.com/canon');
    assert.equal(out.structured?.openGraph?.['og:title'], 'OG Title');
    assert.equal(out.structured?.twitter?.['twitter:card'], 'summary');
    assert.equal(Array.isArray(out.structured?.jsonLd), true);
    assert.equal((out.structured?.jsonLd as any[])[0]?.headline, 'Hello');
});

