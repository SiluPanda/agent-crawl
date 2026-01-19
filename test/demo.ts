import { AgentCrawl } from '../src/index.js';

async function main() {
    console.log('Testing AgentCrawl (Single Page Scrape)...\n');

    const page = await AgentCrawl.scrape('https://ninjatables.com/examples-of-data-table-design-on-website/?srsltid=AfmBOortZBzoRll2jimMlAjQpSqMaqdQzVgvHiyV9-mW2Ur8oOueV6PK');

    console.log('✅ Success!');
    console.log(page.content);

    // Clean exit
    process.exit(0);
}

main().catch(err => {
    console.error('❌ Error:', err.message);
    process.exit(1);
});

