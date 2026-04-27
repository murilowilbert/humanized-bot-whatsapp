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

// Tab Navigation Logic
document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        // Reset all buttons
        document.querySelectorAll('.tab-btn').forEach(b => {
            b.classList.remove('active', 'text-[#10b981]');
            b.classList.add('text-text-muted');
        });

        // Activate clicked button
        btn.classList.add('active', 'text-[#10b981]');
        btn.classList.remove('text-text-muted');

        // Hide all tabs
        document.querySelectorAll('.tab-content').forEach(content => {
            content.classList.remove('block');
            content.classList.add('hidden');
        });

        // Show target tab
        const targetId = btn.getAttribute('data-target');
        const targetElement = document.getElementById(targetId);
        if (targetElement) {
            targetElement.classList.remove('hidden');
            targetElement.classList.add('block');
        }
    });
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
    const fullstockToggle = document.getElementById('fullstock-toggle');
    if (fullstockToggle) fullstockToggle.checked = data.fullStockEnabled;

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

window.toggleFullStock = async function () {
    const currentState = document.getElementById('fullstock-toggle').checked;
    await fetch(`${API_URL}/toggle`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'fullstock', enabled: currentState }) });
}

window.startBot = async function () {
    const btn = document.getElementById('start-btn');
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i data-lucide="loader" class="w-5 h-5 spin-2d"></i>';
        lucide.createIcons();
    }
    await fetch(`${API_URL}/start`, { method: 'POST' });
}

window.restartSystem = async function () {
    if (!confirm("Reiniciar todo o core? (Desconecta sessões pendentes)")) return;
    await fetch(`${API_URL}/restart`, { method: 'POST' });
    location.reload();
}

window.forceSync = async function () {
    const btn = document.getElementById('sync-btn');
    const originalHtml = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<i data-lucide="loader" class="w-5 h-5 spin-2d"></i>';
    lucide.createIcons();

    try {
        const res = await fetch(`${API_URL}/force-sync`, { method: 'POST' });
        const data = await res.json();
        if (data.success) {
            btn.innerHTML = '<i data-lucide="check" class="w-5 h-5 text-success"></i>';
            lucide.createIcons();
            setTimeout(() => {
                btn.innerHTML = originalHtml;
                btn.disabled = false;
                lucide.createIcons();
            }, 2000);
        } else {
            throw new Error('Sync failed');
        }
    } catch (e) {
        console.error('Erro no force-sync:', e);
        btn.innerHTML = '<i data-lucide="x" class="w-5 h-5 text-danger"></i>';
        lucide.createIcons();
        setTimeout(() => {
            btn.innerHTML = originalHtml;
            btn.disabled = false;
            lucide.createIcons();
        }, 2000);
    }
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

    } catch (e) {
        console.error("Metrics load err:", e);
    }
}

async function loadMissedDemand() {
    try {
        const res = await fetch(`${API_URL}/ranking`);
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
        list.innerHTML = '<div class="text-text-muted text-center pt-8">Sem dados disponíveis.</div>';
    }
}

async function loadTopProducts() {
    try {
        const res = await fetch(`${API_URL}/ranking`);
        const data = await res.json();
        const list = document.getElementById('top-products-list');

        if (!data || data.length === 0) {
            list.innerHTML = '<div class="text-xs text-text-muted text-center py-4">Sem dados de busca ainda.</div>';
            return;
        }

        // Take top 5 and calculate percentage relative to max
        const top5 = data.slice(0, 5);
        const maxCount = top5[0].searchCount || 1;

        list.innerHTML = top5.map((p, i) => {
            const pct = Math.round((p.searchCount / maxCount) * 100);

            setTimeout(() => {
                const bar = document.getElementById(`bar-${i}`);
                if (bar) bar.style.width = `${pct}%`;
            }, 300 + (i * 150));

            return `
            <div>
                <div class="flex justify-between text-[10px] mb-1 font-semibold text-text-muted">
                    <span class="truncate mr-2">${p.productName}</span>
                    <span class="whitespace-nowrap">${p.searchCount}x</span>
                </div>
                <div class="neo-progress-bar">
                    <div id="bar-${i}" class="neo-progress-fill" style="width: 0%"></div>
                </div>
            </div>
            `;
        }).join('');
    } catch (e) {
        console.error('Erro ao carregar top products:', e);
        const list = document.getElementById('top-products-list');
        list.innerHTML = '<div class="text-xs text-text-muted text-center py-4">Falha ao carregar dados.</div>';
    }
}

