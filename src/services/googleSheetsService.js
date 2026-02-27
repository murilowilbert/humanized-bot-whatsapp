// Google Sheets API Integration Service
// Usando 'fetch' nativo do Node 18+
const Fuse = require('fuse.js');

let sheetCache = null;
let lastCacheTime = 0;
let categoryCache = null;
let lastCategoryCacheTime = 0;
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes cache

// Função auxiliar para interpretar a linha do CSV com aspas
function parseCSVRow(str) {
    const arr = [];
    let quote = false;
    let col = "";

    for (let c of str) {
        if (c === '"' && quote === false) { quote = true; continue; }
        if (c === '"' && quote === true) { quote = false; continue; }
        if (c === ',' && quote === false) { arr.push(col.trim()); col = ""; continue; }
        col += c;
    }
    arr.push(col.trim());
    return arr;
}

/**
 * Puxa os dados atualizados do link CSV Público da Planilha do Google usando fetch.
 */
async function fetchGoogleSheetCSV(csvUrl) {
    if (!csvUrl) return null;

    try {
        const response = await fetch(csvUrl);
        if (!response.ok) {
            console.error(`Falha ao acessar a planilha CSV. Status: ${response.status}`);
            return null;
        }

        const text = await response.text();
        const lines = text.split('\n').map(l => l.trim()).filter(l => l !== '');

        if (lines.length === 0) return [];

        // Considera a primeira linha como cabeçalho
        const headers = parseCSVRow(lines[0]).map(h => h.toLowerCase().trim());

        const data = [];
        for (let i = 1; i < lines.length; i++) {
            const rowValues = parseCSVRow(lines[i]);
            const item = {};

            for (let j = 0; j < headers.length; j++) {
                const head = headers[j] || `coluna_${j}`;
                item[head] = rowValues[j] || "";
            }
            data.push(item);
        }

        return data;
    } catch (e) {
        console.error("Erro ao puxar dados da Planilha do Google:", e);
        return null; // Retorna null para sinalizar erro e cair no fallback
    }
}

async function getCachedSheetData() {
    const now = Date.now();
    if (sheetCache && (now - lastCacheTime) < CACHE_TTL_MS) {
        return sheetCache;
    }

    const csvUrl = process.env.GOOGLE_SHEETS_CSV_URL || process.env.GOOGLE_SHEET_CSV_URL;
    if (!csvUrl) {
        console.error("🚨 [ERRO CRÍTICO] Falha no Carregamento: Variável GOOGLE_SHEETS_CSV_URL não encontrada no .env ou Servidor. O Bot operará cego (0 itens)!");
        return null;
    }

    console.log("[Google Sheets] Baixando planilha e atualizando Cache em Memória...");
    const data = await fetchGoogleSheetCSV(csvUrl);
    if (data) {
        sheetCache = data;
        lastCacheTime = now;
        console.log(`[Google Sheets] ✅ Cache Atualizado com Sucesso: ${data.length} itens.`);
    } else {
        console.error("🚨 [ERRO CRÍTICO] A conexão com a URL do Google Sheets falhou ou o CSV retornou vazio!");
    }
    return sheetCache;
}

/**
 * Busca por palavras-chaves nos itens dinâmicos do Google Sheets
 * @param {Array<string>|string} keywordsArray Pode ser String crua ou Array expandido da IA
 */
async function searchProductInSheet(keywordsArray) {
    const data = await getCachedSheetData();
    if (!data || data.length === 0) return null;

    let searchTerms = Array.isArray(keywordsArray) ? keywordsArray : [keywordsArray];

    // Configuração do Fuse.js
    const options = {
        includeScore: true,
        threshold: 0.4, // Grau de Fuzzy (0.0 é exato, 1.0 acha qualquer coisa)
        ignoreLocation: true,
        keys: [
            { name: 'modelo/produto', weight: 0.6 },
            { name: 'tags para busca (sinônimos)', weight: 0.3 },
            { name: 'características principais', weight: 0.1 },
            { name: 'código', weight: 0.9 },
            { name: 'codigo', weight: 0.9 },
            { name: 'ean', weight: 0.9 }
        ]
    };

    const fuse = new Fuse(data, options);
    let allResults = [];
    const seenItems = new Set();

    for (const term of searchTerms) {
        const results = fuse.search(term);
        for (const res of results) {
            const itemId = res.item['código'] || res.item['codigo'] || res.item['modelo/produto'];
            if (!seenItems.has(itemId)) {
                seenItems.add(itemId);
                allResults.push({ item: res.item, score: res.score });
            }
        }
    }

    // Ordena pelo menor 'score' do Fuse.js (menor = melhor match)
    allResults.sort((a, b) => a.score - b.score);

    // Retorna no formato legado para compatibilidade: { item, matchCount }
    return allResults.slice(0, 15).map(r => ({
        item: r.item,
        matchCount: Math.round((1 - r.score) * 10) // Converte score invertido pra peso antigo
    }));
}

async function getCachedCategoryData() {
    const now = Date.now();
    if (categoryCache && (now - lastCategoryCacheTime) < CACHE_TTL_MS) {
        return categoryCache;
    }

    const csvUrl = process.env.GOOGLE_SHEETS_CATEGORIES_URL;
    if (!csvUrl) {
        console.warn("[Google Sheets] Variável GOOGLE_SHEETS_CATEGORIES_URL não definida. Tabela de Categorias ignorada.");
        return null; // Silent skip if not configured
    }

    console.log("[Google Sheets] Baixando planilha secundária de categorias...");
    const data = await fetchGoogleSheetCSV(csvUrl);
    if (data) {
        categoryCache = data;
        lastCategoryCacheTime = now;
        console.log(`[Google Sheets] ✅ Cache de Categorias Atualizado com Sucesso: ${data.length} categorias/triagens.`);
    }
    return categoryCache;
}

/**
 * Busca por palavras-chaves na segunda aba de Categorias Gerais para fallback process.
 */
async function searchCategoryInSheet(keywordsArray) {
    const data = await getCachedCategoryData();
    if (!data || data.length === 0) return null;

    let searchTerms = Array.isArray(keywordsArray) ? keywordsArray : [keywordsArray];

    const options = {
        includeScore: true,
        threshold: 0.3, // Threshold mais baixo (mais estrito)
        ignoreLocation: true,
        keys: [
            { name: 'categoria_geral', weight: 1.0 },
            { name: 'sinonimos', weight: 0.8 } // A planilha cliente pode ter uma coluna sinonimos
        ]
    };

    const fuse = new Fuse(data, options);

    // Busca e retorna o Top 1 mais assertivo
    for (const term of searchTerms) {
        const results = fuse.search(term);
        if (results && results.length > 0) {
            return results[0].item;
        }
    }

    return null;
}

module.exports = { fetchGoogleSheetCSV, searchProductInSheet, searchCategoryInSheet };
