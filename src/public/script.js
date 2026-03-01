const API_URL = '/api';
const socket = io();

/* =========================================================================
   1. UI Logic & Animations
   ========================================================================= */

// Theme Toggle
const themeToggle = document.getElementById('theme-toggle');
const themeIcon = document.getElementById('theme-icon');
const htmlTag = document.documentElement;

themeToggle.addEventListener('click', () => {
    htmlTag.classList.toggle('dark');
    if (htmlTag.classList.contains('dark')) {
        themeIcon.setAttribute('data-lucide', 'sun');
    } else {
        themeIcon.setAttribute('data-lucide', 'moon');
    }
    lucide.createIcons();
    // Re-render chart colors if needed
    if (window.myChart) {
        window.myChart.options.plugins.legend.labels.color = htmlTag.classList.contains('dark') ? '#f9fafb' : '#1f2937';
        window.myChart.update();
    }
});

// Vanilla 3D Tilt Engine
function enableTilt() {
    const cards = document.querySelectorAll('.auto-tilt');
    cards.forEach(card => {
        card.addEventListener('mousemove', (e) => {
            const rect = card.getBoundingClientRect();
            const x = e.clientX - rect.left; // x position within the element.
            const y = e.clientY - rect.top;  // y position within the element.

            const centerX = rect.width / 2;
            const centerY = rect.height / 2;

            // Calculate rotation degrees (max 7 deg for smooth neumorphism)
            const rotateX = ((y - centerY) / centerY) * -7;
            const rotateY = ((x - centerX) / centerX) * 7;

            card.style.transform = `perspective(1000px) rotateX(${rotateX}deg) rotateY(${rotateY}deg) scale3d(1.02, 1.02, 1.02)`;
        });

        card.addEventListener('mouseleave', () => {
            card.style.transform = `perspective(1000px) rotateX(0deg) rotateY(0deg) scale3d(1, 1, 1)`;
        });
    });
}
enableTilt();

// Number Animators mapped to their elements
let countUpMsg = null;
let countUpHandoff = null;

if (typeof countUp !== 'undefined') {
    countUpMsg = new countUp.CountUp('msg-count', 0, { duration: 2.5, useEasing: true });
    countUpHandoff = new countUp.CountUp('handoff-count', 0, { duration: 2, useEasing: true });
}

function updateRetentionRing(total, handoffs) {
    const circle = document.getElementById('retention-circle');
    const pctLabel = document.getElementById('retention-pct');
    if (!circle || !pctLabel) return;

    // Circumference = 2 * Math.PI * r (r=50) ~= 314.159
    const circumference = 314.159;

    let retention = 100;
    if (total > 0) {
        retention = Math.max(0, 100 - ((handoffs / total) * 100));
    } else if (total === 0 && handoffs === 0) {
        retention = 100;
    }

    // Update label with CountUp if possible
    pctLabel.textContent = retention.toFixed(1) + '%';

    // Calculate offset: 100% = 0 offset, 0% = circumference offset
    const offset = circumference - (retention / 100) * circumference;
    circle.style.strokeDashoffset = offset;

    // Change color based on threshold
    if (retention < 70) {
        circle.classList.remove('text-success', 'text-warning');
        circle.classList.add('text-danger');
    } else if (retention < 90) {
        circle.classList.remove('text-success', 'text-danger');
        circle.classList.add('text-warning');
    } else {
        circle.classList.remove('text-warning', 'text-danger');
        circle.classList.add('text-success');
    }
}


/* =========================================================================
   2. Socket Logic & Data
   ========================================================================= */

