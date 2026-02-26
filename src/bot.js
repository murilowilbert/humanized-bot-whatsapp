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
const aiService = require('./services/aiService');
const metricsService = require('./services/metricsService');
const catalogService = require('./services/catalogService');
const scraperService = require('./services/scraperService');
const server = require('./server/app');
const fs = require('fs');
const path = require('path');

const interactionTimeouts = new Map();
const INACTIVITY_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutos

// Sistema de fila de mensagens (Debouncing)
const userMessageQueues = new Map();
const userProcessingTimers = new Map();
const userIsProcessing = new Map(); // Trava de concorrência
const userPausedStates = new Map(); // Controle de Handoff/Pausa
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

    // Split by single or multiple newlines to create bubbles per paragraph
    const parts = text.split(/(?:\r?\n)+/).filter(p => p.trim().length > 2);

    for (let i = 0; i < parts.length; i++) {
        let part = parts[i].trim();
        if (!part) continue;

        // regex to catch both [COD: 123] and {{COD: 123}}
        const codMatch = part.match(/(?:\[|\{\{)\s*COD:\s*([\w-]+)\s*(?:\]|\}\})/i);
        let fileToSend = null;

        if (codMatch) {
            const cod = codMatch[1];

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

        // Limpeza Incondicional da Tag
        const regexCod = /(?:\[|\{\{)\s*COD:\s*([\w-]+)\s*(?:\]|\}\})/gi;
        part = part.replace(regexCod, '').trim();

        try {
            if (fileToSend) {
                const mediaBuffer = fs.readFileSync(fileToSend);
                await sock.sendMessage(jid, {
                    image: mediaBuffer,
                    caption: part
                });
            } else {
                if (part.length > 0) {
                    await sock.sendMessage(jid, { text: part });
                }
            }

            // Pausa sutil entre mensagens
            await new Promise(resolve => setTimeout(resolve, 1000));
        } catch (error) {
            console.error(`Erro ao enviar parte da mensagem no WhatsApp (Index ${i}):`, error);
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
        if (!msg.message || msg.key.fromMe) return;

        const jid = msg.key.remoteJid;
        // Ignore groups or status
        if (jid.includes('@g.us') || jid === 'status@broadcast') return;

        // Clear existing timeout if the user sends a new message
        if (interactionTimeouts.has(jid)) {
            clearTimeout(interactionTimeouts.get(jid));
            interactionTimeouts.delete(jid);
        }

        const pushname = msg.pushName || 'Cliente';
        // Extract phone number from JID (ex: 555199999999@s.whatsapp.net -> 555199999999)
        const headers = jid.split('@')[0];

        // Ensure text extraction from Baileys structure
        let textContent = msg.message.conversation ||
            msg.message.extendedTextMessage?.text ||
            msg.message.imageMessage?.caption ||
            '';

        // Middleware de Pausa (Handoff)
        const todayDate = getBrazilDateString();
        if (userPausedStates.has(jid)) {
            const pausedDate = userPausedStates.get(jid);
            // Reset da pausa no dia seguinte
            if (pausedDate !== todayDate) {
                userPausedStates.delete(jid);
            } else {
                console.log(`[Handoff Mute] Ignorando mensagem de ${pushname} (${headers})`);
                return; // Ignora completamente para o humano assumir
            }
        }

        console.log(`Recebido de ${pushname} (${headers}): ${textContent} (Aguardando debounce...)`);
        metricsService.incrementMessages();

        // Limpa o timer anterior do usuário, se houver, pois ele digitou de novo.
        if (userProcessingTimers.has(jid)) {
            clearTimeout(userProcessingTimers.get(jid));
        }

        // 0. Initialize Variables (Moved up for queuing)
        let mediaData = null;

        // 0.1 Process Media
        const messageType = Object.keys(msg.message)[0];
        if (messageType === 'imageMessage' || messageType === 'audioMessage') {
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
                    if (messageType === 'audioMessage') {
                        mediaData = { mimeType: msg.message.audioMessage.mimetype, data: buffer.toString('base64') };
                        textContent = textContent || "[Áudio do Usuário]";
                    } else if (messageType === 'imageMessage') {
                        mediaData = { mimeType: msg.message.imageMessage.mimetype, data: buffer.toString('base64') };
                        textContent = textContent || "[Foto do Usuário]";
                    }
                }
            } catch (e) {
                console.error("Erro ao baixar mídia:", e);
            }
        }

        // 0.2 Check Power & Test Mode
        if (!server.isBotEnabled()) {
            console.log("Bot desligado. Ignorando.");
            return;
        }

        const allowedNumbers = server.getAllowedNumbers();
        const isAdmin = allowedNumbers.some(num => headers.includes(num));

        if (server.isTestMode()) {
            if (!isAdmin) {
                console.log(`Ignorando ${headers} (Modo Teste Ativo)`);
                return;
            }
        }

        // 0.3 Check for "Reiniciar" command
        if (isAdmin && textContent && textContent.toLowerCase() === 'reiniciar') {
            await prisma.chatHistory.deleteMany({ where: { phoneNumber: headers } });
            await sock.sendMessage(jid, { text: "♻️ Conversa e histórico SQL reiniciados! Sou a IA da Ferragem Marlene, como posso ajudar?" });
            return;
        }

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

        userMessageQueues.get(jid).push({
            text: textContent,
            media: mediaData
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
                const chatsHistory = historyRecords.map(r => ({ role: r.role, content: r.content }));

                // Inteligência Artificial: Query Expansion
                // Transforma a intenção em um array rico de sinônimos técnicos
                let searchKeywords = combinedText;
                let recentHistory = [];

                if (historyRecords.length > 0) {
                    recentHistory = historyRecords.slice(-6).map(r => ({ role: r.role, content: r.content }));
                }

                if (lastMedia && lastMedia.mimeType.startsWith('image/')) {
                    await sock.sendPresenceUpdate('composing', jid);
                    searchKeywords = await aiService.extractImageKeywords(lastMedia, searchKeywords);
                }

                await sock.sendPresenceUpdate('composing', jid); // Status "digitando..."
                const expandedQueryArray = await aiService.expandSearchQuery(searchKeywords, recentHistory);

                // Passa o array rico de expansões para o Fuse.js/Stock
                let stockContext = await stockService.searchProduct(expandedQueryArray);
                let finalVisualKeyword = null;

                // Feature 8: Visual Verification com Gabarito (Oracle Master)
                if (lastMedia && lastMedia.mimeType.startsWith('image/') && stockContext && stockContext.length > 0) {
                    console.log("[Verificação Visual] Buscando gabaritos no HD...");
                    const candidatesLocal = [];
                    const itemsToCheck = stockContext.slice(0, 3);

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
                        await sock.sendPresenceUpdate('composing', jid); // Status "digitando..."
                        console.log(`[Verificação Visual] Oráculo acionado com ${candidatesLocal.length} gabaritos disponíveis.`);
                        const visualConfirm = await aiService.verifyProductImageWithCatalog(lastMedia, combinedText, candidatesLocal);

                        if (visualConfirm) {
                            // O Oráculo aprovou um dos códigos exatos ou uma peça específica!
                            // Refaz a busca focada nessa string/código matador
                            console.log(`[Verificação Visual] Sucesso! Nova Query Focada: "${visualConfirm}"`);
                            stockContext = await stockService.searchProduct([visualConfirm]);
                            finalVisualKeyword = visualConfirm;
                        } else {
                            console.log(`[Verificação Visual] Nenhuma correspondência exata nos gabaritos.`);
                        }
                    } else {
                        console.log("[Verificação Visual] Nenhuma foto de gabarito encontrada no HD para os top candidatos.");
                    }
                }

                // Feature 2 & 3: Scraping ao vivo (Lazy Execution) post-debounce
                // Raspa os primeiros N resultados (ex: Top 3) para garantir validação de estoque 
                if (stockContext && stockContext.length > 0) {
                    const itemsToScrape = stockContext.slice(0, 3);
                    for (const result of itemsToScrape) {
                        const productData = result.item || result;
                        const ean = productData['código'] || productData['codigo'] || productData.Codigo;

                        if (!ean) continue;

                        const liveStock = await scraperService.fetchRealTimeStock(ean);
                        if (liveStock !== null) {
                            if (result.item) {
                                // Planilha Dinâmica do Google (Geralmente minúsculo)
                                result.item['estoque'] = liveStock === 0 ? "0 (ESGOTADO)" : liveStock;
                            } else {
                                // DB Estático XLSX
                                result.Estoque = liveStock === 0 ? "0 (ESGOTADO)" : liveStock;
                            }
                        }
                    }
                }

                // 4. Generate Response & 5. Send Response
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

                const response = await aiService.generateResponse(finalPromptInput, lastMedia, chatsHistory, stockContext, onWait);

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

                // B) Human Handoff
                if (response.needsHandoff) {
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
        }; // Fim da func queue

        // Start countdown to process queue
        userProcessingTimers.set(jid, setTimeout(processQueue, DEBOUNCE_TIME_MS));

    });
}

async function initialize() {
    if (initialized) return;

    try {
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
