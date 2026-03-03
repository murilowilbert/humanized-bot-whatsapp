const xlsx = require('xlsx');
const path = require('path');
const fs = require('fs');
const https = require('https');
const googleSheetsService = require('./googleSheetsService');

const FILE_PATH = path.join(__dirname, '../../data/estoque.xlsx');
const SHEET_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vQrx6iAXiTOnLcp8kpL66zY0PGycvbZbai3qiNP8wqGLHMGhG3w4gMeRHXu8V4fsQ/pub?output=csv';

let cachedStock = null;
let lastFetch = 0;
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

async function loadStock() {
    const now = Date.now();
    if (cachedStock && (now - lastFetch < CACHE_DURATION)) {
        return cachedStock;
    }

    try {
        const csvData = await fetchCSV(SHEET_URL);
        const workbook = xlsx.read(csvData, { type: 'string' });
        const sheetName = workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];

        // The provided CSV starts with a title line "Posição de Estoque 02-2026", we need to skip it or handle headers carefully.
        // xlsx.utils.sheet_to_json with range: 1 will skip the first row.
        const rawData = xlsx.utils.sheet_to_json(sheet, { range: 1 });

        // Normalize data to match bot expectations
        cachedStock = rawData
            .filter(p => p['Código'] && p['Produto'])
            .map(p => {
                const qtyStr = p['Quantidade'] ? p['Quantidade'].toString().replace(',', '.') : '0';
                const priceStr = p['Preço de Venda'] ? p['Preço de Venda'].toString().replace(/[^\d,.-]/g, '').replace(',', '.') : '0';

                return {
                    Codigo: p['Código'].toString(),
                    Produto: p['Produto'],
                    Descricao: p['Produto'],
                    Estoque: parseFloat(qtyStr) || 0,
                    Preco: parseFloat(priceStr) || 0,
                    Categoria: p['Local'] || 'Geral'
                };
            });

        lastFetch = now;
        console.log(`Estoque sincronizado. ${cachedStock.length} itens carregados.`);
        return cachedStock;
    } catch (e) {
        console.error("Erro ao sincronizar estoque:", e);
        // Fallback to local file if fetch fails
        if (fs.existsSync(FILE_PATH)) {
            const workbook = xlsx.readFile(FILE_PATH);
            const sheet = workbook.Sheets[workbook.SheetNames[0]];
            return xlsx.utils.sheet_to_json(sheet);
        }
        return cachedStock || [];
    }
}

async function fetchCSV(url) {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`HTTP error fetching inventory! status: ${response.status}`);
    }
    return await response.text();
}

/**
 * Searches for a product by name or code.
 * Very simple fuzzy search (includes check).
 * @param {string} query Search term
 * @returns {Array} List of matching products
 */
async function searchProduct(query) {
    // 1. Busca rápida na Planilha Dinâmica do Google (Prioridade)
    const dynamicResults = await googleSheetsService.searchProductInSheet(query);
    if (dynamicResults && dynamicResults.length > 0) {
        console.log(`[Google Sheets API] Encontrados ${dynamicResults.length} itens dinâmicos para "${query}"`);
        return dynamicResults;
    }

    const server = require('../server/app');
    if (!server.isFullStockEnabled()) {
        console.log(`[Busca Restrita] Estoque Completo desativado. Nenhum item encontrado na planilha para "${query}". Bypassing fallback.`);
        return [];
    }

    // 2. Fallback: Busca no arquivo de banco de dados offline/estático
    const products = await loadStock();

    // Ensure query is a string for the offline fallback methods
    const queryString = Array.isArray(query) ? query.join(' ') : query;

    // Clean punctuation and remove conversational filler words
    const cleanQuery = queryString.toLowerCase().replace(/[?,.!\n]/g, ' ');
    // REMOVIDO: 'chuveiro', 'torneira', pois são categorias chave que precisam ser pesquisadas se o cliente não citar a marca.
    const stopWords = ['voces', 'tem', 'algum', 'de', 'da', 'do', 'um', 'uma', 'quais', 'qual', 'o', 'a', 'quero', 'gostaria', 'saber', 'se', 'por', 'favor', 'como', 'funciona', 'para', 'que', 'serve', 'marca', 'marcas', 'vocês', 'você', 'voce', 'temos', 'modelo', 'modelos', 'ola', 'bom', 'dia', 'tarde', 'noite', 'tudo', 'bem', 'certo', 'preciso'];

    const words = cleanQuery.split(/\s+/).filter(w => w.length > 2 && !stopWords.includes(w));

    if (words.length === 0) return []; // Retorna vazio se a query só tinha stop words

    // Score products based on keyword matches
    const scoredProducts = products.map(p => {
        const name = p.Produto ? p.Produto.toString().toLowerCase() : "";
        const cat = p.Categoria ? p.Categoria.toString().toLowerCase() : "";
        let score = 0;

        for (const w of words) {
            if (name.includes(w)) score += 2; // Stronger match on name
            else if (cat.includes(w)) score += 1;
        }
        return { product: p, score };
    }).filter(p => p.score > 0);

    // Sort by descending score
    scoredProducts.sort((a, b) => b.score - a.score);

    // Return top 25 context items
    return scoredProducts.slice(0, 25).map(sp => sp.product);
}

/**
 * Gets a product by exact code.
 * @param {string} code 
 */
async function getProductByCode(code) {
    const products = await loadStock();
    return products.find(p => p.Codigo && p.Codigo.toString() === code.toString());
}

/**
 * Gets similar products (simple heuristic: same category)
 * @param {Object} product reference product
 */
async function getSimilarProducts(product) {
    if (!product || !product.Categoria) return [];

    const products = await loadStock();
    return products.filter(p =>
        p.Categoria === product.Categoria &&
        p.Codigo !== product.Codigo &&
        p.Estoque > 0 // Only suggest items in stock
    ).slice(0, 3); // Return top 3
}

/**
 * Searches for a broad category fallback to triage before human handoff.
 */
async function searchCategory(query) {
    const categoryResult = await googleSheetsService.searchCategoryInSheet(query);
    if (categoryResult && categoryResult.length > 0) {
        console.log(`[Busca Categoria] Match encontrado para "${query}": ${categoryResult[0].categoria_geral} (Total: ${categoryResult.length})`);
    }
    return categoryResult || [];
}
module.exports = {
    loadStock,
    searchProduct,
    searchCategory,
    getProductByCode,
    getSimilarProducts
};