socket.on('status', (data) => {
    document.getElementById('bot-toggle').checked = data.enabled;
    const testToggle = document.getElementById('test-toggle');
    if (testToggle) testToggle.checked = data.testMode;

    const wsDiv = document.getElementById('ws-status');
    if (data.initialized) {
        wsDiv.innerHTML = '<i data-lucide="wifi" class="w-4 h-4"></i> <span>Online</span>';
        wsDiv.className = "neo-inset px-4 py-1.5 flex items-center gap-2 text-sm font-semibold text-success";
    } else {
        wsDiv.innerHTML = '<i data-lucide="wifi-off" class="w-4 h-4"></i> <span>Aguardando</span>';
        wsDiv.className = "neo-inset px-4 py-1.5 flex items-center gap-2 text-sm font-semibold text-warning";
    }
    lucide.createIcons();
});

socket.on('qr', (qrData) => {
    document.getElementById('qr-container').style.display = 'block';
    const qrDiv = document.getElementById('qrcode');
    qrDiv.innerHTML = "";
    new QRCode(qrDiv, { text: qrData, width: 220, height: 220, colorDark: "#000000", colorLight: "#ffffff" });
});

socket.on('ready', (isReady) => {
    if (!isReady) return;
    document.getElementById('qr-container').style.display = 'none';
});

// Simulated Log Stream for the Cyber-Terminal
socket.on('log', (msg) => {
    const term = document.getElementById('log-terminal');
    const d = new Date();
    const time = `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}`;
    const entry = document.createElement('div');
    entry.textContent = `[${time}] ${msg}`;
    term.prepend(entry);

    // Auto purge lines if too many
    if (term.childElementCount > 50) {
        term.removeChild(term.lastChild);
    }
});


/* =========================================================================
   3. API Logic
   ========================================================================= */

window.toggleBot = async function () {
    const currentState = document.getElementById('bot-toggle').checked;
    await fetch(`${API_URL}/toggle`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'power', enabled: currentState }) });
}

window.toggleTestMode = async function () {
    const currentState = document.getElementById('test-toggle').checked;
    await fetch(`${API_URL}/toggle`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'test', enabled: currentState }) });
}

window.restartSystem = async function () {
    if (!confirm("Reiniciar todo o core? (Desconecta sessões pendentes)")) return;
    await fetch(`${API_URL}/restart`, { method: 'POST' });
    location.reload();
}

async function loadMetrics() {
    try {
        const res = await fetch(`${API_URL}/metrics`);
        const data = await res.json();

        let msgs = data.messages_processed || 0;
        let handoffs = data.handoffs || 0;

        if (countUpMsg && !countUpMsg.error) {
            countUpMsg.update(msgs);
            if (!countUpMsg.started) countUpMsg.start();
            countUpHandoff.update(handoffs);
            if (!countUpHandoff.started) countUpHandoff.start();
        } else {
            document.getElementById('msg-count').textContent = msgs;
            document.getElementById('handoff-count').textContent = handoffs;
        }

        updateRetentionRing(msgs, handoffs);
        renderChart(data.ratings);

        // Fetch missed demand
        await loadMissedDemand();

        // Render mock top products for Zone 3 until we build a metrics endpoint for it
        renderMockTopProducts();

    } catch (e) {
        console.error("Metrics load err:", e);
    }
}

async function loadMissedDemand() {
    try {
        const res = await fetch(`${API_URL}/demand`);
        const data = await res.json();

        const list = document.getElementById('missed-demand-list');
        if (!data || data.length === 0) {
            list.innerHTML = '<div class="text-text-muted text-center pt-8">Sem registros recentes.</div>';
            return;
        }

        list.innerHTML = data.map(item => {
            const date = new Date(item.lastRequestedAt);
            const timeStr = `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`;
            return `
            <div class="flex justify-between items-center border-b border-glass-border pb-1">
                <span class="font-semibold truncate mr-2" title="${item.productName}">"${item.productName}"</span>
                <span class="text-[10px] text-text-muted whitespace-nowrap"><span class="text-warning mr-1">(${item.searchCount}x)</span> ${timeStr}</span>
            </div>
            `;
        }).join('');
    } catch (e) {
        // Fallback
        const list = document.getElementById('missed-demand-list');
        list.innerHTML = '<div class="text-danger text-center pt-8">Falha ao carregar API.</div>';
    }
}

