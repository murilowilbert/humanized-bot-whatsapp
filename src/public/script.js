const API_URL = '/api';
const socket = io();

// Socket Events
socket.on('status', (data) => {
    document.getElementById('bot-toggle').checked = data.enabled;
    document.getElementById('test-toggle').checked = data.testMode;
    document.getElementById('fullstock-toggle').checked = data.fullStockEnabled;
    const badge = document.getElementById('status-badge');
    const startBtn = document.getElementById('start-btn');

    if (data.initialized) {
        startBtn.style.display = 'none';
        badge.className = "badge online";
        badge.innerHTML = '<i data-lucide="check-circle"></i> Sistema Pronto';
        if (data.enabled) {
            badge.innerHTML += ' | Ativo';
        }
    } else {
        startBtn.style.display = 'flex';
        badge.className = "badge offline";

        if (data.enabled) {
            badge.innerHTML = '<i data-lucide="loader"></i> Aguardando QR Code...';
        } else {
            badge.innerHTML = '<i data-lucide="wifi-off"></i> Bot Desligado';
        }
    }

    lucide.createIcons();
});

socket.on('qr', (qrData) => {
    document.getElementById('qr-container').style.display = 'block';
    const qrDiv = document.getElementById('qrcode');
    qrDiv.innerHTML = ""; // Clear previous

    // Create QR with specific dimensions
    new QRCode(qrDiv, {
        text: qrData,
        width: 256,
        height: 256,
        colorDark: "#000000",
        colorLight: "#ffffff",
        correctLevel: QRCode.CorrectLevel.H
    });
});

socket.on('ready', (isReady) => {
    if (!isReady) {
        // Se isReady vier falso (desconectou), reseta para o estado Aguardando QR.
        const badge = document.getElementById('status-badge');
        badge.className = "badge offline";
        badge.innerHTML = '<i data-lucide="loader"></i> Aguardando Conexão...';
        lucide.createIcons();
        return;
    }

    document.getElementById('qr-container').style.display = 'none';
    const badge = document.getElementById('status-badge');
    badge.className = "badge online";
    badge.innerHTML = '<i data-lucide="wifi"></i> Conectado';

    const startBtn = document.getElementById('start-btn');
    startBtn.style.display = 'none';
    startBtn.disabled = false;
    startBtn.innerHTML = '<i data-lucide="play"></i> Iniciar Bot';

    lucide.createIcons();
});

// Expose functions to window for HTML onclick access
window.toggleBot = async function () {
    const currentState = document.getElementById('bot-toggle').checked;
    console.log("Toggling Bot Power:", currentState);
    await sendToggle('power', currentState);
}

window.toggleTestMode = async function () {
    const currentState = document.getElementById('test-toggle').checked;
    console.log("Toggling Test Mode:", currentState);
    await sendToggle('test', currentState);
}

window.toggleFullStock = async function () {
    const currentState = document.getElementById('fullstock-toggle').checked;
    console.log("Toggling Full Stock:", currentState);
    await sendToggle('fullstock', currentState);
}

window.startBot = async function () {
    const btn = document.getElementById('start-btn');
    btn.disabled = true;
    btn.innerHTML = '<i data-lucide="loader" class="spin"></i> Iniciando...';
    lucide.createIcons();

    try {
        const res = await fetch(`${API_URL}/start`, { method: 'POST' });
        const data = await res.json();
        if (data.success) {
            console.log("Bot initialization started");
            if (data.message === "Bot já está inicializado") {
                btn.style.display = 'none';
                btn.disabled = false;
                btn.innerHTML = '<i data-lucide="play"></i> Iniciar Bot';
            }
        }
    } catch (e) {
        console.error("Start Error:", e);
        alert("Erro ao iniciar bot.");
        btn.disabled = false;
        btn.innerHTML = '<i data-lucide="play"></i> Iniciar Bot';
        lucide.createIcons();
    }
}

