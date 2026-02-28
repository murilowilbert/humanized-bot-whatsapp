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
        const holidays = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/holidays.json'))).dates;
        const today = getBrazilDateString();
        return holidays.includes(today);
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

    // Resolve as partes por parágrafo
    const parts = text.split(/(?:\r?\n)+/).filter(p => p.trim().length > 2);

    for (let i = 0; i < parts.length; i++) {
        let part = parts[i].trim();
        if (!part) continue;

        // Tenta achar todos os CODs na parte para carregar as fotos
        const regexCodGlobal = /(?:\[|\{\{)\s*COD:\s*([\w-]+)\s*(?:\]|\}\})/gi;
        const codMatches = Array.from(part.matchAll(regexCodGlobal));
        const extractedCodes = codMatches.map(m => m[1]);

        // Remove a tag do texto incondicionalmente
        part = part.replace(regexCodGlobal, '').trim();

        // Encontra os buffers das imagens
        const filesToSend = [];
        for (const cod of extractedCodes) {
            const pathsToCheck = [
                path.join(__dirname, `../data/fotos/${cod}.jpg`),
                path.join(__dirname, `../data/fotos/${cod}.png`),
                path.join(__dirname, `../data/fotos_sheets/${cod}.jpg`),
                path.join(__dirname, `../data/fotos_sheets/${cod}.png`),
                path.join(__dirname, `../assets/imagens_produtos/${cod}.jpg`),
                path.join(__dirname, `../assets/imagens_produtos/${cod}.png`)
            ];
            const file = pathsToCheck.find(p => fs.existsSync(p));
            if (file) filesToSend.push(file);
        }

        try {
            if (filesToSend.length > 0) {
                // A primeira imagem recebe o texto como legenda (caption)
                await sock.sendMessage(jid, {
                    image: { url: filesToSend[0] },
                    caption: part.length > 0 ? part : undefined
                });

                // As outras imagens (se houver mais de uma na mesma linha) vão sem legenda
                for (let j = 1; j < filesToSend.length; j++) {
                    await new Promise(resolve => setTimeout(resolve, 800));
                    await sock.sendMessage(jid, { image: { url: filesToSend[j] } });
                }
            } else {
                // Nenhuma imagem, manda só o texto normal
                if (part.length > 0) {
                    await sock.sendMessage(jid, { text: part });
                }
            }

            // Pausa sutil entre envio dos parágrafos
            await new Promise(resolve => setTimeout(resolve, 800));
        } catch (error) {
            console.error(`Erro ao enviar bolha/imagem (Index ${i}):`, error);
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

        // Ensure text extraction from Baileys structure
        let textContent = msg.message?.conversation ||
            msg.message?.extendedTextMessage?.text ||
            msg.message?.imageMessage?.caption ||
            '';

        // 1. Visibilidade Absoluta (Log no Topo)
        console.log(`[Raw Upsert] Recebido de ${msg.key?.remoteJid}: "${textContent}"`);

        // Edge Case 1: Filtro de Deleção/ProtocolMessage para evitar Crash
        if (msg.message?.protocolMessage || msg.message?.senderKeyDistributionMessage) return;

        const rawJid = msg.key.remoteJid;
        if (!rawJid || rawJid.includes('@g.us') || rawJid === 'status@broadcast') return;

        // O Baileys precisa do JID original (@lid ou @s.whatsapp.net) para conseguir responder a mensagem
        const jid = rawJid;

        // O restante das operações (banco de dados, whitelist, timeouts) usa a raiz numérica pura
        const headers = normalizeJid(rawJid);

        // Edge Case 8: Tratamento do 'fromMe' (Atendente Web)
        if (msg.key.fromMe) {
            const myMsg = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
            if (myMsg.trim() === '!bot') {
                userPausedStates.delete(jid);
                console.log(`[Manual Override] Atendente soltou a trava (!bot) para ${headers}`);
                await sock.sendMessage(jid, { text: "✅ Bot reativado para este chat." });
            }
            // return; // DESATIVADO TEMPORARIAMENTE PARA TESTES DO ADMIN NO PRÓPRIO CHAT
        }

        // Clear existing timeout if the user sends a new message
        if (interactionTimeouts.has(jid)) {
            clearTimeout(interactionTimeouts.get(jid));
            interactionTimeouts.delete(jid);
        }

        const pushname = msg.pushName || 'Cliente';

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

        const allowedNumbers = server.getAllowedNumbers();
        // 2. Normalização Bilateral da Whitelist (Garante extração bruta de números)
        const isAdmin = allowedNumbers.some(num => normalizeJid(num) === headers);

        if (server.isTestMode()) {
            if (!isAdmin) {
                // 3. Log de Rejeição do Modo de Teste
                console.log(`[Modo Teste] Ignorado: ${headers} (Original: ${rawJid})`);
                return;
            }
        }

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

        // 0.4 State Machine: AWAITING_TRIAGE_ANSWER
        if (userSessions.has(jid) && userSessions.get(jid).state === 'AWAITING_TRIAGE_ANSWER') {
            const sessionData = userSessions.get(jid);
            const timeElapsedMs = Date.now() - sessionData.stateTimestamp;

            // State Machine Timeout (25 minutos)
            if (timeElapsedMs > 25 * 60 * 1000) {
                console.log(`[State Machine] Usuário ${headers} demorou mais de 25min para responder. Resetando estado pendente.`);
                userSessions.delete(jid);
                // Continua o fluxo normal como se fosse nova mensagem abaixo
            } else {
                // Context Switching Detection (Anti-Stuck)
                const intentCheckText = lowerText.substring(0, 30);
                const isSwitchingContext = /tem |e sobre|queria|vocês têm|voces tem|que tipo de/i.test(intentCheckText);

                if (isSwitchingContext) {
                    console.log(`[State Machine] Usuário ${headers} mudou de ideia ("${intentCheckText}"). Abortando Triagem e iniciando nova busca.`);
                    userSessions.delete(jid);
                    // Permite que o código continue e processe a nova mensagem normalmente no fluxo normal
                } else {
                    console.log(`[State Machine] Usuário ${headers} respondeu à Triagem. Acionando Handoff Real...`);
                    userSessions.delete(jid); // Reseta o estado

                    await sock.sendPresenceUpdate('composing', jid);
                    await new Promise(resolve => setTimeout(resolve, 800));

                    const confirmMsg = "Certo, já anotei aqui! Vou repassar para um atendente continuar o atendimento com esses detalhes, só um segundo.";
                    await sock.sendMessage(jid, { text: confirmMsg });

                    await prisma.chatHistory.create({ data: { phoneNumber: headers, role: 'user', content: textContent } });
                    await prisma.chatHistory.create({ data: { phoneNumber: headers, role: 'model', content: confirmMsg } });

                    userPausedStates.set(jid, Date.now());
                    metricsService.incrementHandoff();
                    return; // 🛑 ABORTA a fila. O handoff foi consumado.
                }
            }
        } // <--- FECHA O BLOCO DO AWAITING_TRIAGE_ANSWER AQUI

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
            if (!isOpen() && !isHoliday()) docMsg = "Deixei o seu documento anotado! Como nossa loja já fechou hoje, um atendente humano vai analisar sua lista amanhã a partir das 08h.";
            if (isHoliday()) docMsg = "Deixei o seu documento guardado! Como hoje é feriado, voltaremos na segunda a partir das 08h e um atendente vai analisar sua lista.";

            await sock.sendMessage(jid, { text: docMsg });
            await prisma.chatHistory.create({ data: { phoneNumber: headers, role: 'model', content: "Handoff por Documento" } });

            userPausedStates.set(jid, Date.now());
            metricsService.incrementHandoff();
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
                        // Edge Case 2: Imagem Órfã
                        textContent = textContent || "Pode me ajudar a identificar o modelo e as especificações deste produto na foto?";
                    } else if (messageType === 'audioMessage' || messageType === 'pttMessage') {
                        const audioMime = msg.message[messageType].mimetype;
                        mediaData = { mimeType: audioMime.split(';')[0], data: buffer.toString('base64') };
                        textContent = textContent || "[Áudio do Usuário]";
                    }
                }
            } catch (e) {
                console.error("Erro ao baixar mídia:", e);
            }
        }

        // Checks already handled above

        // 1. Check Holidays & Working Hours
        if (!isAdmin && (isHoliday() || !isOpen())) {
            await sock.sendMessage(jid, { text: settings.messages.closed });
            return;
        }

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

        // Edge Case 3: Safe-Merge Ignore Trash (menos de 2 caracteres puro)
        if (!mediaData && textContent.length < 2 && textContent.match(/^[a-zA-Z0-9👍]$/)) {
            console.log(`[Safe-Merge] Mensagem de apenas 1 caractere de ${headers} ignorada no buffer.`);
            return;
        }

        userMessageQueues.get(jid).push({
            text: textContent,
            media: mediaData,
            isAdminOverride: isAdmin && (textContent.trim().toLowerCase() === 'reiniciar' || textContent.trim().toLowerCase() === 'atualizar estoque')
        });

        // 4. Start Debounce Timer
        const processQueue = async () => {
            userProcessingTimers.delete(jid);

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
                let lastMedia = null;

                for (const msgData of queue) {
                    if (msgData.text) combinedText += msgData.text + "\\n";
                    if (msgData.media) lastMedia = msgData.media;
                }

                // Clear the queue for this user
                userMessageQueues.delete(jid);

                // DB History: Salvar a mensagem "juntada" do usuário
                await prisma.chatHistory.create({
                    data: { phoneNumber: headers, role: 'user', content: combinedText.trim() }
                });

                // Buscar ultimas mensagens do DB (Limite de 20 para IA)
                const historyRecords = await prisma.chatHistory.findMany({
                    where: { phoneNumber: headers },
                    orderBy: { createdAt: 'asc' },
                    take: 20
                });

                // Amnésia de 36 horas (Time-To-Live)
                const ttlLimit = Date.now() - (36 * 60 * 60 * 1000);
                const recentRecords = historyRecords.filter(r => new Date(r.createdAt).getTime() > ttlLimit);

                // Edge Case 5: Context Truncation Slice(-12)
                let chatsHistory = recentRecords.map(r => ({ role: r.role, content: r.content }));
                if (chatsHistory.length > 12) {
                    chatsHistory = chatsHistory.slice(-12);
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
                    recentHistory = recentRecords.slice(-6).map(r => ({ role: r.role, content: r.content }));
                }

                if (lastMedia && lastMedia.mimeType.startsWith('image/')) {
                    await sock.sendPresenceUpdate('composing', jid);
                    searchKeywords = await aiService.extractImageKeywords(lastMedia, searchKeywords);
                }

                await sock.sendPresenceUpdate('composing', jid); // Status "digitando..."

                // Pivot 2: Roteamento de Intenção
                const intent = await aiService.classifyIntent(searchKeywords);

                let categoryMatch = null;
                if (intent === 'SEARCH') {
                    expandedQueryArray = await aiService.expandSearchQuery(searchKeywords, recentHistory);
                    // MANDATORY BYPASS: First, check if this is a generic Category Search BEFORE drilling down the product table.
                    categoryMatch = await stockService.searchCategory(expandedQueryArray.concat(searchKeywords));
                }

                // IF NOT CATEGORY OR IF NOT SEARCH, IT JUMPS TO STOCK EVALUATION DOWN BELOW
                let stockContext = [];
                let finalVisualKeyword = null;

                if (intent === 'SEARCH') {
                    // Feature 8: Visual Verification com Gabarito (Oracle Master)
                    if (lastMedia && lastMedia.mimeType.startsWith('image/') && stockContext && stockContext.length > 0) {
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
                            const nomesGabaritos = candidatesLocal.map((c, i) => `${i + 1}. ${c.name}`).join(", ");
                            console.log(`[Verificação Visual] Avaliando gabaritos: ${nomesGabaritos}`);

                            await sock.sendPresenceUpdate('composing', jid); // Status "digitando..."
                            console.log(`[Verificação Visual] Oráculo acionado com ${candidatesLocal.length} gabaritos disponíveis.`);
                            const visualConfirm = await aiService.verifyProductImageWithCatalog(lastMedia, combinedText, candidatesLocal);

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
                                console.log(`[Verificação Visual] Nenhuma correspondência exata nos gabaritos (Oráculo retornou NENHUM). Abortando IA Final.`);

                                // Bug Fix 2: Hardcoded Fallback para evitar alucinação
                                await sock.sendPresenceUpdate('composing', jid);
                                const fallbackMsg = "Não consegui identificar com certeza o modelo exato pela foto. Você sabe me dizer o nome da linha ou a marca?";
                                await sock.sendMessage(jid, { text: fallbackMsg });

                                // Update history for context
                                await prisma.chatHistory.create({ data: { phoneNumber: headers, role: 'model', content: fallbackMsg } }); // Fix Bug: save as 'model', not 'bot'

                                // Prevent calling the Final LLM by returning early
                                if (userMessageQueues.has(jid)) userMessageQueues.delete(jid);
                                return;
                            }
                        } else {
                            console.log("[Verificação Visual] Nenhuma foto de gabarito encontrada no HD para os top candidatos.");
                        }
                    }
                } else if (intent === 'FAQ') {
                    console.log(`[Intent Router] Intenção de 'FAQ' detectada. Ignorando consulta de db/estoque.`);
                }

                // O Fluxo Definitivo de Triagem e Handoff (Hardcoded / 3 Passos)

                // Passo B (Agora Mandatory First Pass): Triage Bypass (Verificação de Categoria Geral antes da Tabela Específica)
                if (intent === 'SEARCH' && categoryMatch) {
                    const perguntas = categoryMatch['perguntas_recomendadas'] || categoryMatch['perguntas recomendadas'] || categoryMatch.perguntas;
                    if (perguntas) {
                        console.log(`[Triagem Ativada] Categoria '${categoryMatch['categoria_geral']}' detectada de Imediato. Assumindo controle bypass + AI Naturalization...`);

                        // 1. Naturaliza a pergunta engessada com o LLM (Rodada 1 da Máquina de Estados)
                        const fallbackFullText = await aiService.naturalizeTriageQuestion(categoryMatch['categoria_geral'], perguntas);

                        // O prompt da IA instrui a dividir com |||
                        let questionPart = fallbackFullText;
                        let tipPart = "";

                        if (fallbackFullText.includes("|||")) {
                            const splitParts = fallbackFullText.split('|||');
                            questionPart = splitParts[0].trim();
                            tipPart = splitParts[1] ? splitParts[1].trim() : "";
                        }

                        // Anexa a saudação inicial do bot à pergunta principal
                        const firstBubble = `Temos opções de ${categoryMatch['categoria_geral']} sim! ${questionPart}`;

                        // 2. Salva a mensagem original do usuário
                        await prisma.chatHistory.create({
                            data: { phoneNumber: headers, role: 'user', content: combinedText.trim() }
                        });

                        // 3. Aciona o estado de "digitando" rápido e manda a primeira bolha
                        await sock.sendPresenceUpdate('composing', jid);
                        await new Promise(resolve => setTimeout(resolve, 1500));
                        await sock.sendMessage(jid, { text: firstBubble });

                        // 4. Se tiver a segunda parte (dica), aguarda e manda também
                        if (tipPart) {
                            await sock.sendPresenceUpdate('composing', jid);
                            await new Promise(resolve => setTimeout(resolve, 1500));
                            await sock.sendMessage(jid, { text: tipPart });
                        }

                        // 5. Salva a resposta completa do Bot no histórico (para contexto futuro)
                        await prisma.chatHistory.create({
                            data: { phoneNumber: headers, role: 'model', content: fallbackFullText.replace('|||', '\n') }
                        });

                        // 6. Seta o Estado para aguardar a resposta do cliente ANTES de dar Handoff (Rodada 2)
                        userSessions.set(jid, { state: 'AWAITING_TRIAGE_ANSWER', stateTimestamp: Date.now() });

                        return; // 🛑 ABORTA AQUI! Não busca os itens e nem gera tela cheia de respostas com a Tabela Principal.
                    }
                }

                // Passo C: Handoff Real (Genuíno 0 Resultados)
                if (intent === 'SEARCH' && (!stockContext || stockContext.length === 0)) {
                    console.log(`[Handoff Hardcoded] Busca Principal = 0 e Triagem Geral = 0. Acionando Transbordo imediato (Passo C)...`);

                    // Salva a mensagem do user antes de abortar
                    await prisma.chatHistory.create({
                        data: { phoneNumber: headers, role: 'user', content: combinedText.trim() }
                    });

                    await sock.sendPresenceUpdate('composing', jid);
                    await new Promise(resolve => setTimeout(resolve, 1000));

                    let handoffMsg = "";
                    if (isOpen()) {
                        handoffMsg = "Vou repassar para um atendente verificar isso certinho para você, só um segundo.";
                    } else {
                        handoffMsg = "Deixei sua dúvida anotada! Como nossa loja já fechou hoje, um atendente humano vai te responder assim que abrirmos amanhã às 08h.";
                    }

                    await sock.sendMessage(jid, { text: handoffMsg });

                    await prisma.chatHistory.create({
                        data: { phoneNumber: headers, role: 'model', content: handoffMsg }
                    });

                    userPausedStates.set(jid, getBrazilDateString());
                    metricsService.incrementHandoff();

                    return; // 🛑 ABORTA AQUI! O aiserice.generateResponse NUNCA será chamado.
                }

                // Passo A: IA Conversacional Normal (Há resultados no Estoque)
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

                let response;
                try {
                    response = await aiService.generateResponse(finalPromptInput, lastMedia, chatsHistory, stockContext, onWait);
                } catch (apiError) {
                    console.error("🚨 [ERRO FATAL API] Falha ou Timeout na geração da resposta FINAL pelo LLM:", apiError);

                    // Resiliência da API e Tratamento de Erro Fatal (Timeout Fallback)
                    const fallbackPardonMsg = "Meu sistema de busca deu uma engasgada técnica aqui! Já vou repassar sua mensagem para um de nossos atendentes te ajudar, só um segundo.";
                    await sock.sendMessage(jid, { text: fallbackPardonMsg });
                    await prisma.chatHistory.create({ data: { phoneNumber: headers, role: 'model', content: fallbackPardonMsg } });

                    userPausedStates.set(jid, getBrazilDateString());
                    metricsService.incrementHandoff();

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

                    // Coloca todo o texto que tentamos responder de volta no início da fila pra garantir contexto
                    userMessageQueues.get(jid).unshift({
                        text: combinedText,
                        media: lastMedia
                    });

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
                    if (isOpen()) {
                        await sock.sendMessage(jid, { text: "Vou repassar para um atendente responder certinho para você, só um segundo." });
                    } else {
                        await sock.sendMessage(jid, { text: "Deixei sua dúvida anotada! Como nossa loja já fechou hoje, um atendente humano vai te responder assim que abrirmos amanhã às 08h." });
                    }
                    userPausedStates.set(jid, getBrazilDateString());
                    metricsService.incrementHandoff();
                    return; // Encerra o fluxo aqui para não pedir avaliação nem iniciar timer de inatividade
                }

                // C) Rating
                if (combinedText.toLowerCase().includes('obrigado') || combinedText.toLowerCase().includes('valeu')) {
                    await sock.sendMessage(jid, { text: "Fico feliz em ajudar! De 0 a 5, qual sua nota para meu atendimento?" });
                }

                // D) Save Rating
                if (/^[1-5]$/.test(combinedText.trim())) {
                    metricsService.addRating(combinedText.trim(), "Via Whatsapp");
                    await sock.sendMessage(jid, { text: "Obrigado pela avaliação! ⭐" });
                }

                // E) Set Inactivity Follow-up
                const isConversationEnd = combinedText.toLowerCase().includes('obrigado') ||
                    combinedText.toLowerCase().includes('valeu') ||
                    /^[1-5]$/.test(combinedText.trim());

                if (!isConversationEnd) {
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
                try {
                    await sock.sendMessage(jid, { text: "Desculpe, tive uma pequena instabilidade agora. Pode repetir sua dúvida?" });
                } catch (e) { /* ignore fallback fail */ }
            } finally {
                userIsProcessing.delete(jid); // Destrava!
            }
        }; // Fim da func processQueue
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
            logger: pino({ level: 'silent' }), // Suppress detailed terminal logs from baileys
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
