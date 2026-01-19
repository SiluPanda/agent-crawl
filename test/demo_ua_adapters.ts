import { AgentCrawl } from '../src/index.js';

async function main() {
    const url = 'https://www.underarmour.com/en-us/p/running/ua_sonic_7_womens_running_shoes/3028003.html?dwvar_3028003_color=001';

    console.log('--- Simulating Vercel AI SDK Tool Call ---');

    // 1. Instantiate the tool
    const scrapingTool = AgentCrawl.asVercelTool();

    console.log('Tool Description:', scrapingTool.description);

    // 2. Mock what the LLM would generate as arguments
    const toolArgs = {
        url: url,
        mode: 'hybrid' as const, // LLM chose hybrid
        // waitFor property removed to avoid timeout on guessed selector
    };

    console.log('LLM Arguments:', toolArgs);
    console.log('Executing tool...');

    // 3. Execute the tool
    try {
        const result = await scrapingTool.execute(toolArgs);

        console.log('\n--- Tool Output ---');
        console.log('URL:', result.url);
        console.log('Content Length:', result.content.length);
        console.log('Metadata:', result.metadata?.status);

        console.log('\n--- Content Snippet ---');
        console.log(result.content.slice(0, 300));

        if (result.content.toLowerCase().includes('sonic') || result.content.toLowerCase().includes('running')) {
            console.log('\n✅ Success: Adapter successfully scraped product data.');
        } else {
            console.log('\n❌ Warning: Product data might be missing.');
        }

    } catch (error) {
        console.error('Tool execution failed:', error);
    }
}

main().catch(console.error);