function renderMockTopProducts() {
    const list = document.getElementById('top-products-list');
    const products = [
        { name: 'Ducha Zagonel Optima', pct: 85 },
        { name: 'Fita Veda Rosca', pct: 60 },
        { name: 'Disjuntor Siemens', pct: 45 },
        { name: 'Parafuso Philips', pct: 30 }
    ];

    list.innerHTML = products.map((p, i) => {
        // Delay animation for a cascade effect
        setTimeout(() => {
            const bar = document.getElementById(`bar-${i}`);
            if (bar) bar.style.width = `${p.pct}%`;
        }, 300 + (i * 150));

        return `
        <div>
            <div class="flex justify-between text-[10px] mb-1 font-semibold text-text-muted">
                <span>${p.name}</span>
                <span>${p.pct}%</span>
            </div>
            <div class="neo-progress-bar">
                <div id="bar-${i}" class="neo-progress-fill" style="width: 0%"></div>
            </div>
        </div>
        `;
    }).join('');
}


function renderChart(ratings) {
    const ctx = document.getElementById('satisfactionChart').getContext('2d');
    const counts = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    let totalScore = 0;
    let totalVotes = 0;

    ratings.forEach(r => {
        if (counts[r.score] !== undefined) {
            counts[r.score]++;
            totalScore += r.score;
            totalVotes++;
        }
    });

    const avg = totalVotes > 0 ? (totalScore / totalVotes).toFixed(1) : "0.0";
    document.getElementById('chart-center-avg').innerHTML = `<span class="text-2xl block">${avg}</span><span class="text-[10px] block text-text-muted leading-none">Média</span>`;

    if (window.myChart) window.myChart.destroy();

    const isDark = document.documentElement.classList.contains('dark');

    window.myChart = new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels: ['1 ⭐', '2 ⭐', '3 ⭐', '4 ⭐', '5 ⭐'],
            datasets: [{
                data: [counts[1], counts[2], counts[3], counts[4], counts[5]],
                backgroundColor: ['#ef4444', '#f97316', '#eab308', '#3b82f6', '#10b981'],
                borderWidth: 0,
                hoverOffset: 6
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            cutout: '72%',
            plugins: {
                legend: { position: 'right', labels: { color: isDark ? '#f9fafb' : '#1f2937', font: { size: 10 } } }
            }
        }
    });
}

// Holidays
async function loadHolidays() {
    const res = await fetch(`${API_URL}/holidays`);
    const data = await res.json();
    const list = document.getElementById('holiday-list');
    list.innerHTML = '';
    data.dates.forEach(date => {
        const [y, m, d] = date.split('-');
        const li = document.createElement('li');
        li.className = "flex justify-between items-center border-b border-glass-border pb-1";
        li.innerHTML = `<span><i data-lucide="calendar" class="inline w-3 h-3"></i> ${d}/${m}/${y}</span> <button class="text-danger hover:text-red-400" onclick="removeHoliday('${date}')"><i data-lucide="trash-2" class="w-3 h-3"></i></button>`;
        list.appendChild(li);
    });
    lucide.createIcons();
}

window.addHoliday = async function () {
    const date = document.getElementById('holiday-input').value;
    if (!date) return;
    const res = await fetch(`${API_URL}/holidays`);
    const data = await res.json();
    if (!data.dates.includes(date)) {
        data.dates.push(date);
        await fetch(`${API_URL}/holidays`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
        loadHolidays();
    }
}

window.removeHoliday = async function (date) {
    const res = await fetch(`${API_URL}/holidays`);
    const data = await res.json();
    data.dates = data.dates.filter(d => d !== date);
    await fetch(`${API_URL}/holidays`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    loadHolidays();
}


// Boot
loadMetrics();
loadHolidays();
setInterval(loadMetrics, 60000); // 1-minute ticker
