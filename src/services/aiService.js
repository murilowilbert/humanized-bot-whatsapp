const { genAI, modelConfig, SYSTEM_PROMPT } = require('../config/ai_config');
const stockService = require('./stockService');
const settings = require('../config/settings');
const fs = require('fs');
const path = require('path');

const model = genAI.getGenerativeModel(modelConfig);

/**
 * 
 *
 * @param {string} userText
 * @param {object} mediaData { mimeType, data (base64) } - Optional
 * @param {Array} chatHistory
 * @param {Array} stockContext - Products available/relevant
 * @param {Function} onWait - Optional callback when waiting for Rate Limits
 */
async function generateResponse(userText, mediaData, chatHistory, stockContext, onWait = null) {
    // Retry Logic
    const MAX_RETRIES = 5;
    let delay = 2000; // Start with 2 seconds

    // Load store info once per request
    let storeInfo = "";
    try {
        storeInfo = fs.readFileSync(path.join(__dirname, '../../data/store_info.md'), 'utf8');
    } catch (e) {
        console.error("Erro ao ler store_info.md:", e);
    }

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            // Prepare context string
            const whatsappFormattingInstruct = "### FORMATAÇÃO WHATSAPP:\nVocê DEVE usar a formatação do WhatsApp para destacar as partes importantes: use *asteriscos* para negrito (ex: *Martelo*). Use *negrito* sempre que for escrever valores em R$, nomes de produtos e dias da semana.\n\n" +
                "### HUMANIZAÇÃO DE NOMES DE PRODUTOS (REGRA CRÍTICA - NÃO IGNORE):\n" +
                "Você atua como um humano conversando no WhatsApp. NUNCA cite o nome técnico do estoque exatamente como está escrito (ex: TODO EM MAIÚSCULO, 'DUCHA OPTIMA ELETR. 7700W 220V ZAGONEL').\n" +
                "Sempre converta o nome técnico para um Título Amigável (Title Case) e legível antes de enviá-lo para o cliente! Exemplos:\n" +
                "- Invés de: 'DUCHA OPTIMA ELETR. 7700W 220V ZAGONEL'\n" +
                "- Diga: '*Ducha Zagonel Optima Eletrônica* (7700W / 220V)'\n" +
                "- Invés de: 'RES TORN ESSENCE 220V 5500W 3070A LORENZETTI'\n" +
                "- Diga: '*Resistência p/ Torneira Lorenzetti Essence* (220V / 5500W)'\n" +
                "Qualquer mensagem contendo ALL CAPS ou jargões puros do banco de dados resultará em falha crítica.";

            const server = require('../server/app');
            const isFullStockEnabled = server.isFullStockEnabled();

            const stockInfoText = stockContext.length > 0
                ? "### ESTOQUE ATUALIZADO (Use estes dados para recomendar):\n" + JSON.stringify(stockContext, null, 2)
                : (isFullStockEnabled
                    ? "### ESTOQUE: A princípio não encontramos o item exato, mas tente conduzir a conversa (sem falar 'o sistema indica que não tem', aja como humano). Aja normalmente oferecendo similares genéricos."
                    : "### ESTOQUE: ITEM NÃO ENCONTRADO NA TABELA. Você DEVE acionar a transferência para um atendente humano imediatamente usando a regra de Handoff, não afirme que não temos.");

            const isFirstMessage = chatHistory.length <= 1; // includes current message

            const workingHoursText = "### HORÁRIOS DE ATENDIMENTO:\n" +
                "- Segunda a Sexta-feira: 08:00 às 12:00 e 13:30 às 19:00\n" +
                "- Sábado: 08:00 às 12:00 e 14:00 às 17:30\n" +
                "- Domingo: Fechado";

            // Injecting current date context
            const now = new Date();
            const days = ['Domingo', 'Segunda-feira', 'Terça-feira', 'Quarta-feira', 'Quinta-feira', 'Sexta-feira', 'Sábado'];
            const todayStr = `Hoje é ${days[now.getDay()]}, ${now.toLocaleDateString('pt-BR')} e o horário atual é ${now.toLocaleTimeString('pt-BR')}.`;

            const specificRules = "### REGRAS ESPECIAIS:\n" +
                "- FOTOS DO CLIENTE: O sistema já leu a imagem e injetou os possíveis produtos no estoque. AJA NATURALMENTE. NUNCA use frases robóticas como 'Com base na foto', 'Analisando a imagem', 'O sistema identificou', etc. Apenas assuma que você viu a foto e vá direto ao ponto (ex: 'Sim, nós temos a Ducha Ducali por...').\n" +
                (isFullStockEnabled
                    ? "- ESTOQUE VAZIO: NUNCA diga 'Nosso estoque indica Produto não encontrado'. Diga apenas 'Pior que não tenho essa marca no momento' ou ofereça um similar amigavelmente.\n"
                    : "- ESTOQUE VAZIO: NUNCA Diga que 'não temos' ou 'não tem essa marca'. De imediato use a regra de HANDOFF ('Vou repassar para um atendente responder certinho...').\n"
                ) +
                "- TELE-ENTREGA: Quando alguém perguntar de tele-entrega, responda EXATAMENTE: 'Infelizmente ainda não possuímos tele-entrega 😕' (ou use outro emoji similar).\n" +
                "- LOCALIZAÇÃO: Se pedir endereço, envie o endereço amigavelmente e obrigatoriamente inclua a tag exata no final da resposta: [ACTION: SEND_LOCATION] (pois o sistema interceptará essa tag para enviar o mapa do GPS). Exemplo: 'Nossa loja fica na Rua Osvaldo Cruz, 417, Centro, Igrejinha, pertinho da Rua Coberta! [ACTION: SEND_LOCATION]'\n" +
                "- LISTAGEM DE MARCAS: Se o cliente perguntar 'tem quais marcas?' ou 'quais opções tem?', VERIFIQUE O ESTOQUE ENVIADO E SEMPRE CITE TODAS AS MARCAS que constam ali naquele momento, para não perder vendas. Exemplo: 'Temos opções da Zagonel, Sintex e Lorenzetti!'.\n" +
                "- APRESENTAÇÃO DE PRODUTOS: APRESENTE CADA PRODUTO EM UM ÚNICO PARÁGRAFO. Não quebre linhas no meio da explicação de um mesmo produto. Ao final do parágrafo, coloque a tag [COD: xxx]. NUNCA escreva a palavra '[foto]'. Formato de preço obrigatório: Tudo junto e com vírgula, ex: *R$145,00*, *R$859,90*.";

            const sessionPrompt = `### CONTEXTO DE TEMPO:\n${todayStr}\n\n` +
                `### INFORMAÇÕES DA LOJA:\n${storeInfo}\n\n${workingHoursText}\n\n${stockInfoText}\n\n` +
                `${specificRules}\n\n` +
                `${whatsappFormattingInstruct}\n\n` +
                `### INSTRUÇÃO DE SESSÃO:\n` +
                (isFirstMessage
                    ? "Esta é a PRIMEIRA mensagem. Seja humano."
                    : "Aja como humano. Responda diretamente e seja natural.");

            // 2. Build contents array with alternating roles
            const contents = [];
            for (const msg of chatHistory) {
                const role = msg.role === 'user' ? 'user' : 'model';
                const newPart = { text: msg.content };

                if (contents.length > 0 && contents[contents.length - 1].role === role) {
                    contents[contents.length - 1].parts.push(newPart);
                } else {
                    contents.push({ role: role, parts: [newPart] });
                }
            }

            // Append current media to the LAST user message
            if (mediaData && contents.length > 0 && contents[contents.length - 1].role === 'user') {
                contents[contents.length - 1].parts.push({
                    inlineData: {
                        mimeType: mediaData.mimeType,
                        data: mediaData.data
                    }
                });
            }

            console.log(`[AI] Gerando resposta. Histórico: ${contents.length} msgs. Primeira: ${isFirstMessage}`);

            const result = await model.generateContent({
                contents: contents,
                systemInstruction: {
                    parts: [{ text: SYSTEM_PROMPT + "\n\n" + sessionPrompt }]
                }
            });

            const response = result.response;
            let text = response.text();

            const candidate = response.candidates && response.candidates[0];
            if (candidate && candidate.finishReason && candidate.finishReason !== 'STOP') {
                console.log(`[AI] Geração interrompida por: ${candidate.finishReason}`);
                if (candidate.finishReason === 'SAFETY' || candidate.finishReason === 'BLOCKLIST') {
                    text = "Desculpe, por questões de segurança e privacidade não posso analisar este tipo de documento. Como posso ajudar com outras dúvidas da loja?";
                } else if (!text || text.trim() === '') {
                    text = "Não consegui concluir a análise da imagem. Por favor, tente explicar em texto ou contate nosso atendimento.";
                }
            }

            // Detect Handoff
            const needsHandoff = text.toLowerCase().includes("atendente humano") || text.toLowerCase().includes("fixar nossa conversa");

            return {
                text: text,
                needsHandoff: needsHandoff
            };

        } catch (error) {
            console.error(`❌ Erro IA (Tentativa ${attempt}/${MAX_RETRIES}):`, error.message);

            // If it's the last attempt, return fallback
            if (attempt === MAX_RETRIES) {
                // Fallback simples se a IA falhar totalmente
                return {
                    text: "No momento nossos sistemas estão sobrecarregados devido a alta demanda. Por favor, tente novamente em alguns instantes ou entre em contato com nosso atendimento humano.",
                    needsHandoff: false
                };
            }

            // Check if retryable (429 or 503)
            const isRetryable = error.message.includes('429') || error.message.includes('503') || error.message.includes('Overloaded');

            if (isRetryable) {
                let waitTime = delay;
                // Ajustado para suportar segundos decimais (ex: "in 21.03s")
                const match = error.message.match(/in\s+(\d+(?:\.\d+)?)s/);
                if (match && match[1]) {
                    waitTime = Math.ceil(parseFloat(match[1])) * 1000 + 1000; // Add 1s extra just to be safe
                }

                console.log(`⏳ [AI] Rate Limit/Overload. Aguardando ${waitTime}ms (Tentativa ${attempt})...`);
                if (onWait) {
                    try { await onWait(waitTime); } catch (e) { }
                }
                await new Promise(resolve => setTimeout(resolve, waitTime));

                // Exponential backoff for next time if not forced
                delay = Math.min(delay * 2, 10000);
            } else {
                // If 404/403 (Configuration error), retrying won't help. Break loop.
                // Re-throw non-retryable errors to be handled by an outer catch if desired,
                // or provide a generic error message here.
                console.error("❌ ERRO CRÍTICO NÃO-RETRYÁVEL NA IA:", error);
                if (error.response) {
                    console.error("Detalhes da Resposta:", JSON.stringify(error.response, null, 2));
                }
                return {
                    text: "Desculpe, tive um problema técnico momentâneo (Erro: " + error.message + "). Pode repetir?",
                    needsHandoff: false
                };
            }
        }
    }
    // This part should ideally not be reached if all paths return or throw.
    // As a safeguard, return a generic error if the loop somehow finishes without a return.
    return {
        text: "Desculpe, não consegui processar sua solicitação após várias tentativas. Por favor, tente novamente mais tarde.",
        needsHandoff: false
    };
}

