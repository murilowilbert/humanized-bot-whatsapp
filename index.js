const client = require('./src/bot');
const server = require('./src/server/app');
const scraperService = require('./src/services/scraperService');

console.log("Iniciando Sistema Ferragem Marlene...");

// 1. Start Dashboard Server
server.startServer();

// 2. Initialize Puppeteer Singleton
scraperService.initializeBrowser();

console.log("Sistema Ferragem Marlene iniciado.");

// 3. Auto-Boot Trigger
if (server.isBotEnabled()) {
    console.log("[Auto-Boot] Estado padrão ligado (Power=true). Inicializando bot automaticamente o painel web...");
    client.initialize();
} else {
    console.log("Aguardando inicialização manual do Bot via Painel Web...");
}
