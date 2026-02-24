// Google Sheets API Integration Service
// Usando 'fetch' nativo do Node 18+

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

/**
 * Busca por palavras-chaves nos itens dinâmicos do Google Sheets
 */
async function searchProductInSheet(keywords) {
    const csvUrl = process.env.GOOGLE_SHEET_CSV_URL;
    if (!csvUrl) {
        return null; // Não configurado, pula para o Fallback.
    }

    const data = await fetchGoogleSheetCSV(csvUrl);
    if (!data) return null; // Erro no download, pula para fallback

    const cleanKeywords = keywords.toLowerCase().replace(/[?,.!\n]/g, ' ');
    const stopWords = ['voces', 'tem', 'algum', 'de', 'da', 'do', 'um', 'uma', 'quais', 'qual', 'o', 'a', 'quero', 'gostaria', 'saber', 'se', 'por', 'favor', 'como', 'funciona', 'para', 'que', 'serve', 'marca', 'marcas', 'vocês', 'você', 'voce', 'temos', 'modelo', 'modelos', 'ola', 'bom', 'dia', 'tarde', 'noite', 'tudo', 'bem', 'certo', 'preciso'];
    const searchTerms = cleanKeywords.split(/\s+/).filter(p => p.length > 2 && !stopWords.includes(p));

    if (searchTerms.length === 0) return []; // Procura muito curta

    const results = [];
    for (const item of data) {
        let matchCount = 0;

        // Obter todo o texto da linha (fallback geral)
        const rowText = Object.values(item).join(' ').toLowerCase();

        // Extrair todas as colunas pedidas explicitamente na formatação lowercase
        const title = (item['modelo/produto'] || '').toLowerCase();
        const tags = (item['tags para busca (sinônimos)'] || '').toLowerCase();
        const marca = (item['marca'] || '').toLowerCase();
        const categoria = (item['categoria'] || '').toLowerCase();
        const chars = (item['características principais'] || '').toLowerCase();
        const codigo = (item['código'] || item['codigo'] || '').toLowerCase();

        for (const term of searchTerms) {
            // Peso Altíssimo para Título exato, Código ou Marca Exata
            if (title.includes(term) || codigo.includes(term) || marca === term) {
                matchCount += 4;
            }
            // Peso Alto para Tags diretas
            else if (tags.includes(term)) {
                matchCount += 3;
            }
            // Peso Médio para Categoria ou Marca Parcial
            else if (categoria.includes(term) || marca.includes(term)) {
                matchCount += 2;
            }
            // Peso Baixo para menção livre nas Características ou Fallback geral
            else if (chars.includes(term) || rowText.includes(term)) {
                matchCount += 1;
            }
        }

        if (matchCount > 0) {
            results.push({ item, matchCount });
        }
    }

    // Ordena pelo maior número de termos encontrados
    results.sort((a, b) => b.matchCount - a.matchCount);

    // Retorna os top 8 resultados (aumentando a amostragem para a IA decidir melhor)
    return results.slice(0, 8).map(r => r.item);
}

module.exports = { searchProductInSheet };
