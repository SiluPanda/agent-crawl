import { AgentCrawl } from '../src/index.js';

async function main() {
    console.log('Testing AgentCrawl Optimization...');

    const url = 'https://example.com';

    // 1. First Request (Fresh)
    console.log('\n1. First Request (Fresh)...');
    const start1 = Date.now();
    await AgentCrawl.scrape(url, { mode: 'browser' }); // Force browser to test resource blocking logic implicitly (check logs/speed)
    const duration1 = Date.now() - start1;
    console.log(`Duration 1: ${duration1}ms`);

    // 2. Second Request (Cached)
    console.log('\n2. Second Request (Cached)...');
    const start2 = Date.now();
    await AgentCrawl.scrape(url, { mode: 'browser' });
    const duration2 = Date.now() - start2;
    console.log(`Duration 2: ${duration2}ms`);

    if (duration2 < 100) { // Should be instant if cached
        console.log('✅ Success: Cache hit (response time < 100ms).');
    } else {
        console.log('❌ Failure: Cache miss or slow.');
    }

    process.exit(0);
}

main().catch(console.error);
