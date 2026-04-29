require('dotenv').config();
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage, Browsers, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

const settings = require('./config/settings');
const stockService = require('./services/stockService');
const { searchProductInSheet, searchCategoryInSheet, getCachedSheetData, getCachedCategoryData, startAutoRefresh, forceRefreshCache } = require('./services/googleSheetsService');
const aiService = require('./services/aiService');
const metricsService = require('./services/metricsService');
const catalogService = require('./services/catalogService');
const googleSheetsService = require('./services/googleSheetsService'); // Injetado para boot caching
const server = require('./server/app');

const interactionTimeouts = new Map();
const INACTIVITY_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutos

// Sistema de fila de mensagens (Debouncing)
const userMessageQueues = new Map();
const userProcessingTimers = new Map();
const userIsProcessing = new Map(); // Trava de concorrência
const userPausedStates = new Map(); // Controle de Handoff/Pausa
const userSessions = new Map(); // Controle de Máquina de Estados (Triage, etc)
const DEBOUNCE_TIME_MS = 5000; // Tempo de espera para o usuário terminar de digitar
const mutedUsers = new Map(); // Sistema de Cooldown de 24h (Human Takeover)

let sock = null;
let initialized = false;



function getBrazilDateString() {
    // Retorna YYYY-MM-DD no fuso horário do Brasil
    return new Date().toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
}

function getBrazilTime() {
    // Cria um objeto Date onde getHours(), getDay() etc referem-se ao horário local do Brasil
    return new Date(new Date().toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }));
}

function normalizeJid(jid) {
    if (!jid) return '';
    let number = jid.split('@')[0].replace(/[^0-9]/g, '');
    // Se for Brasil (55) e tiver 13 dígitos (ex: 55 51 9 9999 9999)
    if (number.startsWith('55') && number.length === 13) {
        // Remove o 9º dígito (caractere no índice 4) -> 55 51 9999 9999
        number = number.slice(0, 4) + number.slice(5);
    }
    return number; // Retorna o número puro sem domínio para validações e logs
}

function isHoliday() {
    try {
        const exceptionsPath = path.join(__dirname, '../data/store_exceptions.json');
        if (!fs.existsSync(exceptionsPath)) return false;
        const exceptions = JSON.parse(fs.readFileSync(exceptionsPath, 'utf8'));
        const today = getBrazilDateString();
        const todayException = exceptions.find(ex => ex.date === today);
        // Considera feriado se a exceção for do tipo 'fechado' (ou sem tipo definido, para compatibilidade)
        return todayException && (!todayException.type || todayException.type === 'fechado');
    } catch (e) {
        return false;
    }
}

function isOpen() {
    const now = getBrazilTime();
    const day = now.getDay();
    const currentHour = now.getHours();
    const currentMinute = now.getMinutes();
    const currentTotal = currentHour * 60 + currentMinute;

    const todaySchedule = settings.workingHours[day];
    if (!todaySchedule || todaySchedule.length === 0) return false;

    return todaySchedule.some(range => {
        const [startH, startM] = range.start.split(':').map(Number);
        const [endH, endM] = range.end.split(':').map(Number);
        const startTotal = startH * 60 + startM;
        const endTotal = endH * 60 + endM;
        return currentTotal >= startTotal && currentTotal < endTotal;
    });
}

/**
 * Splits a text into multiple parts and sends them with a small delay.
 * Checks for [COD: xxx] locally in each part and sends an image if found.
 */
async function sendHumanLikeResponse(jid, text) {
    if (!text) return;

    // 1. Extrai TODOS os códigos da resposta inteira para checar se é "Vitrine Rica" (Múltiplos Itens)
    const regexCodGlobalTotal = /(?:\[|\{\{)\s*(?:COD|FOTO):\s*([\w-]+)\s*(?:\]|\}\})/gi;
    const allCodMatches = Array.from(text.matchAll(regexCodGlobalTotal));
    
    // Agora que temos Try/Catch robusto na imagem, o Dispatcher aguenta Vitrine Rica.
    const shouldAttachMedia = true;

    // Resolve as partes por parágrafo
    const parts = text.split(/(?:\r?\n)+/).filter(p => p.trim().length > 2);

    for (let i = 0; i < parts.length; i++) {
        let part = parts[i].trim();
        if (!part) continue;

        const regexCodGlobal = /(?:\[|\{\{)\s*(?:COD|FOTO):\s*([\w-]+)\s*(?:\]|\}\})/gi;
        const codMatches = Array.from(part.matchAll(regexCodGlobal));
        const extractedCodes = codMatches.map(m => m[1]);

        // Remove a tag do texto incondicionalmente para manter UI limpa
        part = part.replace(regexCodGlobal, '').trim();

        // Encontra o buffer da imagem
        let fileToSend = null;
        if (shouldAttachMedia && extractedCodes.length > 0) {
            const cod = extractedCodes[0];
            const pathsToCheck = [
                path.join(__dirname, `../data/fotos/${cod}.jpg`),
                path.join(__dirname, `../data/fotos/${cod}.png`),
                path.join(__dirname, `../data/fotos_sheets/${cod}.jpg`),
                path.join(__dirname, `../data/fotos_sheets/${cod}.png`),
                path.join(__dirname, `../assets/imagens_produtos/${cod}.jpg`),
                path.join(__dirname, `../assets/imagens_produtos/${cod}.png`)
            ];
            fileToSend = pathsToCheck.find(p => fs.existsSync(p));
        }

        try {
            let mediaSuccess = false;
            if (fileToSend) {
                try {
                    // Tenta o envio da imagem
                    await sock.sendMessage(jid, {
                        image: { url: fileToSend },
                        caption: part.length > 0 ? part : undefined
                    });
                    mediaSuccess = true; // Se não lançou erro, sucesso!
                } catch (mediaError) {
                    console.error(`[Mídia Dispatcher] Falha ao enviar foto ${fileToSend}, fazendo fallback de texto:`, mediaError.message);
                    mediaSuccess = false; // Força o fallback text-only
                }
            }
            
            // Fallback Text-Only: Foto não existe ou ocorreu erro no upload dela (Graceful Degradation)
            if(!mediaSuccess) {
                if (part.length > 0) {
                    await sock.sendMessage(jid, { text: part });
                }
            }

            // Pausa sutil (700ms a 1000ms) para evitar inversão na UI do cliente
            await new Promise(resolve => setTimeout(resolve, 800));
        } catch (error) {
            console.error(`Erro GERAL ao enviar bolha (Index ${i}):`, error);
            // Último nível absoluto de fallback
            try { 
                if (part.length > 0) await sock.sendMessage(jid, { text: part }); 
            } catch(e) {}
        }
    }
}

