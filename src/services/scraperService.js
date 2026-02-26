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

        // Remove any trailing parameters from the login URL if needed or use as is
        let loginUrl = snapUrl;

        await page.goto(loginUrl, { waitUntil: 'domcontentloaded' });

        // Identificadores APEX padrão (SnapControl) ou Genéricos
        const userSelector = '#P200_USERNAME, #user, input[type="text"]';
        const passSelector = '#P200_PASSWORD, #password, input[type="password"]';
        const btnSelector = '#B200_LOGIN, #btn-login, button[type="submit"]';

        await page.waitForSelector(userSelector, { timeout: 5000 });
        await page.type(userSelector, snapUser);
        await page.type(passSelector, snapPass);

        await Promise.all([
            page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
            page.click(btnSelector)
        ]);

        // --- BUSCA DO PRODUTO PÓS-LOGIN ---
        // Adapte a URL conforme a infraestrutura REST/APEX do SnapControl
        const searchPath = snapUrl.includes('f?p=') ? snapUrl.replace(/f\?p=200:.*/, `produtos/buscar?q=${ean}`) : `${snapUrl}/produtos/buscar?q=${ean}`;
        await page.goto(searchPath, { waitUntil: 'domcontentloaded' });

        const estoqueSelector = '.estoque-valor, .saldo-estoque, td.estoque';

        try {
            await page.waitForSelector(estoqueSelector, { timeout: 3000 });
            const estoqueText = await page.$eval(estoqueSelector, el => el.textContent);
            console.log(`[Scraper] ✅ Saldo raspado para ${ean}: ${estoqueText}`);
            return parseFloat(estoqueText.replace(',', '.')) || 0;
        } catch (e) {
            console.log(`[Scraper] Produto ${ean} sem estoque positivo ou não encontrado na tela.`);
            return 0; // Interpreta falha visual/inexistêcia como Estoque 0 -> feature VIP Redirect
        }

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
