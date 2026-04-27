const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { Server } = require("socket.io");
const basicAuth = require('express-basic-auth');

const metricsService = require('../services/metricsService');
const settings = require('../config/settings');
const googleSheetsService = require('../services/googleSheetsService');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

// State
let botEnabled = true;
let testMode = true;
let fullStockEnabled = false;
const handoffQueue = []; // In-memory handoff queue
const ALLOWED_NUMBERS = ['555199106294', '189524122574884', '555196870986', '555199078225', '224704216436825']; // User's numbers

app.use(cors());
app.use(bodyParser.json());

// Permite a criação do QRCode e scripts externos do painel
app.use((req, res, next) => {
    res.setHeader(
        'Content-Security-Policy',
        "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:;"
    );
    next();
});

app.use(express.static(path.join(__dirname, '../public')));

// Feature 6: Dashboard Analítico Protegido
const dashboardUser = process.env.DASHBOARD_USER || 'admin';
const dashboardPass = process.env.DASHBOARD_PASS || 'admin123';

const authMiddleware = basicAuth({
    users: { [dashboardUser]: dashboardPass },
    challenge: true,
    realm: 'Admin Dashboard Ferragem Marlene',
});

// A Rota HTML do Dashboard
app.get('/admin/dashboard', authMiddleware, (req, res) => {
    res.sendFile(path.join(__dirname, '../public/dashboard.html'));
});

// Store IO instance globally to be used by bot.js (via export or event bus)
// For simplicity, we'll export a function to emit events
function emitEvent(event, data) {
    io.emit(event, data);
}

// Socket Connection
io.on('connection', (socket) => {
    console.log('Cliente Web conectado');
    // Send current status immediately
    const bot = require('../bot');
    socket.emit('status', { enabled: botEnabled, testMode: testMode, fullStockEnabled: fullStockEnabled, initialized: bot.isInitialized ? bot.isInitialized() : false });
});

// API Routes

// Toggle Bot
app.post('/api/toggle', (req, res) => {
    if (req.body.type === 'power') {
        botEnabled = req.body.enabled;
    } else if (req.body.type === 'test') {
        testMode = req.body.enabled;
    } else if (req.body.type === 'fullstock') {
        fullStockEnabled = req.body.enabled;
    }

    io.emit('status', { enabled: botEnabled, testMode: testMode, fullStockEnabled: fullStockEnabled });
    console.log(`Bot Status: Power=${botEnabled}, TestMode=${testMode}, FullStock=${fullStockEnabled}`);
    res.json({ success: true, enabled: botEnabled, testMode: testMode, fullStockEnabled: fullStockEnabled });
});

// Get Bot Status
app.get('/api/status', (req, res) => {
    // Check if bot client is initialized
    const bot = require('../bot');
    res.json({
        enabled: botEnabled,
        testMode: testMode,
        initialized: bot.isInitialized()
    });
});

// Start Bot
app.post('/api/start', async (req, res) => {
    try {
        const bot = require('../bot');
        if (bot.isInitialized && bot.isInitialized()) {
            return res.json({ success: true, message: "Bot já está inicializado" });
        }

        console.log("Iniciando Bot via Dashboard...");
        bot.initialize();
        res.json({ success: true });
    } catch (e) {
        console.error("Erro ao iniciar bot:", e);
        res.status(500).json({ error: "Erro ao iniciar bot" });
    }
});

// Restart Bot (Clean Start)
app.post('/api/restart', async (req, res) => {
    try {
        const bot = require('../bot');
        console.log("Reiniciando Sistema via Dashboard...");

        // Stop current client if exists
        if (bot.destroy) {
            await bot.destroy();
        }

        // Re-initialize
        bot.initialize();

        res.json({ success: true });
    } catch (e) {
        console.error("Erro ao reiniciar bot:", e);
        res.status(500).json({ error: "Erro ao reiniciar bot" });
    }
});


