import { AgentCrawl } from '../src/index.js';

async function main() {
    console.log('Testing AgentCrawl Hybrid Mode...');

    // 1. Test Static Success (Hybrid Mode)
    console.log('\n1. Testing Static Success (Hybrid Mode)...');
    const page1 = await AgentCrawl.scrape('https://example.com', { mode: 'hybrid' });
    if (page1.content.includes('Example Domain')) {
        console.log('✅ Success: Static content fetched in hybrid mode.');
    } else {
        console.log('❌ Failure: Static content not fetched.');
    }

    // 2. Test Browser Fallback (Force Browser Mode or simulate fallback)
    console.log('\n2. Testing Browser Mode (e.g. Google)...');
    try {
        // Google often requires JS or returns complex DOM. 
        // We force browser mode to be sure.
        const page2 = await AgentCrawl.scrape('https://www.google.com', { mode: 'browser' });
        if (page2.content.length > 0) {
            console.log('✅ Success: Browser content fetched.');
            // console.log('Preview:', page2.content.slice(0, 200));
        } else {
            console.log('❌ Failure: Browser content empty.');
        }
    } catch (e) {
        console.log('❌ Failure: Browser Error', e);
    }

    // 3. Test waitFor (if possible, with a public site)
    console.log('\n3. Testing waitFor selector...');
    // We can use example.com and wait for h1, simple test
    const page3 = await AgentCrawl.scrape('https://example.com', {
        mode: 'browser',
        waitFor: 'h1'
    });
    if (page3.content.includes('Example Domain')) {
        console.log('✅ Success: waited for selector.');
    } else {
        console.log('❌ Failure: waitFor test failed.');
    }

    process.exit(0);
}

main().catch(console.error);
