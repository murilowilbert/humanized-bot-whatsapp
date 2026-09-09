require('dotenv').config();
const { getCachedSheetData } = require('./src/services/googleSheetsService');
const stockService = require('./src/services/stockService');
const aiService = require('./src/services/aiService');
const path = require('path');
const fs = require('fs');

// Helper para carregar imagem de teste em base64 se existir
function loadTestImage(filename) {
    const fullPath = path.join(__dirname, 'data/fotos_sheets', filename);
    if (fs.existsSync(fullPath)) {
        const ext = path.extname(filename).toLowerCase().replace('.', '');
        const mimeType = ext === 'png' ? 'image/png' : (ext === 'webp' ? 'image/webp' : 'image/jpeg');
        const buffer = fs.readFileSync(fullPath);
        return [{
            inlineData: {
                data: buffer.toString('base64'),
                mimeType: mimeType
            }
        }];
    }
    return [];
}

// Cria um buffer simples de teste para simular foto ambígua/genérica
function createSampleGenericImage() {
    // 1x1 pixel PNG transparente como fallback seguro
    const base64Png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    return [{
        inlineData: {
            data: base64Png,
            mimeType: "image/png"
        }
    }];
}

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
    },
    {
        name: "Test 6: Photo request with previous context (tem fotos?)",
        query: "tem fotos?",
        history: [
            { role: 'user', content: 'oq vcs tem chuveiro?' },
            { role: 'model', content: 'Temos a Ducha Maxiducha Lorenzetti por R$110,00 e a Ducha Loren Shower Lorenzetti por R$179,00.' }
        ]
    },
    {
        name: "Test 7: Foto com Legenda Genérica (Ambígua/Não Identificada) -> Pede detalhes cordialmente",
        query: "tem esse produto?",
        imageParts: createSampleGenericImage(),
        expectedBehavior: "IA deve acolher a foto e pedir detalhes (marca/medida/uso) SEM dizer 'Sim, qual produto seria?'"
    },
    {
        name: "Test 8: Foto com Legenda Genérica (Match de Catálogo) -> Identifica e oferece produto",
        query: "tem desse aqui?",
        imageParts: loadTestImage("7896451824806.png"), // Maxiducha Lorenzetti
        expectedBehavior: "IA deve identificar o produto da imagem, buscar no estoque e apresentar opções com {{COD}}"
    },
    {
        name: "Test 9: CASO REAL DA IMAGEM - Cliente diz 'Não' após bot avisar que balcão está verificando",
        query: "Não",
        history: [
            { role: 'user', content: 'E para um cercadinho para uma cachorrinha' },
            { role: 'model', content: 'Certo, entendi! Para um cercadinho para cachorrinha, vou pedir para o pessoal do balcão verificar se temos alguma opção que possa te atender.\n\nSobre as telas soldadas e a tela verde que você perguntou antes, o pessoal também já está verificando, tá bom?\n\nPrecisa de mais alguma coisa por enquanto?' }
        ],
        expectedBehavior: "IA deve confirmar espera do balcão, emitir [HANDOFF], NÃO inventar novas buscas e NÃO repetir perguntas."
    },
    {
        name: "Test 10: Silêncio Inteligente - Cliente manda 'OK' após confirmação de espera do balcão",
        query: "OK",
        history: [
            { role: 'user', content: 'Não' },
            { role: 'model', content: 'Perfeito! O pessoal do balcão já está verificando suas opções e logo te responde por aqui. Qualquer dúvida estamos à disposição!' }
        ],
        expectedBehavior: "IA deve retornar [NO_RESPONSE], mantendo silêncio e sem disparar mensagens desnecessárias."
    },
    {
        name: "Test 11: Negação que introduz Novo Produto ('Não, mas queria ver se tem fita veda rosca')",
        query: "Não, mas queria ver se tem fita veda rosca",
        history: [
            { role: 'user', content: 'tem chuveiro?' },
            { role: 'model', content: 'Temos a Ducha Maxiducha Lorenzetti por R$110,00. Precisa de mais alguma coisa por enquanto?' }
        ],
        expectedBehavior: "IA deve identificar 'fita veda rosca', buscar no estoque e apresentar preços normalmente."
    },
    {
        name: "Test 12: Pedido Explícito de Atendente Humano",
        query: "Tem alguém aí no balcão pra me atender?",
        expectedBehavior: "IA deve responder cordialmente que está transferindo e emitir a tag [HANDOFF]."
    },
    {
        name: "Test 13: Pergunta de Desconto à Vista",
        query: "Tem desconto à vista no PIX?",
        history: [
            { role: 'user', content: 'quanto custa o chuveiro maxiducha?' },
            { role: 'model', content: 'A Ducha Maxiducha Lorenzetti sai por R$110,00.' }
        ],
        expectedBehavior: "IA NÃO deve dizer que não tem desconto. Deve avisar que vai pedir pro atendente verificar as opções de desconto e emitir [HANDOFF]."
    }
];

