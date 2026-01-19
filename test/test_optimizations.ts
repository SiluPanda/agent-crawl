import { AgentCrawl } from '../src/index.js';

async function main() {
    const url = 'https://www.underarmour.com/en-us/p/running/ua_sonic_7_womens_running_shoes/3028003.html?dwvar_3028003_color=001';

    console.log('=== Testing Cassini Optimizations ===\n');

    // Test 1: Default (Hybrid mode with token optimization)
    console.log('1. Default Scrape (Hybrid + Token Optimization)');
    const result1 = await AgentCrawl.scrape(url);
    console.log(`   Title: "${result1.title}"`);
    console.log(`   Mode: ${result1.metadata?.status ? 'Success' : 'Failed'}`);
    console.log(`   Content Length: ${result1.content.length} chars`);
    console.log(`   First 200 chars: ${result1.content.slice(0, 200)}...\n`);

    // Test 2: With Main Content Extraction
    console.log('2. With Main Content Extraction');
    const result2 = await AgentCrawl.scrape(url, {
        extractMainContent: true,
        optimizeTokens: true,
    });
    console.log(`   Content Length: ${result2.content.length} chars`);
    console.log(`   Reduction: ${((1 - result2.content.length / result1.content.length) * 100).toFixed(1)}%\n`);

    // Test 3: Verify Cache
    console.log('3. Cache Test');
    const start = Date.now();
    const result3 = await AgentCrawl.scrape(url);
    const duration = Date.now() - start;
    console.log(`   Duration: ${duration}ms ${duration < 10 ? '✅ Cached!' : '❌ Not cached'}\n`);

    // Test 4: Test with different config (should not hit cache)
    console.log('4. Different Config (No Cache Hit)');
    const start2 = Date.now();
    const result4 = await AgentCrawl.scrape(url, { extractMainContent: true });
    const duration2 = Date.now() - start2;
    console.log(`   Duration: ${duration2}ms ${duration2 > 100 ? '✅ Fresh fetch' : '⚠️  Might be cached'}\n`);

    // Test 5: Static site (should use fast path)
    console.log('5. Static Site Test');
    const start3 = Date.now();
    const result5 = await AgentCrawl.scrape('https://example.com');
    const duration3 = Date.now() - start3;
    console.log(`   Title: "${result5.title}"`);
    console.log(`   Duration: ${duration3}ms`);
    console.log(`   Content includes "Example Domain": ${result5.content.includes('Example Domain') ? '✅' : '❌'}\n`);

    console.log('=== All Tests Complete ===');
    process.exit(0);
}

main().catch(console.error);
