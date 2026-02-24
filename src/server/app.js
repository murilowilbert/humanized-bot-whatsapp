const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { Server } = require("socket.io");

const metricsService = require('../services/metricsService');
const settings = require('../config/settings');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

// State
let botEnabled = false;
let testMode = false;
const ALLOWED_NUMBERS = ['555199106294', '189524122574884', '555196870986', '555199078225', '224704216436825']; // User's numbers

app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, '../public')));

// Store IO instance globally to be used by bot.js (via export or event bus)
// For simplicity, we'll export a function to emit events
function emitEvent(event, data) {
    io.emit(event, data);
}

// Socket Connection
io.on('connection', (socket) => {
    console.log('Cliente Web conectado');
    // Send current status immediately
    socket.emit('status', { enabled: botEnabled });
});

// API Routes

// Toggle Bot
app.post('/api/toggle', (req, res) => {
    if (req.body.type === 'power') {
        botEnabled = req.body.enabled;
    } else if (req.body.type === 'test') {
        testMode = req.body.enabled;
    }

    io.emit('status', { enabled: botEnabled, testMode: testMode });
    console.log(`Bot Status: Power=${botEnabled}, TestMode=${testMode}`);
    res.json({ success: true, enabled: botEnabled, testMode: testMode });
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

// Socket Connection
io.on('connection', (socket) => {
    console.log('Cliente Web conectado (Refresh)');
    const bot = require('../bot');
    const initialized = bot.isInitialized ? bot.isInitialized() : false;
    // Send current status immediately
    socket.emit('status', { enabled: botEnabled, testMode: testMode, initialized: initialized });
});

// Get Metrics
app.get('/api/metrics', (req, res) => {
    const metrics = metricsService.getMetrics();
    res.json(metrics);
});

// Get Holidays
app.get('/api/holidays', (req, res) => {
    try {
        const file = path.join(__dirname, '../../data/holidays.json');
        const data = JSON.parse(fs.readFileSync(file));
        res.json(data);
    } catch (e) {
        res.status(500).json({ error: "Erro ao ler feriados" });
    }
});

// Update Holidays
app.post('/api/holidays', (req, res) => {
    try {
        const file = path.join(__dirname, '../../data/holidays.json');
        fs.writeFileSync(file, JSON.stringify(req.body, null, 2));
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: "Erro ao salvar feriados" });
    }
});

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

function getAllowedNumbers() {
    return ALLOWED_NUMBERS;
}

module.exports = { startServer, emitEvent, isBotEnabled, isTestMode, getAllowedNumbers };