let isDeliberateClose = false;

async function setupEvents() {
    sock.ev.on('creds.update', (...args) => {
        // Credenciais são atualizadas automaticamente pelo start
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log('QR RECEIVED (Verifique no Dashboard)');
            qrcode.generate(qr, { small: true });
            server.emitEvent('qr', qr);
        }

        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut && !isDeliberateClose;
            console.log('connection closed due to ', lastDisconnect?.error, ', reconnecting ', shouldReconnect);
            initialized = false;
            server.emitEvent('ready', false);

            if (shouldReconnect) {
                initialize();
            }
        } else if (connection === 'open') {
            console.log('Client is ready!');
            isDeliberateClose = false;
            initialized = true;
            server.emitEvent('ready', true);
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        if (m.type !== 'notify') return; // Ignora mensagens vindas de histórico/sincronização

        const msg = m.messages[0];

        // 0. Trava de descarte imediato (Ignorar Broadcast/Status)
        if (msg.key?.remoteJid === 'status@broadcast') return;

        // --- GLOBAL DASHBOARD STATE CONTROLS ---
        if (!server.isBotEnabled()) {
            return; // Bot completamente desligado (Early Return Global)
        }

        // Ensure text extraction from Baileys structure
        let textContent = msg.message?.conversation ||
            msg.message?.extendedTextMessage?.text ||
            msg.message?.imageMessage?.caption ||
            '';

        const rawJid = msg.key?.remoteJid;
        if (!rawJid) return;
        
        // --- 24h COOLDOWN SYSTEM (HUMAN TAKEOVER) ---
        if (msg.key.fromMe) {
            // Ignora mensagens geradas pelo próprio bot (sock.sendMessage)
            // Apenas intervenção humana real (digitada no celular/web) deve mutar
            const myMsg = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
            const botFingerprints = [
                'Há algo mais em que eu possa te ajudar?',
                'engasgada', 'instabilidade', '♻️ Sessão reiniciada',
                '✅ Bot reativado', '🔄 Baixando dados', '⚠️ [Modo Teste]',
                'Vou repassar', 'pessoal do balcão', '{{COD:'
            ];
            const isBotGenerated = botFingerprints.some(fp => myMsg.includes(fp));
            
            if (!isBotGenerated && myMsg.trim().length > 0) {
                const expireTime = Date.now() + 86400000; // 24 horas em ms
                mutedUsers.set(rawJid, expireTime);
                console.log(`[Human Takeover] Intervenção humana detectada em ${rawJid}. Bot mutado por 24 horas.`);
            } else {
                console.log(`[Human Takeover] Mensagem própria do bot ignorada (fromMe) para ${rawJid}.`);
            }
            return;
        } else {
            // Se o usuário mandou mensagem, checa se ele está mutado
            if (mutedUsers.has(rawJid)) {
                if (Date.now() < mutedUsers.get(rawJid)) {
                    return; // Early Return silencioso
                } else {
                    mutedUsers.delete(rawJid); // Expirou, tira do castigo
                }
            }
        }

        const quotedObj = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
        if (quotedObj) {
            const quotedText = quotedObj.conversation || quotedObj.extendedTextMessage?.text || quotedObj.imageMessage?.caption || '';
            if (quotedText && textContent) {
                 textContent = `${textContent} [Respondendo a: ${quotedText}]`;
                 console.log(`[Parser] Mensagem Citada Injetada no Contexto: "${textContent}"`);
            }
        }

        // 1. Extração Simples do ID
        const cleanId = rawJid.split('@')[0];

        // 2. Log Universal (Visibilidade Total)
        const pushname = msg.pushName || 'Desconhecido';
        console.log(`Recebido de ${pushname} (${cleanId}): ${textContent}`);

        // Edge Case 1: Filtro de Deleção/ProtocolMessage para evitar Crash
        if (msg.message?.protocolMessage || msg.message?.senderKeyDistributionMessage) return;

        if (rawJid.includes('@g.us') || rawJid === 'status@broadcast') return;

        // O Baileys precisa do JID original (@lid ou @s.whatsapp.net) para conseguir responder a mensagem
        const jid = rawJid;

        // 3. Filtro Flexível do Modo Teste
        const allowedNumbers = server.getAllowedNumbers();
        const isAdmin = allowedNumbers.some(num => cleanId.includes(num) || String(num).includes(cleanId));

        if (server.isTestMode()) {
            if (!isAdmin) {
                // 4. Descarte Silencioso (Admin Only Mode Ativo)
                return;
            }
        }

        // Renomeia cleanId para headers para manter compatibilidade com o resto do código
        const headers = cleanId;

        // 0.3 Global Override for "Reiniciar"
        const lowerText = textContent.trim().toLowerCase();
        if (isAdmin && (lowerText === 'reiniciar' || lowerText === 'restart')) {
            console.log(`[Global Override] Comando Reiniciar detectado por ${headers}. Limpando estados...`);
            userSessions.delete(jid);
            userPausedStates.delete(jid);
            userIsProcessing.delete(jid);

            if (userMessageQueues.has(jid)) userMessageQueues.delete(jid);
            if (userProcessingTimers.has(jid)) clearTimeout(userProcessingTimers.get(jid));
            if (interactionTimeouts.has(jid)) {
                clearTimeout(interactionTimeouts.get(jid));
                interactionTimeouts.delete(jid);
            }

            await prisma.chatHistory.deleteMany({ where: { phoneNumber: headers } });
            await sock.sendMessage(jid, { text: "♻️ Sessão reiniciada com sucesso. Memória e estados da Máquina foram apagados." });
            return;
        }

        // Edge Case 8: Tratamento do 'fromMe' (Atendente Web / Human Takeover)
        if (msg.key.fromMe) {
            const myMsg = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
            if (myMsg.trim() === '!bot') {
                userPausedStates.delete(jid);
                console.log(`[Manual Override] Atendente soltou a trava (!bot) para ${headers}`);
                await sock.sendMessage(jid, { text: "✅ Bot reativado para este chat." });
            } else {
                userPausedStates.set(jid, Date.now());
                console.log(`[Human Takeover] Atendente assumiu manualmente pelo aparelho. Bot mutado para o cliente ${headers}`);
            }
            return;
        }

        // Clear existing timeout if the user sends a new message
        if (interactionTimeouts.has(jid)) {
            clearTimeout(interactionTimeouts.get(jid));
            interactionTimeouts.delete(jid);
        }

        // Edge Case 2 & 9: Middleware de Pausa (Handoff) com Inatividade TTL 6H
        if (userPausedStates.has(jid)) {
            const pausedTimestamp = userPausedStates.get(jid);
            const nowTime = Date.now();
            // Permanece mudo por 6 horas (6 * 60 * 60 * 1000)
            if (nowTime - pausedTimestamp > 21600000) {
                userPausedStates.delete(jid);
                console.log(`[Handoff Mute] TTL 6h Vencido. Travas liberadas para ${headers}`);
            } else {
                console.log(`[Handoff Mute] Ignorando mensagem de ${pushname} (${headers})`);
                return; // Ignora completamente para o humano assumir
            }
        }

        // 0.2 Check Power & Test Mode
        if (!server.isBotEnabled()) {
            console.log("Bot desligado. Ignorando.");
            return;
        }

        // 0.3.5 Global Override for "Atualizar Estoque"
        if (isAdmin && (lowerText === 'atualizar estoque' || lowerText === 'update stock')) {
            console.log(`[Global Override] Comando Atualizar Estoque detectado por ${headers}. Fazendo download manual...`);
            await sock.sendMessage(jid, { text: "🔄 Baixando dados mais recentes da planilha em tempo real... Aguarde." });
            try {
                const regs = await forceRefreshCache();
                await sock.sendMessage(jid, { text: `✅ Cache atualizado com sucesso!\n\nEstoque Principal: ${regs.principal} itens.\nCategorias: ${regs.categoria} intenções.` });
            } catch (err) {
                await sock.sendMessage(jid, { text: `❌ Falha ao atualizar a planilha: ${err.message}` });
            }
            return;
        }

        // O bloco manual de "State Machine: AWAITING_TRIAGE_ANSWER" foi completamente apagado em favor do Controle Delegado ao LLM.

        console.log(`Recebido de ${pushname} (${headers}): ${textContent} (Aguardando debounce...)`);
        metricsService.incrementMessages();

        // Edge Case 7: Rate Limiting Básico (Max 6 seguidos)
        const nowTimeLimit = Date.now();
        if (!userSessions.has(jid)) userSessions.set(jid, { state: 'IDLE', msgCount: 0, lastMsgTime: nowTimeLimit });

        const sessionObj = userSessions.get(jid);
        if (nowTimeLimit - sessionObj.lastMsgTime < 10000) {
            sessionObj.msgCount++;
        } else {
            sessionObj.msgCount = 1; // Reseta se passou de 10 seg
        }
        sessionObj.lastMsgTime = nowTimeLimit;

        if (sessionObj.msgCount > 6) {
            if (sessionObj.msgCount === 7) {
                await sock.sendMessage(jid, { text: "Opa, recebi muitas mensagens de uma vez! Por favor, aguarde alguns segundos para eu conseguir processar tudo. 🔄" });
            }
            return; // Bloqueio silencioso se continuar floodando
        }

        // Limpa o timer anterior do usuário, se houver, pois ele digitou de novo.
        if (userProcessingTimers.has(jid)) {
            clearTimeout(userProcessingTimers.get(jid));
        }

        // Morte ao Zombie Follow-up: Zera contador de inatividade ao receber input novo
        if (interactionTimeouts.has(jid)) {
            clearTimeout(interactionTimeouts.get(jid));
            interactionTimeouts.delete(jid);
        }

        // 0. Initialize Variables (Moved up for queuing)
        let mediaData = null;

        // 0.1 Process Media
        const messageType = Object.keys(msg.message)[0];

        // 0.2 Interceptador de Stickers (Figurinhas) -> Ignora silenciosamente
        if (messageType === 'stickerMessage') {
            console.log(`[Media Interceptor] Figurinha recebida de ${headers} ignorada silenciosamente.`);
            return; // Aborta fluxo sem mandar nada, não enche linguiça.
        }

        // 0.3 Interceptador de Documentos/PDFs -> Força o Transbordo Humano IMEDIATO
        if (messageType === 'documentMessage') {
            console.log(`[Media Interceptor] Documento/PDF recebido de ${headers}. Forçando Handoff.`);

            await sock.sendPresenceUpdate('composing', jid);
            await new Promise(resolve => setTimeout(resolve, 800));

            let docMsg = "Vou repassar o seu documento para um atendente humano analisar, só um segundo.";
            await sock.sendMessage(jid, { text: docMsg });
            await prisma.chatHistory.create({ data: { phoneNumber: headers, role: 'model', content: docMsg } });

            userPausedStates.set(jid, Date.now());
            metricsService.incrementHandoff();
            if (server.addHandoff) server.addHandoff({ phone: headers, reason: "Análise de Documento" });
            return; // Aborta fluxo e impede travamento no LLM
        }

        if (messageType === 'imageMessage' || messageType === 'audioMessage' || messageType === 'pttMessage') {
            try {
                const buffer = await downloadMediaMessage(
                    msg,
                    'buffer',
                    {},
                    {
                        logger: pino({ level: 'silent' }),
                        reuploadRequest: sock.updateMediaMessage
                    }
                );

                if (buffer) {
                    if (messageType === 'imageMessage') {
                        mediaData = { mimeType: msg.message.imageMessage.mimetype, data: buffer.toString('base64') };
                    } else if (messageType === 'audioMessage' || messageType === 'pttMessage') {
                        const audioMime = msg.message[messageType].mimetype;
                        mediaData = { mimeType: audioMime.split(';')[0], data: buffer.toString('base64') };
                    }
                }
            } catch (e) {
                console.error("Erro ao baixar mídia:", e);
            }
        }

        // Checks already handled above

        // 3. Queue the message block
        if (!userMessageQueues.has(jid)) {
            userMessageQueues.set(jid, []);
            // Ativa o estado "digitando..." assim que a primeira mensagem chega na fila
            try {
                await sock.sendPresenceUpdate('composing', jid);
            } catch (e) {
                console.error("Erro ao enviar composing state:", e);
            }
        }

        // Edge Case 3: Safe-Merge Ignore Trash (menos de 2 caracteres puro e não-numérico)
        const strClean = textContent.trim();
        if (!mediaData && strClean.length < 2 && !/^\d+$/.test(strClean)) {
            console.log(`[Safe-Merge] Mensagem curta/símbolo de ${headers} ignorada no buffer: "${strClean}"`);
            return;
        }

        userMessageQueues.get(jid).push({
            text: textContent,
            media: mediaData,
            isAdminOverride: isAdmin && (textContent.trim().toLowerCase() === 'reiniciar' || textContent.trim().toLowerCase() === 'atualizar estoque')
        });

        // 4. Start Debounce Timer
        const processQueue = async () => {
            console.log(`[Debounce Acionado] Iniciando roteamento para o JID: ${jid}`);
            userProcessingTimers.delete(jid);

            // Early Return de Fila (Economia de Recursos API)
            // Impede consultas ao DB e chamadas ao LLM se o humano assumiu e havia mensagens remanescentes na fila de debounce.
            if (userPausedStates.has(jid)) {
                console.log(`[Muted] Chat em intervenção humana. Ignorando mensagem na fila.`);
                userMessageQueues.delete(jid);
                return;
            }

            // Se já estivermos processando algo proscrito pela fila anterior (AI demorando)
            // mantemos as mensagens na fila para o próximo ciclo
            if (userIsProcessing.get(jid)) {
                console.log(`[Debounce] Usuário ${headers} já está processando. Mensagem mantida na fila.`);
                return;
            }

            const queue = userMessageQueues.get(jid);
            if (!queue || queue.length === 0) return;

            userIsProcessing.set(jid, true); // Trava!

            try {
                // Extract context and combine texts
                // We'll use the last media provided (or merge them if your AI supports multiple, but usually one is enough per burst)
                let combinedText = '';
                let imageParts = [];
                let audioParts = [];

                for (const msgData of queue) {
                    if (msgData.text) combinedText += msgData.text + "\n";
                    if (msgData.media) {
                        if (msgData.media.mimeType.startsWith('image/')) {
                            imageParts.push({ inlineData: { data: msgData.media.data, mimeType: msgData.media.mimeType } });
                        } else if (msgData.media.mimeType.startsWith('audio/')) {
                            audioParts.push({ inlineData: { data: msgData.media.data, mimeType: 'audio/ogg' } });
                        }
                    }
                }

                // Clear the queue for this user
                userMessageQueues.delete(jid);

                // Buscar ultimas mensagens do DB (30 mais recentes, ordem cronológica)
                const historyRecords = await prisma.chatHistory.findMany({
                    where: { phoneNumber: headers },
                    orderBy: { createdAt: 'desc' },
                    take: 30
                });
                historyRecords.reverse(); // Volta para ordem cronológica (mais antigo → mais recente)

                // Amnésia de 36 horas (Time-To-Live)
                const ttlLimit = Date.now() - (36 * 60 * 60 * 1000);
                const recentRecords = historyRecords.filter(r => new Date(r.createdAt).getTime() > ttlLimit);

                // --- SISTEMA DE MEMÓRIA DO DIA (GREETINGS) ---
                const nowSP = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }));
                nowSP.setHours(0, 0, 0, 0); // 00:00:00 de hoje no fuso SP
                const startOfTodayMs = nowSP.getTime();

                const historyOfToday = recentRecords.filter(r => new Date(r.createdAt).getTime() >= startOfTodayMs);
                const hasStoreRepliedToday = historyOfToday.some(r => r.role === 'model' || r.fromMe === true);

                let dailyGreetingContext = "";
                if (!hasStoreRepliedToday) {
                    dailyGreetingContext = "[CONTEXTO: Esta é a primeira interação do dia. Inicie com UMA ÚNICA saudação curta (Bom dia/Boa tarde/Boa noite) conforme o relógio do sistema e ofereça ajuda, tudo em UMA SÓ FRASE. É ESTRITAMENTE PROIBIDO criar dois parágrafos de saudação ou cumprimentar duas vezes na mesma resposta.]";
                } else {
                    dailyGreetingContext = "[CONTEXTO: O atendimento de hoje já iniciou. PROIBIDO repetir saudações iniciais. Continue a conversa de onde parou de forma direta e prestativa.]";
                }

                // Otimização de Janela de Contexto (Rolling Window)
                // Limita a 12 interações parciais para não estourar o limite de tokens do LLM.
                let chatsHistory = recentRecords.map(r => ({ role: r.role, content: r.content }));
                
                // Injeta a mensagem ATUAL do usuário no histórico em memória
                // (ela só será salva no DB após processamento bem-sucedido, mais abaixo)
                chatsHistory.push({ role: 'user', content: combinedText.trim() });
                
                while (chatsHistory.length > 20) {
                    chatsHistory.shift();
                }

                // Verifica se tem comandos globais no lote
                if (queue.some(q => q.isAdminOverride)) {
                    console.log(`[Safe-Merge] Comando Admin interceptado no lote de ${headers}, abortando roteamento AI...`);
                    return;
                }

                // Inteligência Artificial: Query Expansion
                // Transforma a intenção em um array rico de sinônimos técnicos
                let searchKeywords = combinedText;
                let recentHistory = [];

                if (recentRecords.length > 0) {
                    recentHistory = recentRecords.slice(-10).map(r => ({ role: r.role, content: r.content }));
                }

                if (imageParts.length > 0) {
                    await sock.sendPresenceUpdate('composing', jid);
                    searchKeywords = await aiService.extractImageKeywords(imageParts, searchKeywords);
                }

                await sock.sendPresenceUpdate('composing', jid); // Status "digitando..."

                // Pivot 2: Roteamento de Intenção (Removido)
                // O fluxo unificado vai direto para a Busca
                let categoryMatch = null;
                let stockContext = [];
                let finalVisualKeyword = null;

                let expandedQueryArray = await aiService.expandSearchQuery(searchKeywords, recentHistory);

                // --- SHIELD ANTI-FORNECEDOR ---
                if (expandedQueryArray && expandedQueryArray.includes("INTENCAO_FORNECEDOR")) {
                    console.log(`[Shield Fornecedor] Representante comercial detectado em ${jid}. Ignorando IA e mutando por 24h.`);
                    await sock.sendPresenceUpdate('composing', jid);
                    await new Promise(resolve => setTimeout(resolve, 1500));
                    await sock.sendMessage(jid, { text: "Olá! Sou o assistente virtual da loja. Nossa equipe está focada no balcão agora, mas deixarei seu material registrado. Muito obrigado!" });
                    
                    // Muta por 24h instantaneamente
                    mutedUsers.set(jid, Date.now() + 86400000);
                    userIsProcessing.delete(jid);
                    return;
                }

                    // Se o expandSearchQuery retornou [] (saudação/sem intenção de produto), pula a busca no estoque
                    // e vai direto pra IA com contexto vazio, deixando ela responder naturalmente.
                    let cleanSearchTermsArray = expandedQueryArray.length > 0 ? expandedQueryArray : [];
                    cleanSearchTermsArray = cleanSearchTermsArray.map(t => t.replace(/\n/g, ' ').trim()).filter(t => t.length > 0);

                    console.log(`[Unified Search] Avaliando Busca Simultânea para: [${cleanSearchTermsArray.join(', ')}]`);

                    let principalMatches = [];
                    let geralMatches = [];
                    if (cleanSearchTermsArray.length > 0) {
                        principalMatches = await stockService.searchProduct(cleanSearchTermsArray);
                        geralMatches = await stockService.searchCategory(cleanSearchTermsArray);
                    } else {
                        console.log(`[Unified Search] Array de termos vazio (saudação/conversa). Pulando busca no estoque.`);
                    }

                    let combinedContext = [];
                    if (principalMatches && principalMatches.length > 0) combinedContext.push(...principalMatches);
                    if (geralMatches && geralMatches.length > 0) combinedContext.push(...geralMatches);

                    const seenMap = new Set();
                    stockContext = [];
                    for (let item of combinedContext) {
                        const realItem = item.item || item;
                        // Extrai a chave única para desduplicar entre as duas tabelas
                        const uniqueKey = realItem['código'] || realItem['codigo'] || realItem['ean'] || realItem['modelo/produto'] || realItem['categoria_geral'];

                        if (uniqueKey && !seenMap.has(uniqueKey)) {
                            seenMap.add(uniqueKey);
                            stockContext.push(realItem);
                        }
                    }

                    stockContext = stockContext.slice(0, 15);
                    console.log(`[Unified Search] Otimizado: ${stockContext.length} itens combinados enviados à IA.`);

                    // Feature 8: Visual Verification com Gabarito (Oracle Master)
                    if (imageParts.length > 0 && stockContext && stockContext.length > 0) {
                        console.log("[Semantic Pre-Ranking] Refinando opções da busca inicial...");
                        const refinedStock = await aiService.semanticPreRanking(searchKeywords, stockContext.slice(0, 15));

                        console.log("[Verificação Visual] Buscando gabaritos no HD...");
                        const candidatesLocal = [];
                        const itemsToCheck = refinedStock.slice(0, 8); // Aumento da Amostragem Visual do Oraculo de 5 para 8

                        for (const cand of itemsToCheck) {
                            const productData = cand.item || cand;
                            const code = productData['código'] || productData['codigo'] || productData.Codigo;
                            const name = productData['modelo/produto'] || productData.Produto;

                            if (code && name) {
                                // Tenta carregar a imagem do disco
                                const imagePathJpg = path.join(__dirname, `../data/fotos_sheets/${code}.jpg`);
                                const imagePathPng = path.join(__dirname, `../data/fotos_sheets/${code}.png`);

                                let localImagePath = null;
                                if (fs.existsSync(imagePathJpg)) localImagePath = imagePathJpg;
                                else if (fs.existsSync(imagePathPng)) localImagePath = imagePathPng;

                                if (localImagePath) {
                                    const fileBuffer = fs.readFileSync(localImagePath);
                                    candidatesLocal.push({
                                        code: code.toString(),
                                        name: name.toString(),
                                        localImageBase64: fileBuffer.toString('base64')
                                    });
                                }
                            }
                        }

                        if (candidatesLocal.length > 0) {
                            // Dedo-duro do Oracle para acompanhamento de log/avaliação
                            const nomesGabaritos = candidatesLocal.map((c, i) => `${i + 1}. ${c.name} (${c.code})`).join(", ");
                            console.log(`[Verificação Visual] Avaliando gabaritos: ${nomesGabaritos}`);

                            await sock.sendPresenceUpdate('composing', jid); // Status "digitando..."
                            console.log(`[Verificação Visual] Oráculo acionado com ${candidatesLocal.length} gabaritos disponíveis.`);

                            // Log explícito do Payload para Auditoria
                            console.log('[Oráculo Payload] Montado:', JSON.stringify(candidatesLocal.map(c => ({ code: c.code, name: c.name, hasImage: !!c.localImageBase64 })), null, 2));

                            const visualConfirm = await aiService.verifyProductImageWithCatalog(imageParts[0].inlineData, combinedText, candidatesLocal);

                            if (visualConfirm) {
                                console.log(`[Verificação Visual] Sucesso! Código do Hospedeiro: "${visualConfirm}"`);

                                // Bug Fix: O Paradoxo do Acessório (Fluxo de 2 Passos)
                                // Se o usuário digitou palavras de peça nas legendas/histórico, redireciona a busca
                                const isComponentQuery = /resistência|resistencia|reparo|refil|cartucho|peça|peca/i.test(combinedText);

                                if (isComponentQuery) {
                                    // 1. Busca o nome do Hospedeiro (ex: Ducha Acqua Duo)
                                    const hostProductData = await stockService.searchProduct([visualConfirm]);
                                    let hostName = "Chuveiro/Torneira"; // Fallback

                                    if (hostProductData && hostProductData.length > 0) {
                                        const exactHost = hostProductData.find(p => {
                                            const code = (p.item || p)['código'] || (p.item || p)['codigo'] || (p.item || p).Codigo;
                                            return code && code.toString() === visualConfirm.toString();
                                        });
                                        if (exactHost) {
                                            hostName = (exactHost.item || exactHost)['modelo/produto'] || (exactHost.item || exactHost).Produto;
                                        }
                                    }

                                    // 2. Monta a nova string e busca a Peça referenciando o Hospedeiro
                                    const componentQuery = `Resistência Reparo ${hostName}`;
                                    console.log(`[Verificação Visual] Intenção de Peça detectada. Redirecionando busca para: "${componentQuery}"`);
                                    stockContext = await stockService.searchProduct([componentQuery]);
                                    finalVisualKeyword = componentQuery;

                                } else {
                                    // Fluxo Padrão: Busca exatamente o EAN visualizado
                                    stockContext = await stockService.searchProduct([visualConfirm]);
                                    finalVisualKeyword = visualConfirm;
                                }

                            } else {
                                console.log(`[Verificação Visual] Oráculo retornou NENHUM. Permitindo Fallback para a Busca Textual (Unified Search) prosseguir para buscar o termo genérico visual.`);
                                // Não força early return, permitindo que a IA Final julgue o stockContext da frase/imagem.
                            }
                        } else {
                            console.log("[Verificação Visual] Nenhuma foto de gabarito encontrada no HD para os top candidatos.");
                        }
                    }

                // O Fluxo Definitivo de Triagem e Handoff (Delegação para o LLM)
                // O Passo B hardcoded (State Machine) foi removido em favor da inteligência de contexto livre do LLM.
                
                // Passo A: IA Conversacional Normal (Há resultados no Estoque ou Categorias)
                // Se chegou até aqui, stockContext tem > 0 itens OU é intent FAQ. A IA Final entra em cena.

                await sock.sendPresenceUpdate('composing', jid); // Status "digitando..."

                const onWait = async (waitTime) => {
                    if (server.isTestMode() && isAdmin) {
                        const seconds = Math.ceil(waitTime / 1000);
                        await sock.sendMessage(jid, { text: `⚠️ [Modo Teste] API sobrecarregada. Aguardando ${seconds} segundos para tentar responder...` });
                    }
                };

                // Override searchKeywords se o Oráculo Matador visual identificou
                const finalPromptInput = finalVisualKeyword || combinedText.trim();
                console.log(`[Gerando Resposta] Intent Final: ${finalPromptInput} | Itens no Contexto: ${stockContext ? stockContext.length : 0}`);

                let offHoursContext = null;
                if (!isOpen()) {
                    const sessionParams = userSessions.get(jid) || { state: 'DEFAULT' };
                    if (!sessionParams.hasNotifiedOffHours) {
                        offHoursContext = "AVISO OBRIGATÓRIO: A loja física está fechada no momento. Informe isso educadamente e diga que você está de plantão virtual. PLANTÃO VIRTUAL: Na PRIMEIRA vez que avisar que a loja física está fechada, adicione uma frase proativa garantindo que você (o assistente virtual) está disponível AGORA para checar estoques, consultar preços e listar opções, adiantando o atendimento para quando a loja abrir.";
                        sessionParams.hasNotifiedOffHours = true;
                        userSessions.set(jid, sessionParams);
                    } else {
                        offHoursContext = "AVISO DE CONTEXTO: A loja está fechada, mas VOCÊ JÁ AVISOU o cliente sobre isso nas mensagens anteriores. É ESTRITAMENTE PROIBIDO repetir que a loja está fechada, pedir para aguardar ou mencionar horários. Aja naturalmente e foque 100% em responder sobre o produto.";
                    }
                }

                let response;
                try {
                    response = await aiService.generateResponse(finalPromptInput, imageParts, audioParts, chatsHistory, stockContext, onWait, offHoursContext, dailyGreetingContext);
                } catch (apiError) {
                    console.error("🚨 [ERRO FATAL API] Falha ou Timeout na geração da resposta FINAL pelo LLM:", apiError);

                    // Resiliência da API e Tratamento de Erro Fatal (Timeout Fallback)
                    const fallbackPardonMsg = "Meu sistema de busca deu uma engasgada técnica aqui! Já vou repassar sua mensagem para um de nossos atendentes te ajudar, só um segundo.";
                    await sock.sendMessage(jid, { text: fallbackPardonMsg });
                    await prisma.chatHistory.create({ data: { phoneNumber: headers, role: 'model', content: fallbackPardonMsg } });

                    userPausedStates.set(jid, getBrazilDateString());
                    metricsService.incrementHandoff();
                    if (server.addHandoff) server.addHandoff({ phone: headers, reason: "Falha/Timeout API" });

                    if (userMessageQueues.has(jid)) userMessageQueues.delete(jid);
                    return; // Aborta fluxo normal
                }

                // INTERCEPÇÃO PÓS-PROCESSAMENTO:
                // Se o cliente mandou mais alguma coisa ENQUANTO o bot estava pensando,
                // a fila terá reaparecido. Nós devemos descartar essa resposta, colocar a mensagem original 
                // devolta na fila (junto com a nova) e abortar. O timer que a segunda mensagem criou 
                // vai rodar em breve e pegar tudo junto!
                if (userMessageQueues.has(jid)) {
                    console.log(`[Debounce - Abortando Reação] Cliente enviou mensagem enquanto a IA gerava a resposta. Cancelando envio e re-escalonando fila consolidada.`);

                    // Coloca de volta na fila original (junto com a mensagem nova) os itens que processamos
                    userMessageQueues.get(jid).unshift(...queue);

                    // Aborta! O botNão escreve no banco, não manda pro WhatsApp.
                    return;
                }

                // --------- SE CHEGOU AQUI, É SEGURO RESPONDER ---------

                // DB History: Salvar a mensagem "juntada" do usuário AGORA, já que processamos com sucesso
                await prisma.chatHistory.create({
                    data: { phoneNumber: headers, role: 'user', content: combinedText.trim() }
                });

                // Clean response text
                let fullText = response.text;

                // 2. Interceptação e Hardcode de Falhas (Fim das Frases Robóticas)
                if (fullText.includes("[JSON_HANDOFF]")) {
                    const fallbackPhrases = [
                        "Vou pedir pro pessoal do balcão dar uma olhada na prateleira se temos esse exato, só um segundo!",
                        "Deixa eu repassar pra um dos atendentes verificar aqui na loja pra você, rapidinho.",
                        "Vou dar uma confirmada com o pessoal aqui do balcão pra ver as opções que temos, te chamo já já!"
                    ];
                    fullText = fallbackPhrases[Math.floor(Math.random() * fallbackPhrases.length)];
                }

                // Check for Location Action
                const locationMatch = fullText.match(/\[ACTION:\s*SEND_LOCATION\]/i);
                if (locationMatch) {
                    fullText = fullText.replace(locationMatch[0], '').trim();
                }

                // Feature 1: Check for VIP Group Action
                const vipMatch = fullText.match(/\[ACTION:\s*VIP_GROUP\]/i);
                if (vipMatch) {
                    fullText = fullText.replace(vipMatch[0], '').trim();
                    // Append the CTA directly to the text so sendHumanLikeResponse breaks it into bubbles
                    fullText += "\n\nMas faz o seguinte: entra no nosso Grupo do WhatsApp. Lá a gente avisa em primeira mão tudo que chega na loja 👇\n\nhttps://chat.whatsapp.com/DkgAIvvM3NN9Y1zrEkZBGQ";

                    // Feature 4: Salvar Demanda Reprimida no Banco (SQLite)
                    // Usamos a última intenção extraída pelo Fuse/IA como o nome do produto
                    const intendedProduct = expandedQueryArray.length > 0 ? expandedQueryArray[0] : combinedText.trim();
                    if (intendedProduct.length > 2) {
                        try {
                            // Limite string para evitar sujeira muito grande no banco
                            const safeProductName = intendedProduct.substring(0, 100).toLowerCase();
                            await prisma.missedDemand.upsert({
                                where: { productName: safeProductName },
                                update: {
                                    searchCount: { increment: 1 },
                                    lastRequestedAt: new Date()
                                },
                                create: {
                                    productName: safeProductName,
                                    searchCount: 1
                                }
                            });
                            console.log(`[API Feature 4] Demanda registrada para: "${safeProductName}"`);
                        } catch (err) {
                            console.error("[API Feature 4] Erro ao salvar MissedDemand:", err);
                        }
                    }
                }

                // DB History: Salvar resposta da IA
                await prisma.chatHistory.create({
                    data: { phoneNumber: headers, role: 'model', content: fullText }
                });

                // Send in multiple bubbles, auto-detecting multiple [COD: xxx] locally
                await sendHumanLikeResponse(jid, fullText);

                // A.1) Send Location
                if (locationMatch) {
                    try {
                        await sock.sendMessage(jid, {
                            location: {
                                degreesLatitude: -29.572710910948512,
                                degreesLongitude: -50.79102198858497,
                                name: 'Ferragem Marlene',
                                address: 'Rua Osvaldo Cruz, 417, Centro, Igrejinha'
                            }
                        });
                    } catch (e) {
                        console.error("Erro ao enviar a localização", e);
                    }
                }

                // B) Human Handoff (Bloqueia repasse imediato se foi detectada a Triagem de Categorias Gerais)
                let isTriageActive = false; // Add variable definition here to prevent scope issues
                if (response.needsHandoff && !isTriageActive) {
                    if (interactionTimeouts.has(jid)) {
                        clearTimeout(interactionTimeouts.get(jid));
                        interactionTimeouts.delete(jid);
                    }
                    userPausedStates.set(jid, getBrazilDateString());
                    metricsService.incrementHandoff();
                    if (server.addHandoff) server.addHandoff({ phone: headers, reason: "Transbordo AI" });
                    return; // Encerra o fluxo aqui para não iniciar timer de inatividade
                }

                // E) Set Inactivity Follow-up
                const isConversationEnd = combinedText.toLowerCase().includes('obrigado') ||
                    combinedText.toLowerCase().includes('valeu') || combinedText.toLowerCase().includes('tchau');

                if (isConversationEnd) {
                    // Morte ao Zombie Follow-up: Limpa o timer rigidamente em conversas finalizadas organicamente
                    if (interactionTimeouts.has(jid)) {
                        clearTimeout(interactionTimeouts.get(jid));
                        interactionTimeouts.delete(jid);
                    }
                } else {
                    // Check if we literally just asked this a few minutes ago.
                    const recentBotMsgs = await prisma.chatHistory.findMany({
                        where: { phoneNumber: headers, role: 'model' },
                        orderBy: { createdAt: 'desc' },
                        take: 5
                    });

                    const alreadyAskedFollowUp = recentBotMsgs.some(m => m.content.includes("Há algo mais em que eu possa te ajudar?"));

                    if (!alreadyAskedFollowUp) {
                        const timeoutId = setTimeout(async () => {
                            if (!sock) return;
                            try {
                                await sock.sendMessage(jid, { text: "Há algo mais em que eu possa te ajudar?" });

                                // Opcional: salvar no DB para contar também
                                await prisma.chatHistory.create({
                                    data: { phoneNumber: headers, role: 'model', content: "Há algo mais em que eu possa te ajudar?" }
                                });
                            } catch (e) {
                                console.error("Erro ao enviar msg de inatividade:", e);
                            }
                            interactionTimeouts.delete(jid);
                        }, INACTIVITY_TIMEOUT_MS);

                        interactionTimeouts.set(jid, timeoutId);
                    }
                }

            } catch (error) {
                console.error("❌ Erro ao processar resposta da IA:", error);
                console.error("[Erro Crítico Pós-Debounce]:", error);
                try {
                    await sock.sendMessage(jid, { text: "Desculpe, tive uma pequena instabilidade agora. Pode repetir sua dúvida?" });
                } catch (e) { /* ignore fallback fail */ }
            } finally {
                userIsProcessing.delete(jid); // Destrava!
                
                // Recovery: Se ainda houver mensagens na fila (re-empilhadas pelo pós-debounce abort),
                // reagenda o processamento para não deixar a fila órfã.
                if (userMessageQueues.has(jid) && userMessageQueues.get(jid).length > 0 && !userProcessingTimers.has(jid)) {
                    console.log(`[Debounce Recovery] Fila remanescente detectada para ${jid} (${userMessageQueues.get(jid).length} msgs). Re-agendando processamento.`);
                    userProcessingTimers.set(jid, setTimeout(processQueue, 1500));
                }
            }
        }; // Fim da func processQueue

        // Engatilha a execução da Fila Pós-Debounce (5 segundos de Inatividade)
        userProcessingTimers.set(jid, setTimeout(processQueue, 5000));

    }); // Fim do sock.ev.on('messages.upsert')
}

