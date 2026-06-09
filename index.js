const fs = require('fs');
const path = require('path');

// --- PROTEÇÃO CONTRA CRASH POR ERRO DE CRIPTOGRAFIA (Baileys) ---
// Captura erros fatais que matam o processo antes do reconnect handler agir
process.on('uncaughtException', (err) => {
    console.error('🚨 [UNCAUGHT EXCEPTION]:', err.message);

    const isCryptoError = err.message.includes('Unsupported state or unable to authenticate data') ||
        err.message.includes('bad decrypt') ||
        err.message.includes('wrong final block length') ||
        err.message.includes('unable to authenticate');

    if (isCryptoError) {
        console.error('🔑 [Auto-Recovery] Erro de criptografia detectado. Limpando sessão corrompida...');
        const authDir = path.join(__dirname, 'auth_info_baileys');
        try {
            if (fs.existsSync(authDir)) {
                fs.rmSync(authDir, { recursive: true, force: true });
                fs.mkdirSync(authDir, { recursive: true });
                console.log('🔑 [Auto-Recovery] Sessão limpa com sucesso. Reiniciando em 3s...');
            }
        } catch (cleanErr) {
            console.error('🔑 [Auto-Recovery] Falha ao limpar sessão:', cleanErr.message);
        }
        // Sai com código 1 para o Docker reiniciar automaticamente (--restart unless-stopped)
        setTimeout(() => process.exit(1), 3000);
    } else {
        console.error('❌ [FATAL] Erro não recuperável:', err.stack);
        setTimeout(() => process.exit(1), 1000);
    }
});

process.on('unhandledRejection', (reason) => {
    console.error('🚨 [UNHANDLED REJECTION]:', reason);
    // Não mata o processo — apenas loga para não derrubar o bot por promises soltas
});

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
