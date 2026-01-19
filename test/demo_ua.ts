import { AgentCrawl } from '../src/index.js';

async function main() {
    const url = 'https://www.underarmour.com/en-us/p/running/ua_sonic_7_womens_running_shoes/3028003.html?dwvar_3028003_color=001';

    console.log(`Scraping URL: ${url}`);
    console.log('Mode: Hybrid (Default)');

    try {
        const page = await AgentCrawl.scrape(url, {
            mode: 'hybrid',
            // E-commerce sites often load product details dynamically, so we might want to wait for something specific if we know it.
            // But for a general "hybrid" test, let's see if the default logic (static -> browser fallback) works.
            // We can hint it to wait for a price element if we wanted, e.g. waitFor: '.price' or similar, but let's try generic first.
        });

        console.log('\n--- Metadata ---');
        console.log('Status:', page.metadata?.status);

        console.log('\n--- Content Preview (First 500 chars) ---');
        console.log(page.content.slice(0, 500));

        console.log('\n--- Content Stats ---');
        console.log(`Length: ${page.content.length} characters`);

        // Check for some expected keywords to verify data extraction
        if (page.content.toLowerCase().includes('sonic') || page.content.toLowerCase().includes('running')) {
            console.log('\n✅ Success: Found product keywords.');
        }

    } catch (error) {
        console.error('Scraping failed:', error);
    }
}

main().catch(console.error);
