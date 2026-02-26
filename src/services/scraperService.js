const puppeteer = require('puppeteer');
const { Mutex } = require('async-mutex');

// Singleton variables
let browserInstance = null;
const scraperMutex = new Mutex();

/**
 * Inicia o browser Singleton (chamado na inicialização do app).
 */
async function initializeBrowser() {
    if (browserInstance) return browserInstance;

    try {
        console.log('[Scraper] Iniciando Puppeteer em background...');
        browserInstance = await puppeteer.launch({
            headless: true, // Ou "new" em versões recentes
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--disable-gpu',
                '--window-size=1024,768',
                '--single-process' // Útil em e2-micro para economizar recursos (pode ser instável em alguns SOs, remova se der erro)
            ]
        });
        console.log('[Scraper] Puppeteer iniciado com sucesso.');
        return browserInstance;
    } catch (e) {
        console.error('[Scraper] Erro ao iniciar Puppeteer:', e);
        return null;
    }
}

/**
 * Configura uma aba (page) para economizar o máximo de memória possível
 * cancelando o carregamento de imagens, fontes e arquivos CSS.
 */
async function optimizePage(page) {
    await page.setRequestInterception(true);
    page.on('request', (request) => {
        const resourceType = request.resourceType();
        if (
            resourceType === 'image' ||
            resourceType === 'stylesheet' ||
            resourceType === 'font' ||
            resourceType === 'media'
        ) {
            request.abort();
        } else {
            request.continue();
        }
    });
}

/**
 * Função para fechar o browser (se precisarmos desligar o sistema).
 */
async function closeBrowser() {
    if (browserInstance) {
        await browserInstance.close();
        browserInstance = null;
        console.log('[Scraper] Puppeteer encerrado.');
    }
}

/**
 * Consulta o estoque em tempo real usando Puppeteer e a trava de segurança (Mutex).
 * 
 * @param {string} ean Código EAN ou código interno do produto
 * @returns {Promise<number|null>} Retorna o estoque (number) ou null se falhar.
 */
async function fetchRealTimeStock(ean) {
    if (!browserInstance) {
        console.warn('[Scraper] Browser não foi inicializado. Iniciando agora...');
        await initializeBrowser();
    }

    if (!browserInstance) {
        console.error('[Scraper] Falha crítica: Browser não estã disponível.');
        return null; // Fallback: não encontrou saldo online
    }

    // Trava de concorrência: Apenas 1 cliente por vez!
    const release = await scraperMutex.acquire();
    console.log(`[Scraper] 🔒 Lock adquirido para pesquisa do EAN: ${ean}`);

    let page = null;
    try {
        page = await browserInstance.newPage();
        await optimizePage(page);

        // Exemplo Genérico de Login (O usuário precisa atualizar com a URL ou lógica real do SnapControl)
        const snapUrl = process.env.SNAPCONTROL_URL;
        const snapUser = process.env.SNAPCONTROL_USER;
        const snapPass = process.env.SNAPCONTROL_PASS;

        if (!snapUrl || !snapUser || !snapPass) {
            console.error('[Scraper] Credenciais do SnapControl não encontradas no .env');
            return null;
        }

        // --- INÍCIO DA LÓGICA DE LOGIN (Exemplo Base) ---
        // await page.goto(snapUrl + '/login', { waitUntil: 'domcontentloaded' });
        // await page.type('#user', snapUser);
        // await page.type('#password', snapPass);
        // await Promise.all([
        //     page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
        //     page.click('#btn-login')
        // ]);

        // --- INÍCIO DA LÓGICA DE BUSCA DO PRODUTO (Exemplo Base) ---
        // await page.goto(`${snapUrl}/produtos/buscar?q=${ean}`, { waitUntil: 'domcontentloaded' });

        // const estoqueElement = await page.$('.estoque-valor');
        // if (estoqueElement) {
        //     const estoqueText = await page.evaluate(el => el.textContent, estoqueElement);
        //     console.log(`[Scraper] ✅ Saldo raspado para ${ean}: ${estoqueText}`);
        //     return parseFloat(estoqueText) || 0;
        // } else {
        //     console.log(`[Scraper] Produto ${ean} sem estoque ou não encontrado na tela.`);
        //     return 0;
        // }

        // Como não temos a URL ou a estrutura HTML real do SnapControl, 
        // deixamos este Mock temporário que retorna 0 (disparando a feature VIP)
        // O usuário deverá ajustar o script conforme a DOM do sistema.
        console.log(`[Scraper - MOCK] Fingindo buscar o estoque ao vivo para EAN: ${ean}...`);
        await new Promise(resolve => setTimeout(resolve, 2000));
        return 0;

    } catch (error) {
        console.error(`[Scraper] ❌ Erro durante raspagem do EAN ${ean}:`, error);
        return null;
    } finally {
        if (page) {
            await page.close(); // Sempre fechar a aba
        }
        console.log(`[Scraper] 🔓 Lock liberado para EAN: ${ean}`);
        release();
    }
}

module.exports = {
    initializeBrowser,
    closeBrowser,
    fetchRealTimeStock
};
