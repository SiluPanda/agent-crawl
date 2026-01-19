/**
 * Quick test for browser timeout fix
 */
import { AgentCrawl } from '../src/index.js';

async function test() {
    console.log('Testing single page scrape with browser fallback...');
    const start = Date.now();
    try {
        const page = await AgentCrawl.scrape('https://www.underarmour.com/en-us/p/running/ua_sonic_7_womens_running_shoes/3028003.html', { mode: 'browser' });
        console.log('SUCCESS in', Date.now() - start, 'ms');
        console.log('Title:', page.title);
        console.log('Content length:', page.content.length);
    } catch (e: any) {
        console.log('FAILED in', Date.now() - start, 'ms');
        console.log('Error:', e.message);
    }
}

test();
