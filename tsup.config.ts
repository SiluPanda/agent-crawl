import { defineConfig } from 'tsup';

export default defineConfig([
    {
        entry: ['src/index.ts'],
        format: ['cjs', 'esm'],
        dts: true,
        clean: true,
        sourcemap: true,
        minify: false,
        platform: 'node',
        external: ['cheerio', 'playwright-core', 'zod', 'undici'],
    },
    {
        entry: ['src/cli.ts'],
        format: ['esm'],
        dts: false,
        clean: false,
        sourcemap: false,
        minify: false,
        platform: 'node',
        banner: { js: '#!/usr/bin/env node' },
        external: ['cheerio', 'playwright-core', 'zod', 'undici'],
    },
]);