window.restartSystem = async function () {
    if (!confirm("Isso irá fechar o bot atual e iniciar um novo. Continuar?")) return;

    const btn = document.getElementById('restart-btn');
    btn.disabled = true;

    try {
        const res = await fetch(`${API_URL}/restart`, { method: 'POST' });
        const data = await res.json();
        if (data.success) {
            alert("Sistema reiniciando... Aguarde o QR Code se necessário.");
            location.reload(); // Refresh to reset UI state
        }
    } catch (e) {
        console.error("Restart Error:", e);
        alert("Erro ao reiniciar sistema.");
        btn.disabled = false;
    }
}

async function sendToggle(type, enabled) {
    try {
        const res = await fetch(`${API_URL}/toggle`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type, enabled })
        });
        const data = await res.json();
        console.log("Toggle Result:", data);
    } catch (e) {
        console.error("Toggle Error:", e);
        alert("Erro ao alterar status. Verifique o console.");
    }
}

async function loadMetrics() {
    const res = await fetch(`${API_URL}/metrics`);
    const data = await res.json();

    document.getElementById('msg-count').textContent = data.messages_processed || 0;
    document.getElementById('handoff-count').textContent = data.handoffs || 0;

    // Check missed sales
    // Typically we'd need an endpoint for thisCount, but for now placeholder
    // document.getElementById('missed-count').textContent = "Consultar CSV";

    renderChart(data.ratings);
}

function renderChart(ratings) {
    // Destroy previous chart if exists (Chart.js quirk, or just let it redraw on canvas)
    const ctx = document.getElementById('satisfactionChart').getContext('2d');

    const counts = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    ratings.forEach(r => {
        if (counts[r.score] !== undefined) counts[r.score]++;
    });

    // Determine colors based on dark mode
    const textColor = '#94a3b8';

    if (window.myChart) window.myChart.destroy();

    window.myChart = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: ['1 ⭐', '2 ⭐', '3 ⭐', '4 ⭐', '5 ⭐'],
            datasets: [{
                label: 'Avaliações',
                data: [counts[1], counts[2], counts[3], counts[4], counts[5]],
                backgroundColor: [
                    '#ef4444',
                    '#f97316',
                    '#eab308',
                    '#3b82f6',
                    '#22c55e'
                ],
                borderRadius: 4
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false }
            },
            scales: {
                y: {
                    beginAtZero: true,
                    ticks: { stepSize: 1, color: textColor },
                    grid: { color: '#334155' }
                },
                x: {
                    ticks: { color: textColor },
                    grid: { display: false }
                }
            }
        }
    });
}

async function loadHolidays() {
    const res = await fetch(`${API_URL}/holidays`);
    const data = await res.json();
    const list = document.getElementById('holiday-list');
    list.innerHTML = '';

    data.dates.forEach(date => {
        const li = document.createElement('li');
        // Format date to local
        const [y, m, d] = date.split('-');
        const fmtDate = `${d}/${m}/${y}`;

        li.innerHTML = `<span><i data-lucide="calendar"></i> ${fmtDate}</span> <button onclick="removeHoliday('${date}')"><i data-lucide="trash-2"></i></button>`;
        list.appendChild(li);
    });
    lucide.createIcons();
}

async function addHoliday() {
    const date = document.getElementById('holiday-input').value;
    if (!date) return;

    const res = await fetch(`${API_URL}/holidays`);
    const data = await res.json();

    if (!data.dates.includes(date)) {
        data.dates.push(date);
        await saveHolidays(data);
        loadHolidays();
    }
}

async function removeHoliday(date) {
    const res = await fetch(`${API_URL}/holidays`);
    const data = await res.json();

    data.dates = data.dates.filter(d => d !== date);
    await saveHolidays(data);
    loadHolidays();
}

async function saveHolidays(data) {
    await fetch(`${API_URL}/holidays`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
    });
}

// Init
loadMetrics();
loadHolidays();
setInterval(loadMetrics, 60000);