// Handoff Queue
function renderHandoffQueue(queue) {
    const list = document.getElementById('handoff-queue-list');
    const badge = document.getElementById('handoff-badge');

    if (!list) return;

    if (!queue || queue.length === 0) {
        list.innerHTML = '<div class="text-xs text-text-muted text-center py-4">Nenhum transbordo pendente.</div>';
        if (badge) {
            badge.textContent = '0 Aguardando';
            badge.classList.remove('animate-pulse');
        }
        lucide.createIcons();
        return;
    }

    if (badge) {
        badge.textContent = `${queue.length} Aguardando`;
        badge.classList.add('animate-pulse');
    }

    list.innerHTML = queue.map(h => {
        const phoneLast4 = h.phone.slice(-4);
        return `
        <div class="neo-inset p-3 bg-red-500/5 dark:bg-red-500/10 border-l-2 border-danger">
            <div class="flex justify-between items-center mb-2">
                <span class="font-bold text-sm">...${phoneLast4} <span class="text-[10px] font-normal text-text-muted">(${h.time})</span></span>
                <span class="text-[10px] font-bold text-danger uppercase opacity-80 border border-danger/50 px-1 rounded truncate max-w-[120px]">${h.reason}</span>
            </div>
            <button class="neo-btn w-full text-xs py-2 text-text-main hover:text-success transition-colors" onclick="resolveHandoff('${h.id}')">
                <i data-lucide="user-check" class="w-4 h-4"></i> Assumir Atendimento
            </button>
        </div>
        `;
    }).join('');

    lucide.createIcons();
}

async function loadHandoffQueue() {
    try {
        const res = await fetch(`${API_URL}/handoffs`);
        const data = await res.json();
        renderHandoffQueue(data);
    } catch (e) {
        console.error('Erro ao carregar handoff queue:', e);
    }
}

window.resolveHandoff = async function (id) {
    try {
        await fetch(`${API_URL}/handoffs/resolve`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id })
        });
    } catch (e) {
        console.error('Erro ao resolver handoff:', e);
    }
}

// Real-time handoff updates via socket
socket.on('handoff_update', (queue) => {
    renderHandoffQueue(queue);
});


