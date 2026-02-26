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

        // Identificadores APEX exatos (Passos 2, 3 e 4)
        const userSelector = '#P101_USERNAME';
        const passSelector = '#P101_PASSWORD';
        const btnSelector = '#btn_login';

        await page.waitForSelector(userSelector, { timeout: 10000 });
        await page.type(userSelector, snapUser);
        await page.type(passSelector, snapPass);

        await Promise.all([
            page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
            page.click(btnSelector)
        ]);

        // Passo 5: Aguardar aba de produtos e clicar
        const produtosMenuSelector = 'a[title="Produtos"]';
        await page.waitForSelector(produtosMenuSelector, { timeout: 10000 });
        await Promise.all([
            page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
            page.click(produtosMenuSelector)
        ]);

        // Fix: Espera forçada para renderização lenta da DOM do APEX
        await new Promise(r => setTimeout(r, 4000));

        // Passo 6: Aguardar barra de pesquisa, digitar EAN e dar Enter
        const searchInputSelector = '#P90_PESQUISAR';
        await page.waitForSelector(searchInputSelector, { timeout: 10000 });
        await page.type(searchInputSelector, ean.toString());

        // Disparando o formulário através da tecla Enter e aguardando recarga
        await Promise.all([
            page.waitForNavigation({ waitUntil: 'networkidle2' }),
            page.keyboard.press('Enter')
        ]);

        // Passo 7: Extrair o estoque da tabela td.estoque_td
        const estoqueSelector = 'td.estoque_td';

        try {
            await page.waitForSelector(estoqueSelector, { timeout: 5000 });
            const estoqueText = await page.$eval(estoqueSelector, el => el.textContent);

            // Tratamento da string (de "46,00" para 46)
            const cleanText = estoqueText.replace(',', '.');
            const finalValue = Math.floor(parseFloat(cleanText)) || 0;

            console.log(`[Scraper] ✅ Saldo raspado para ${ean}: ${finalValue}`);
            return finalValue;
        } catch (e) {
            console.log(`[Scraper] Produto ${ean} sem estoque positivo ou não encontrado na tela.`);
            return 0; // Interpreta falha visual/inexistêcia como Estoque 0
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