async function transcribeAudio(audioBuffer) {
    // Gemini 1.5 Flash supports audio directly via inlineData!
    // No need for ffmpeg if we send the audio bytes directly (as long as format is supported, e.g. mp3, aac, wav).
    // WhatsApp voice notes are usually ogg/opus. Gemini might accept ogg.
    return {
        mimeType: "audio/ogg",
        data: audioBuffer.toString('base64')
    };
}

/**
 * Pre-Flight check para analisar imagem antes de puxar estoque
 */
async function extractImageKeywords(mediaData, textContent) {
    try {
        const result = await model.generateContent({
            contents: [
                {
                    role: 'user',
                    parts: [
                        { text: `O cliente enviou a seguinte foto no WhatsApp, com a legenda: "${textContent || 'Nenhuma legenda'}". Analise a imagem e me retorne EXATAMENTE os termos chaves (nome do produto, marca, modelo, voltagem se tiver) para eu pesquisar no meu banco de dados de estoque. Seja cirúrgico. Retorne apenas uma string simples com as palavras separadas por espaço. Exemplo: 'ducha ducali zagonel' ou 'torneira prima'.` },
                        { inlineData: { mimeType: mediaData.mimeType, data: mediaData.data } }
                    ]
                }
            ],
            systemInstruction: { parts: [{ text: "Você é um classificador de imagens focado em descobrir nomes de materiais de construção, ferramentas, elétrica e hidráulica. Extraia o texto contido nas caixas e produtos." }] }
        });
        const tags = result.response.text().trim();
        console.log(`[AI Vision Pre-Flight] Extraído da imagem: ${tags}`);
        // Junta o texto do user original com os termos da imagem para garantir que o contexto não se perca
        return `${textContent} ${tags}`;
    } catch (e) {
        console.error("Erro no vision pre-flight:", e);
        return textContent; // Fallback
    }
}

module.exports = {
    generateResponse,
    transcribeAudio,
    extractImageKeywords
};
