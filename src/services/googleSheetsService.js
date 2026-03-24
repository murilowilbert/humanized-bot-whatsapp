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

    let csvUrl = process.env.GOOGLE_SHEETS_URL_PRINCIPAL || process.env.GOOGLE_SHEETS_CSV_URL || process.env.GOOGLE_SHEET_CSV_URL;
    if (!csvUrl) {
        console.error("🚨 [ERRO CRÍTICO] Falha no Carregamento: Variável GOOGLE_SHEETS_URL_PRINCIPAL não encontrada no .env ou Servidor. O Bot operará cego (0 itens)!");
        return null;
    }

    // Garante que o usuário digitou o output=csv corretamente
    csvUrl = csvUrl.replace(/\/pubhtml\/?$/, '/pub?output=csv');

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
 * Força a atualização do Cache ignorando o TTL
 */
async function forceRefreshCache() {
    console.log("[Google Sheets] Comando manual recebido: Forçando recarregamento das planilhas...");
    lastCacheTime = 0;
    lastCategoryCacheTime = 0;
    const resPrincipal = await getCachedSheetData();
    const resCategoria = await getCachedCategoryData();
    return { principal: resPrincipal ? resPrincipal.length : 0, categoria: resCategoria ? resCategoria.length : 0 };
}

/**
 * Inicia o Auto-Refresh em Background. Deve ser invocado apenas uma vez.
 */
function startAutoRefresh(intervalMs = 45 * 60 * 1000) { // Default 45 mins
    console.log(`[Google Sheets] Auto-Refresh configurado para a cada ${intervalMs / 60000} minutos.`);
    setInterval(async () => {
        console.log(`[Google Sheets] 🔄 Auto-Refresh Acionado! Atualizando caches em background...`);
        lastCacheTime = 0;
        lastCategoryCacheTime = 0;
        await getCachedSheetData();
        await getCachedCategoryData();
    }, intervalMs);
}

/**
 * Busca por palavras-chaves nos itens dinâmicos do Google Sheets
 * @param {Array<string>|string} keywordsArray Pode ser String crua ou Array expandido da IA
 */
async function searchProductInSheet(keywordsArray) {
    const data = await getCachedSheetData();
    if (!data || data.length === 0) return null;

    let searchTerms = Array.isArray(keywordsArray) ? keywordsArray : [keywordsArray];

    // Interceptador de Busca Exata (Obrigatório para EAN / Fim da Alucinação)
    for (const term of searchTerms) {
        const strTerm = term.toString().trim();
        // Se a instrução do motor for EAN puro (8 a 14 dígitos)
        if (/^\d{8,14}$/.test(strTerm)) {
            const exato = data.find(i =>
                (i['código'] && i['código'].toString() === strTerm) ||
                (i['codigo'] && i['codigo'].toString() === strTerm) ||
                (i['ean'] && i['ean'].toString() === strTerm)
            );

            if (exato) {
                console.log(`[Google Sheets] 🎯 EAN Exato interceptado: ${strTerm}. Ignorando Fuse.js fuzzy logic.`);
                // Retorna estritamente 1 item para o LLM não confundir opções (Formato antigo legacy esperado pelo bot)
                return [{ item: exato, matchCount: 10 }];
            }
        }
    }

    const options = {
        includeScore: true,
        useExtendedSearch: true, // Habilitado para Token Search (AND Lógico)
        threshold: 0.2, // Configuração rigorosa para evitar falsos matches
        minMatchCharLength: 3, // Ignora matches em preposições (do, de, a)
        ignoreLocation: true,
        keys: [
            { name: 'modelo/produto', weight: 2.0 },
            { name: 'tags para busca (sinônimos)', weight: 1.5 },
            { name: 'categoria', weight: 1.5 },
            { name: 'atributos físicos', weight: 0.3 },
            { name: 'características principais', weight: 0.3 },
            { name: 'marca', weight: 1.5 },
            { name: 'preço (r$)', weight: 0.5 },
            { name: 'potência/voltagem', weight: 1.0 },
            { name: 'potencia/voltagem', weight: 1.0 },
            { name: 'código', weight: 2.0 },
            { name: 'codigo', weight: 2.0 },
            { name: 'ean', weight: 2.0 }
        ]
    };

    const fuse = new Fuse(data, options);
    let allResults = [];

    // Busca iterativa: em vez de strings gigantes que diluem score, buscamos termo a termo
    for (const term of searchTerms) {
        // Token Search (AND Lógico): Quebra a string por espaços para forçar match parcial em múltiplos tokens isolados ignorando a ordem
        const tokenizedTerm = term.trim().split(/\s+/).join(' ');

        const results = fuse.search(tokenizedTerm);
        allResults = allResults.concat(results);
    }

    // Desduplicação de resultados exata pedida
    const uniqueResults = Array.from(new Map(allResults.map(r => {
        const uniqueKey = r.item['ean'] || r.item['código'] || r.item['codigo'] || r.item['modelo/produto'];
        return [uniqueKey, r];
    })).values());

    // Ordenação e Boosting de Exact Match
    // Se a palavra procurada bater exatamente no início de um modelo/produto ou tag, aquele item sobe pro topo
    uniqueResults.sort((a, b) => {
        // Prioridade 1: Match numérico (EAN ou Código)
        const isA_CodeMatch = /^\d+$/.test(searchTerms[0]) && a.item['código'] && a.item['código'].toString().includes(searchTerms[0]);
        const isB_CodeMatch = /^\d+$/.test(searchTerms[0]) && b.item['código'] && b.item['código'].toString().includes(searchTerms[0]);
        if (isA_CodeMatch && !isB_CodeMatch) return -1;
        if (isB_CodeMatch && !isA_CodeMatch) return 1;

        // Prioridade 2: Match exato na palavra-chave primária
        const primaryTermStart = searchTerms[0] ? searchTerms[0].toLowerCase().split(' ')[0] : '';
        if (primaryTermStart.length > 2) {
            const aNameMatch = a.item['modelo/produto'] && a.item['modelo/produto'].toLowerCase().startsWith(primaryTermStart);
            const aTagMatch = a.item['tags para busca (sinônimos)'] && a.item['tags para busca (sinônimos)'].toLowerCase().includes(primaryTermStart);
            const isA_Boosted = aNameMatch || aTagMatch;

            const bNameMatch = b.item['modelo/produto'] && b.item['modelo/produto'].toLowerCase().startsWith(primaryTermStart);
            const bTagMatch = b.item['tags para busca (sinônimos)'] && b.item['tags para busca (sinônimos)'].toLowerCase().includes(primaryTermStart);
            const isB_Boosted = bNameMatch || bTagMatch;

            if (isA_Boosted && !isB_Boosted) return -1;
            if (isB_Boosted && !isA_Boosted) return 1;
        }

        // Prioridade 3: Score padrão do Fuse.js
        return a.score - b.score;
    });

    // Retorna no formato legado para compatibilidade: { item, matchCount }
    return uniqueResults.slice(0, 15).map(r => ({
        item: r.item,
        matchCount: Math.round((1 - r.score) * 10) // Converte score invertido pra peso antigo
    }));
}

