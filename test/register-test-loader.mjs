import { register } from 'node:module';

register(new URL('./mock-turndown-plugin-loader.mjs', import.meta.url), import.meta.url);
