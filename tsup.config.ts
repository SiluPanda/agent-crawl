import { defineConfig } from 'tsup';

export default defineConfig({
    entry: ['src/index.ts'],
    format: ['cjs', 'esm'],
    dts: true,
    clean: true,
    sourcemap: true,
    minify: false,
    platform: 'node',
    // Don't bundle dependencies - let consumers install them
    // This avoids ESM/CJS interop issues with packages that use dynamic require
    external: [
        'turndown',
        'turndown-plugin-gfm',
        'cheerio',
        'playwright-core',
        'zod',
        'zod-to-json-schema'
    ],
});