function renderChart(ratings) {
    const ctx = document.getElementById('satisfactionChart').getContext('2d');
    let posCount = 0;
    let negCount = 0;
    let totalScore = 0;
    let totalVotes = 0;

    ratings.forEach(r => {
        if (r.score >= 4) {
            posCount++;
        } else if (r.score >= 1) {
            negCount++;
        }
        totalScore += r.score;
        totalVotes++;
    });

    const avg = totalVotes > 0 ? (totalScore / totalVotes).toFixed(1) : "0.0";
    document.getElementById('chart-center-avg').innerHTML = `<span class="text-2xl block">${avg}</span><span class="text-[10px] block text-text-muted leading-none">Media</span>`;

    if (window.myChart) window.myChart.destroy();

    const isDark = document.documentElement.classList.contains('dark');

    // Calculate Percentages for labels
    const posPct = totalVotes > 0 ? Math.round((posCount / totalVotes) * 100) : 0;
    const negPct = totalVotes > 0 ? Math.round((negCount / totalVotes) * 100) : 0;

    window.myChart = new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels: [`Feedback Positivo ${posPct}%`, `Feedback Negativo ${negPct}%`],
            datasets: [{
                data: [posCount, negCount],
                backgroundColor: ['#10b981', '#ef4444'],
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

// Store Exceptions (Calendário da Loja)
window.toggleSpecialHoursFields = function () {
    const selectedType = document.querySelector('input[name="exception-type"]:checked')?.value;
    const specialFields = document.getElementById('special-hours-fields');
    if (selectedType === 'horario_especial') {
        specialFields.classList.remove('hidden');
    } else {
        specialFields.classList.add('hidden');
    }
}

async function loadExceptions() {
    try {
        const res = await fetch(`${API_URL}/holidays`);
        const data = await res.json();
        const list = document.getElementById('exception-list');

        if (!Array.isArray(data) || data.length === 0) {
            list.innerHTML = '<div class="text-text-muted text-center py-2">Nenhuma exceção cadastrada.</div>';
            lucide.createIcons();
            return;
        }

        // Sort by date ascending
        data.sort((a, b) => a.date.localeCompare(b.date));

        list.innerHTML = data.map(ex => {
            const [y, m, d] = ex.date.split('-');
            const typeIcon = ex.type === 'horario_especial' ? '🕐' : '🔴';
            const reasonText = ex.reason || 'Sem motivo';

            let detailText = '';
            if (ex.type === 'horario_especial' && ex.specialHours) {
                detailText = `<span class="text-warning">${ex.specialHours.open} - ${ex.specialHours.close}</span>`;
            } else {
                detailText = `<span class="text-danger">Fechado</span>`;
            }

            return `<li class="flex justify-between items-center border-b border-glass-border pb-1">
                <div class="flex flex-col gap-0.5 min-w-0 flex-1 mr-2">
                    <span class="font-semibold truncate">${typeIcon} ${d}/${m}/${y} — ${reasonText}</span>
                    <span class="text-[10px]">${detailText}</span>
                </div>
                <button class="text-danger hover:text-red-400 flex-shrink-0" onclick="removeException('${ex.date}')"><i data-lucide="trash-2" class="w-3 h-3"></i></button>
            </li>`;
        }).join('');

        lucide.createIcons();
    } catch (e) {
        console.error("Erro ao carregar exceções:", e);
        const list = document.getElementById('exception-list');
        list.innerHTML = '<div class="text-danger text-center py-2">Falha ao carregar.</div>';
    }
}

window.addException = async function () {
    const date = document.getElementById('exception-date-input').value;
    const reason = document.getElementById('exception-reason-input').value.trim();
    const type = document.querySelector('input[name="exception-type"]:checked')?.value || 'fechado';

    if (!date) return alert('Selecione uma data.');
    if (!reason) return alert('Informe o motivo.');

    // Build the exception object
    const newException = { date, type, reason };

    if (type === 'horario_especial') {
        const openTime = document.getElementById('exception-open-input').value;
        const closeTime = document.getElementById('exception-close-input').value;
        if (!openTime || !closeTime) return alert('Preencha os horários.');
        newException.specialHours = { open: openTime, close: closeTime };
    } else {
        // Auto-calculate returnDate based on the next business day
        const exDate = new Date(date + 'T12:00:00');
        const nextDay = new Date(exDate);
        nextDay.setDate(nextDay.getDate() + 1);
        // Skip Sunday (0)
        while (nextDay.getDay() === 0) {
            nextDay.setDate(nextDay.getDate() + 1);
        }
        const dayNames = ['Domingo', 'Segunda-feira', 'Terça-feira', 'Quarta-feira', 'Quinta-feira', 'Sexta-feira', 'Sábado'];
        newException.returnDate = `${dayNames[nextDay.getDay()]} às 08:00`;
    }

    // Fetch current, add, and save
    try {
        const res = await fetch(`${API_URL}/holidays`);
        const data = await res.json();
        const existing = Array.isArray(data) ? data : [];

        // Prevent duplicate dates
        if (existing.some(ex => ex.date === date)) {
            return alert('Já existe uma exceção para essa data.');
        }

        existing.push(newException);
        await fetch(`${API_URL}/holidays`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(existing)
        });

        // Clear form
        document.getElementById('exception-date-input').value = '';
        document.getElementById('exception-reason-input').value = '';
        document.querySelector('input[name="exception-type"][value="fechado"]').checked = true;
        document.getElementById('special-hours-fields').classList.add('hidden');

        loadExceptions();
    } catch (e) {
        console.error("Erro ao adicionar exceção:", e);
        alert('Erro ao salvar. Tente novamente.');
    }
}

window.removeException = async function (date) {
    try {
        const res = await fetch(`${API_URL}/holidays`);
        const data = await res.json();
        const filtered = Array.isArray(data) ? data.filter(ex => ex.date !== date) : [];
        await fetch(`${API_URL}/holidays`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(filtered)
        });
        loadExceptions();
    } catch (e) {
        console.error("Erro ao remover exceção:", e);
    }
}


// Boot
loadMetrics();
loadExceptions();
loadTopProducts();
loadHandoffQueue();
setInterval(loadMetrics, 60000); // 1-minute ticker
setInterval(loadHandoffQueue, 30000); // 30-second handoff refresh