// Get Metrics
app.get('/api/metrics', (req, res) => {
    const metrics = metricsService.getMetrics();
    res.json(metrics);
});

// Get Store Exceptions (Dias Fechados, Horários Especiais)
app.get('/api/holidays', (req, res) => {
    try {
        const file = path.join(__dirname, '../../data/store_exceptions.json');
        if (!fs.existsSync(file)) {
            fs.writeFileSync(file, '[]');
        }
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        res.json(data);
    } catch (e) {
        console.error("Erro ao ler store_exceptions.json:", e);
        res.status(500).json({ error: "Erro ao ler exceções da loja" });
    }
});

// Update Store Exceptions
app.post('/api/holidays', (req, res) => {
    try {
        const file = path.join(__dirname, '../../data/store_exceptions.json');
        const data = Array.isArray(req.body) ? req.body : [];
        fs.writeFileSync(file, JSON.stringify(data, null, 2));
        res.json({ success: true });
    } catch (e) {
        console.error("Erro ao salvar store_exceptions.json:", e);
        res.status(500).json({ error: "Erro ao salvar exceções da loja" });
    }
});

// Feature 4: Demanda Reprimida API Endpoint
app.get('/api/ranking', async (req, res) => {
    try {
        const { PrismaClient } = require('@prisma/client');
        const prisma = new PrismaClient();

        const ranking = await prisma.missedDemand.findMany({
            orderBy: { searchCount: 'desc' },
            take: 10
        });

        // Simples proteção CORS extra ou retorno. O CORS wrapper geral ('app.use(cors())') já está ativo.
        res.json(ranking);
        await prisma.$disconnect();
    } catch (e) {
        console.error("Erro ao buscar ranking de demanda:", e);
        res.status(500).json({ error: "Erro interno ao buscar ranking" });
    }
});

// Force Sync Sheets
app.post('/api/force-sync', async (req, res) => {
    try {
        console.log("[Dashboard] Forçando sincronização das planilhas...");
        const result = await googleSheetsService.forceRefreshCache();
        io.emit('log', `Sync manual: ${result.principal} itens (principal) + ${result.categoria} categorias recarregados.`);
        res.json({ success: true, ...result });
    } catch (e) {
        console.error("Erro ao forçar sync:", e);
        res.status(500).json({ error: "Erro ao sincronizar planilhas" });
    }
});

// Get Handoff Queue
app.get('/api/handoffs', (req, res) => {
    res.json(handoffQueue);
});

// Resolve Handoff (remove from queue)
app.post('/api/handoffs/resolve', (req, res) => {
    const { id } = req.body;
    const idx = handoffQueue.findIndex(h => h.id === id);
    if (idx !== -1) {
        handoffQueue.splice(idx, 1);
        io.emit('handoff_update', handoffQueue);
        res.json({ success: true });
    } else {
        res.status(404).json({ error: "Handoff não encontrado" });
    }
});

// Add Handoff (called by bot.js)
function addHandoff(data) {
    const entry = {
        id: Date.now().toString(),
        phone: data.phone || 'Desconhecido',
        reason: data.reason || 'Handoff',
        time: new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' }),
        timestamp: Date.now()
    };
    handoffQueue.push(entry);
    // Keep only last 20
    if (handoffQueue.length > 20) handoffQueue.shift();
    io.emit('handoff_update', handoffQueue);
    return entry;
}

// Start Server
function startServer() {
    server.listen(PORT, () => {
        console.log(`Admin Dashboard rodando em http://localhost:${PORT}`);
    });
}

function isBotEnabled() {
    return botEnabled;
}

function isTestMode() {
    return testMode;
}

function isFullStockEnabled() {
    return fullStockEnabled;
}

function getAllowedNumbers() {
    return ALLOWED_NUMBERS;
}

module.exports = {
    startServer,
    isBotEnabled,
    isTestMode,
    isFullStockEnabled,
    getAllowedNumbers,
    emitEvent,
    addHandoff
};