async function getCachedCategoryData() {
    const now = Date.now();
    if (categoryCache && (now - lastCategoryCacheTime) < CACHE_TTL_MS) {
        return categoryCache;
    }

    let csvUrl = process.env.GOOGLE_SHEETS_URL_GERAL || process.env.GOOGLE_SHEETS_CATEGORIES_URL;
    if (!csvUrl) {
        console.warn("[Google Sheets] Variável GOOGLE_SHEETS_URL_GERAL não definida. Tabela de Categorias ignorada.");
        return null; // Silent skip if not configured
    }

    csvUrl = csvUrl.replace(/\/pubhtml\/?$/, '/pub?output=csv');

    console.log("[Google Sheets] Baixando planilha secundária de categorias...");
    const data = await fetchGoogleSheetCSV(csvUrl);
    if (data) {
        // Blindagem Rígida de Cache: Filtrar dados sujos que vêm do Google Sheets
        const cleanData = data.filter(row => {
            const catName = row['categoria_geral'];
            return catName && catName.trim() !== '' && catName.toLowerCase() !== 'undefined';
        });

        categoryCache = cleanData;
        lastCategoryCacheTime = now;
        console.log(`[Google Sheets] ✅ Cache de Categorias Atualizado com Sucesso: ${cleanData.length} categorias/triagens válidas.`);
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

    for (const term of searchTerms) {
        const lowerTerm = term.toString().toLowerCase().trim();
        if (lowerTerm.length < 3) continue;

        const exactMatch = data.find(c => {
            const catName = (c['categoria_geral'] || '').toLowerCase();
            const tagsStr = (c['tags para busca (sinônimos)'] || c['sinonimos'] || c['tags'] || '').toLowerCase();

            // Match direto no nome ou vice-versa
            if (catName.includes(lowerTerm) || lowerTerm.includes(catName)) return true;

            // Match fracionado nos sinônimos (Separados por vírgula)
            const tags = tagsStr.split(',').map(t => t.trim());
            return tags.some(tag => tag && (lowerTerm.includes(tag) || tag.includes(lowerTerm)));
        });

        if (exactMatch) {
            console.log(`[Google Sheets] 🎯 Match Parcial/Tag encontrado para Categoria: ${exactMatch['categoria_geral']}`);
            return [exactMatch];
        }
    }

    const options = {
        includeScore: true,
        useExtendedSearch: true,
        threshold: 0.2, // Threshold mais de precisão
        minMatchCharLength: 3, // Proteção contra colisão de preposição
        ignoreLocation: true,
        keys: [
            { name: 'categoria_geral', weight: 1.0 },
            { name: 'tags para busca (sinônimos)', weight: 0.8 },
            { name: 'sinonimos', weight: 0.8 }
        ]
    };

    const fuse = new Fuse(data, options);
    let allResults = [];

    // Busca iterativa de Categorias
    for (const term of searchTerms) {
        // Token Search (AND lógico) formatando a string do termo
        const tokenizedTerm = term.trim().split(/\s+/).join(' ');
        const results = fuse.search(tokenizedTerm);
        allResults = allResults.concat(results);
    }

    // Desduplicação estrita:
    const uniqueResults = Array.from(new Map(allResults.map(r => [r.item['categoria_geral'], r])).values());

    uniqueResults.sort((a, b) => {
        // Boost de Match Exato em Categorias
        const primaryTerm = searchTerms[0] ? searchTerms[0].toLowerCase() : '';
        const isA_Boosted = a.item['categoria_geral'] && a.item['categoria_geral'].toLowerCase().includes(primaryTerm);
        const isB_Boosted = b.item['categoria_geral'] && b.item['categoria_geral'].toLowerCase().includes(primaryTerm);

        if (isA_Boosted && !isB_Boosted) return -1;
        if (isB_Boosted && !isA_Boosted) return 1;

        return a.score - b.score;
    });

    if (uniqueResults && uniqueResults.length > 0) {
        return uniqueResults.slice(0, 5).map(r => r.item);
    }

    return [];
}

module.exports = {
    fetchGoogleSheetCSV,
    searchProductInSheet,
    searchCategoryInSheet,
    getCachedSheetData,
    getCachedCategoryData,
    forceRefreshCache,
    startAutoRefresh
};
