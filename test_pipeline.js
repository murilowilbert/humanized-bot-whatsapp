require('dotenv').config();
const aiService = require('./src/services/aiService');
const stockService = require('./src/services/stockService');

async function testPipeline() {
    const userQuery = "tem algum modelo de ducha mais em conta?";
    const recentContext = "user: tem de metal? model: sim, temos a torneira lorenzetti de metal por R$105,00"; // Fake context

    console.log("1. User Query:", userQuery);

    const expanded = await aiService.expandSearchQuery(userQuery, recentContext);
    console.log("2. AI Expanded Array:", expanded);

    const stockResults = await stockService.searchProduct(expanded);
    // Print just titles and prices
    console.log("3. Fuse.js Top Matches:");
    stockResults.slice(0, 5).forEach(r => {
        console.log(` - ${r.item['modelo/produto'] || r.item['Produto']} | R$${r.item['preço (r$)'] || r.item['Preço']} | Score: ${r.matchCount}`);
    });
}

testPipeline();