async function initialize() {
    if (initialized) return;

    try {
        console.log("[Boot] Iniciando aquecimento de Caches (Google Sheets)...");
        await googleSheetsService.getCachedSheetData();
        await googleSheetsService.getCachedCategoryData();
        startAutoRefresh(); // Start 45 min background loop

        const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
        const { version } = await fetchLatestBaileysVersion();

        console.log(`using WA v${version.join('.')}`);

        sock = makeWASocket({
            version,
            auth: state,
            printQRInTerminal: false,
            logger: pino({ level: 'silent' }), // Silencia completamente a poluição do Baileys
            browser: Browsers.baileys('Desktop'),
            syncFullHistory: false,
            generateHighQualityLinkPreview: true
        });



        setupEvents();

        // Listen for internal state updates to save creds
        sock.ev.on('creds.update', saveCreds);

    } catch (err) {
        console.error("Erro ao inicializar cliente Baileys WhatsApp:", err);
    }
}

async function destroy() {
    isDeliberateClose = true;
    if (sock) {
        try {
            if (sock.ws) sock.ws.close();
            else if (sock.end) sock.end(undefined);
            sock = null;
            initialized = false;
            console.log("Cliente WhatsApp encerrado.");
        } catch (e) {
            console.error("Erro ao encerrar cliente WhatsApp:", e);
        }
    }
}

function isInitialized() {
    return initialized;
}

module.exports = { initialize, destroy, isInitialized };