async function runScenario(scenario) {
    console.log(`\n======================================================`);
    console.log(`🎬 ${scenario.name}`);
    console.log(`👤 Cliente: "${scenario.query}"`);
    if (scenario.imageParts && scenario.imageParts.length > 0) {
        console.log(`📷 [Foto Anexada: ${scenario.imageParts.length} imagem(ns)]`);
    }
    if (scenario.expectedBehavior) {
        console.log(`🎯 Esperado: ${scenario.expectedBehavior}`);
    }
    console.log(`======================================================`);

    const userText = scenario.query;
    const imageParts = scenario.imageParts || [];
    
    // Simulate current user message being part of the conversation history
    const recentHistory = scenario.history ? [...scenario.history, { role: 'user', content: userText }] : [
        { role: 'user', content: userText }
    ];

    // 1. Expand query terms using AI
    console.log("🤖 IA expandindo termos...");
    let searchKeywords = userText;
    if (imageParts.length > 0) {
        searchKeywords = await aiService.extractImageKeywords(imageParts, userText);
        console.log(`📷 Visão IA extraiu busca: "${searchKeywords}"`);
    }

    const expandedQueryArray = await aiService.expandSearchQuery(searchKeywords, scenario.history || []);
    console.log(`🔍 Termos expandidos: [${expandedQueryArray.join(', ')}]`);

    let cleanSearchTermsArray = expandedQueryArray.length > 0 ? expandedQueryArray : [];
    cleanSearchTermsArray = cleanSearchTermsArray.map(t => t.replace(/\n/g, ' ').trim()).filter(t => t.length > 0);

    // 2. Query product and category tables
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
                path.join(__dirname, `data/fotos/${code}.jpg`),
                path.join(__dirname, `data/fotos/${code}.png`),
                path.join(__dirname, `data/fotos_sheets/${code}.jpg`),
                path.join(__dirname, `data/fotos_sheets/${code}.png`),
            ].some(p => fs.existsSync(p));
            if (photoExists) item._temFoto = true;
        }
    }

    console.log(`📦 Encontrados ${slicedContext.length} itens para enviar à IA.`);

    // 3. Generate response
    console.log("🤖 IA gerando resposta...");
    const response = await aiService.generateResponse(userText, imageParts, [], recentHistory, slicedContext);
    
    console.log(`\n💬 Resposta do Bot:`);
    console.log(`------------------------------------------------------`);
    if (response.noResponse) {
        console.log(`🤫 [NO_RESPONSE]: O bot optou por SILÊNCIO INTELIGENTE (nenhuma mensagem enviada ao WhatsApp).`);
    } else {
        console.log(response.text);
    }
    console.log(`------------------------------------------------------`);
    if (response.needsHandoff) {
        console.log(`🚨 [HANDOFF ACIONADO]`);
    }

    // Validação de timer de inatividade simulada
    const isWaitingAttendant = response.needsHandoff || /balc[aã]o|balcao|atendente|verificar com|dar uma olhada na prateleira|nossa equipe|repassar/i.test(response.text || '');
    const isEnd = /^(n[aã]o|n[aã]o precisa|n[aã]o obrigado|s[oó] isso|nada mais|nada|tranquilo|ok|beleza|perfeito|valeu|obrigad[oa]|tchau|at[eé] mais)/i.test(userText.trim());
    
    if (isWaitingAttendant || isEnd || response.noResponse) {
        console.log(`⏱️ [Timer de Inatividade]: CANCELADO / DESATIVADO (Correto para este cenário).`);
    } else {
        console.log(`⏱️ [Timer de Inatividade]: AGENDADO para 10 min (Atendimento aberto / opções apresentadas).`);
    }

    return response;
}

async function start() {
    console.log("📥 Carregando cache de planilhas...");
    await getCachedSheetData();
    
    for (const scenario of testScenarios) {
        try {
            await runScenario(scenario);
            // Pequena pausa entre testes para respeitar rate limit da API
            await new Promise(resolve => setTimeout(resolve, 1500));
        } catch (err) {
            console.error(`❌ Erro no cenário "${scenario.name}":`, err);
        }
    }
    
    console.log(`\n======================================================`);
    console.log("✅ Bateria de testes concluída!");
    console.log(`======================================================`);
}

start().catch(console.error);
