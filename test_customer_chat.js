require('dotenv').config();
const { getCachedSheetData } = require('./src/services/googleSheetsService');
const stockService = require('./src/services/stockService');
const aiService = require('./src/services/aiService');
const path = require('path');
const fs = require('fs');

const testScenarios = [
    {
        name: "Test 1: Specific product request (Ducha ND)",
        query: "tem o ducha ND?"
    },
    {
        name: "Test 2: Broad product request to test 4-6 options and narrowing prompt",
        query: "Quais opções de ducha vocês têm?"
    },
    {
        name: "Test 3: Short token search (pá)",
        query: "Vocês têm alguma pá?"
    },
    {
        name: "Test 4: Schedule / opening hours query",
        query: "Vocês abrem no domingo?"
    },
    {
        name: "Test 5: Price confusion check (cano 150mm)",
        query: "Cano 150mm"
    }
];

async function runScenario(scenario) {
    console.log(`\n======================================================`);
    console.log(`🎬 ${scenario.name}`);
    console.log(`👤 Cliente: "${scenario.query}"`);
    console.log(`======================================================`);

    const userText = scenario.query;
    // Simulate current user message being part of the conversation history
    const recentHistory = [
        { role: 'user', content: userText }
    ];

    // 1. Expand query terms using AI
    console.log("🤖 IA expandindo termos...");
    const expandedQueryArray = await aiService.expandSearchQuery(userText, recentHistory);
    console.log(`🔍 Termos expandidos: [${expandedQueryArray.join(', ')}]`);

    let cleanSearchTermsArray = expandedQueryArray.length > 0 ? expandedQueryArray : [];
    cleanSearchTermsArray = cleanSearchTermsArray.map(t => t.replace(/\n/g, ' ').trim()).filter(t => t.length > 0);

    // 2. Query product and category tables
    console.log("📂 Buscando no estoque...");
    let principalMatches = [];
    let geralMatches = [];
    if (cleanSearchTermsArray.length > 0) {
        principalMatches = await stockService.searchProduct(cleanSearchTermsArray);
        geralMatches = await stockService.searchCategory(cleanSearchTermsArray);
    }

    let combinedContext = [];
    if (principalMatches && principalMatches.length > 0) combinedContext.push(...principalMatches);
    if (geralMatches && geralMatches.length > 0) combinedContext.push(...geralMatches);

    const seenMap = new Set();
    const stockContext = [];
    for (let item of combinedContext) {
        const realItem = item.item || item;
        if (item.matchCount !== undefined) {
            realItem._relevancia = item.matchCount;
        }
        const uniqueKey = realItem['código'] || realItem['codigo'] || realItem['ean'] || realItem['modelo/produto'] || realItem['categoria_geral'];

        if (uniqueKey && !seenMap.has(uniqueKey)) {
            seenMap.add(uniqueKey);
            stockContext.push(realItem);
        }
    }

    const slicedContext = stockContext.slice(0, 15);

    // Check for photo metadata
    for (const item of slicedContext) {
        const code = item['código'] || item['codigo'];
        if (code) {
            const photoExists = [
                path.join(__dirname, `../data/fotos/${code}.jpg`),
                path.join(__dirname, `../data/fotos/${code}.png`),
                path.join(__dirname, `../data/fotos_sheets/${code}.jpg`),
                path.join(__dirname, `../data/fotos_sheets/${code}.png`),
            ].some(p => fs.existsSync(p));
            if (photoExists) item._temFoto = true;
        }
    }

    console.log(`📦 Encontrados ${slicedContext.length} itens para enviar à IA.`);
    if (slicedContext.length > 0) {
        console.log("Itens enviados:", slicedContext.map(i => i['modelo/produto'] || i['categoria_geral']));
    }

    // 3. Generate response
    console.log("🤖 IA gerando resposta...");
    const response = await aiService.generateResponse(userText, [], [], recentHistory, slicedContext);
    
    console.log(`\n💬 Resposta do Bot:`);
    console.log(`------------------------------------------------------`);
    console.log(response.text);
    console.log(`------------------------------------------------------`);
    if (response.needsHandoff) {
        console.log(`🚨 [HANDOFF ACIONADO]`);
    }
}

async function start() {
    // Warm up Google Sheets cache first
    console.log("📥 Carregando cache de planilhas...");
    await getCachedSheetData();
    
    for (const scenario of testScenarios) {
        await runScenario(scenario);
    }
    
    console.log(`\n======================================================`);
    console.log("✅ Todos os cenários simulados com sucesso!");
    console.log(`======================================================`);
}

start().catch(console.error);
