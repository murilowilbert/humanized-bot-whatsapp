const client = require('./src/bot');
const server = require('./src/server/app');
const scraperService = require('./src/services/scraperService');

console.log("Iniciando Sistema Ferragem Marlene...");

// 1. Start Dashboard Server
server.startServer();

// 2. Initialize Puppeteer Singleton
scraperService.initializeBrowser();

console.log("Sistema Ferragem Marlene iniciado.");
console.log("Aguardando inicialização do Bot via Painel Web...");
