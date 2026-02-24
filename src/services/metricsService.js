const fs = require('fs');
const path = require('path');

const METRICS_FILE = path.join(__dirname, '../../data/metricas.json');
const DEMANDA_FILE = path.join(__dirname, '../../data/demanda_reprimida.csv');

// Initialize metrics if not exists
if (!fs.existsSync(METRICS_FILE)) {
    fs.writeFileSync(METRICS_FILE, JSON.stringify({
        ratings: [], // { date, score, comment }
        handoffs: 0,
        messages_processed: 0
    }, null, 2));
}

// Initialize CSV header if not exists
if (!fs.existsSync(DEMANDA_FILE)) {
    fs.writeFileSync(DEMANDA_FILE, "Data,Produto_Procurado,Estoque_Status,Usuario_Tel\n");
}

function getMetrics() {
    try {
        const data = fs.readFileSync(METRICS_FILE, 'utf8');
        return JSON.parse(data);
    } catch (e) {
        console.error("Erro ao ler métricas:", e);
        return { ratings: [], handoffs: 0, messages_processed: 0 };
    }
}

function saveMetrics(metrics) {
    fs.writeFileSync(METRICS_FILE, JSON.stringify(metrics, null, 2));
}

function addRating(score, comment = "") {
    const metrics = getMetrics();
    metrics.ratings.push({
        date: new Date().toISOString(),
        score: parseInt(score),
        comment
    });
    saveMetrics(metrics);
}

function incrementHandoff() {
    const metrics = getMetrics();
    metrics.handoffs = (metrics.handoffs || 0) + 1;
    saveMetrics(metrics);
}

function incrementMessages() {
    const metrics = getMetrics();
    metrics.messages_processed = (metrics.messages_processed || 0) + 1;
    saveMetrics(metrics);
}

function logMissedSale(productName, userPhone) {
    const line = `${new Date().toISOString()},"${productName}","Sem Estoque","${userPhone}"\n`;
    fs.appendFileSync(DEMANDA_FILE, line);
}

module.exports = {
    getMetrics,
    addRating,
    incrementHandoff,
    incrementMessages,
    logMissedSale
};
