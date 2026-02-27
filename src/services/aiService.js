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
            const tzParams = { timeZone: "America/Sao_Paulo" };

            const weekdayFormatter = new Intl.DateTimeFormat('pt-BR', { weekday: 'long', ...tzParams });
            const dateFormatter = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', ...tzParams });
            const timeFormatter = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit', ...tzParams });

            const weekday = weekdayFormatter.format(now);
            const capitalizedWeekday = weekday.charAt(0).toUpperCase() + weekday.slice(1);

            const todayStr = `Hoje é ${capitalizedWeekday}, ${dateFormatter.format(now)} e o horário atual é ${timeFormatter.format(now)}.`;

            const specificRules = "### REGRAS ESPECIAIS:\n" +
                "- FOTOS DO CLIENTE: O sistema já leu a imagem e injetou os possíveis produtos no estoque. AJA NATURALMENTE. NUNCA use frases robóticas como 'Com base na foto', 'Analisando a imagem', 'O sistema identificou', etc. Apenas assuma que você viu a foto e vá direto ao ponto (ex: 'Sim, nós temos a Ducha Ducali por...').\n" +
                (isFullStockEnabled
                    ? "- ESTOQUE VAZIO: NUNCA diga 'Nosso estoque indica Produto não encontrado'. Diga apenas 'Pior que não tenho essa marca no momento' ou ofereça um similar amigavelmente.\n"
                    : "- ESTOQUE VAZIO: NUNCA Diga que 'não temos' ou 'não tem essa marca'. De imediato use a regra de HANDOFF ('Vou repassar para um atendente responder certinho...').\n"
                ) +
                "- TELE-ENTREGA: Quando alguém perguntar de tele-entrega, responda EXATAMENTE: 'Infelizmente ainda não possuímos tele-entrega 😕' (ou use outro emoji similar).\n" +
                "- LOCALIZAÇÃO: Se pedir endereço, envie o endereço amigavelmente e obrigatoriamente inclua a tag exata no final da resposta: [ACTION: SEND_LOCATION] (pois o sistema interceptará essa tag para enviar o mapa do GPS). Exemplo: 'Nossa loja fica na Rua Osvaldo Cruz, 417, Centro, Igrejinha, pertinho da Rua Coberta! [ACTION: SEND_LOCATION]'\n" +
                "- LISTAGEM DE MARCAS: Se o cliente perguntar 'tem quais marcas?' ou 'quais opções tem?', VERIFIQUE O ESTOQUE ENVIADO E SEMPRE CITE TODAS AS MARCAS que constam ali naquele momento, para não perder vendas. Exemplo: 'Temos opções da Zagonel, Sintex e Lorenzetti!'.\n" +
                "- APRESENTAÇÃO DE PRODUTOS E MÚLTIPLAS FOTOS: APRESENTE CADA PRODUTO EM UM ÚNICO PARÁGRAFO. SE o usuário solicitar fotos de múltiplos produtos (ou mesmo de 1 só), você DEVE obrigatoriamente incluir a tag dupla {{COD:EAN_DO_PRODUTO}} ao final da descrição de CADA produto mencionado. Exemplo: '*Ducha Zagonel* R$145,00 {{COD:789123456}}'. NUNCA escreva a palavra '[foto]'. Formato de preço obrigatório: Tudo junto e com vírgula, ex: *R$145,00*.\n" +
                "- CONCISÃO E AFUNILAMENTO (ANTI-TEXTÃO): Se a busca retornar mais de 3 variações do mesmo produto (ex: conectores de vários fios, parafusos de vários tamanhos), VOCÊ É PROIBIDO de listar todas as opções e preços. Em vez disso, diga brevemente que temos o produto e faça APENAS UMA pergunta de afunilamento para descobrir a necessidade exata (ex: \"Para quantos fios você precisa?\"). Mantenha as respostas curtas e humanas.";

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
                        { text: `O cliente enviou a seguinte foto no WhatsApp, com a legenda: "${textContent || 'Nenhuma legenda'}". Aja como um assistente de ferragem. Sua tarefa nesta etapa (Pre-Flight) é gerar UMA DESCRIÇÃO NEUTRA E GENÉRICA DAS CARACTERÍSTICAS FÍSICAS do produto na foto (ex: 'chuveiro eletrico branco quadrado de parede', 'torneira de metal cano longo'). \n\nREGRA ABSOLUTA: VOCÊ ESTÁ ESTRITAMENTE PROIBIDO DE TENTAR ADIVINHAR OU INVENTAR MARCAS OU LINHAS COMERCIAIS (ex: NUNCA diga 'Lorenzetti', 'Acqua Storm', 'Tigre' a menos que o texto da marca esteja NITIDAMENTE legível na foto). Se for um pedido de conserto, descreva a peça genérica que falta (ex: 'resistencia chuveiro generica', 'reparo registro de parede'). Retorne apenas os termos de busca separados por espaço (sem explicações).` },
                        { inlineData: { mimeType: mediaData.mimeType, data: mediaData.data } }
                    ]
                }
            ],
            systemInstruction: { parts: [{ text: "Você é um extrator de características físicas NEUTRAS de materiais de construção. Foque em forma, cor, tipo e uso genérico. PROIBIDO CHUTAR MARCAS OU MODELOS COMERCIAIS." }] }
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

/**
 * Feature 8: Oráculo Master (Confirmação Visual com Gabarito)
 * Envia a foto do zap + fotos do DB local pro Gemini dar a cartada final.
 * 
 * @param {Object} originalMedia { mimeType, data (base64) } da foto enviada pelo usuário
 * @param {string} originalText A legenda que o usuário mandou (ex: "Tem essa?")
 * @param {Array<Object>} candidates Array de objetos. Cada objeto tem { code, name, localImageBase64 }
 * @returns {Promise<string|null>} Retorna o "code" do produto matador. Ou null se nenhum bater.
 */
async function verifyProductImageWithCatalog(originalMedia, originalText, candidates) {
    if (!originalMedia || !candidates || candidates.length === 0) return null;

    try {
        // Monta o prompt
        let promptText = `O cliente enviou a primeira foto para o WhatsApp da nossa ferragem perguntando: "${originalText}".\n\n`;
        promptText += `Eu, como sistema do estoque, consegui resgatar ${candidates.length} fotos dos produtos que mais se assemelham ao que ele pediu, lendo nossa prateleira.\n\n`;
        promptText += `Sua missão como 'Oráculo Master': Olhe a foto do cliente e compare com o nosso GABARITO (as fotos de estoque anexadas abaixo). Me diga se o cliente quer:\n`;
        promptText += `A) Comprar exatamente a Máquina/Objeto de um dos Gabaritos.\n`;
        promptText += `B) Comprar uma Peça de Manutenção/Reposição (ou o refil) para a Máquina/Objeto de um dos Gabaritos que está quebrado/velho.\n\n`;
        promptText += `AÇÃO EXTREMAMENTE TOLERANTE: As fotos de referência (gabaritos) são fotos de catálogo e podem ter fundos de cores sólidas (ex: vermelho, branco, transparente). A foto do usuário é real, com fundos sujos, azulejos, ângulos tortos e até água caindo. IGNORE COMPLETAMENTE o fundo, a cor do cenário e a água. Foque 100% na silhueta do produto, formato do espalhador, hastes e curvas. Se a silhueta geométrica bater, confirme a correspondência, mesmo que o ângulo esteja diferente. Não procure por cópias perfeitas.\n\n`;
        promptText += `Se a resposta for A, me retorne APENAS o CÓDIGO EXATO (os números) do gabarito correspondente. Mais nada.\n`;
        promptText += `Se a resposta for B, me retorne APENAS a string de busca para a peça necessária MAIS a frase inteira do produto gabarito (Ex: 'resistencia chuveiro zagonel optima').\n`;
        promptText += `Se definitivamente não tiver NDA a ver (não é nenhum dos gabaritos), retorne a palavra "NENHUM".\n\n`;
        promptText += `--- GABARITOS ---\n`;

        // Prepara as partes a enviar para o Gemini (Prompt Text + 1 Foto Cliente + N Fotos Gabarito)
        const parts = [];

        parts.push({ text: promptText });

        // Foto Original do Cliente
        parts.push({ text: "[FOTO DO CLIENTE]:" });
        parts.push({ inlineData: { mimeType: originalMedia.mimeType, data: originalMedia.data } });

        // Fotos do Catálogo
        candidates.forEach((cand, index) => {
            parts.push({ text: `\n[GABARITO ${index + 1}] Código numérico: ${cand.code} | Nome: ${cand.name}` });
            parts.push({ inlineData: { mimeType: 'image/jpeg', data: cand.localImageBase64 } });
        });

        const result = await model.generateContent({
            contents: [{ role: 'user', parts: parts }],
            systemInstruction: { parts: [{ text: "Você é um auditor de estoque 100% focado e cirúrgico. Nunca escreva frases longas ou introduções." }] }
        });

        const answer = result.response.text().trim();
        console.log(`[AI Visual Audit] Resposta do Oráculo: ${answer}`);

        if (answer.toUpperCase() === "NENHUM" || answer.length > 100) {
            return null; // Falhou na auditoria visual ou se perdeu
        }

        return answer; // Vai ser o Código (Ex: "1234") ou o termo de busca estendido (Ex: "resistencia chuveiro...")
    } catch (e) {
        console.error("Erro na Auditoria Visual com Catálogo:", e);
        return null;
    }
}

/**
 * Amplia os termos de busca com IA para lidar com gírias e sinônimos frouxos
 */
async function expandSearchQuery(userMessage, recentHistory = []) {
    try {
        // Bug Fix: Remove control characters (\r, \n) to prevent JSON parse errors
        const sanitizedMessage = userMessage ? userMessage.replace(/[\r\n]+/g, ' ').trim() : '';
        const historyText = recentHistory.map(h => `${h.role === 'user' ? 'Cliente' : 'Bot'}: ${h.content ? h.content.replace(/[\r\n]+/g, ' ') : ''}`).join("\n");

        const prompt = `Você é um especialista em materiais de construção e ferragens recebendo termos para buscar num banco de dados.

Sua tarefa: Analisar a 'Mensagem Atual' do cliente e o 'Histórico Recente' para gerar ESTRITAMENTE um array JSON com palavras-chave curtas focadas em busca textual.

### REGRAS CRÍTICAS DE CONTEXTO E FUNIL:
1. CONTEXTO ACUMULATIVO (O FUNIL): A busca não se baseia apenas na última frase. Se o cliente falou de "torneira" antes, e agora disse "parede" ou "elétrica", VOCÊ DEVE manter a palavra primária ("torneira") junto com a novidade ("torneira parede elétrica").
2. MUDANÇA DE ASSUNTO (RESET): Se o cliente mudou radicalmente para outro objeto (estava em torneira e foi para cimento), abandone o histórico antigo. Foque 100% no assunto novo ("cimento cp2").
3. PALAVRAS-CHAVE CURTAS: Não transforme perguntas em buscas longas. Extraia a essência. Invés de "quero uma torneira zagonel de pia", retorne ["torneira zagonel pia", "torneira de pia"].
4. SINÔNIMOS ÚTEIS: Se houver gíria ou erro comum (ex "tornera"), use a grafia correta na busca ("torneira").

### ENTRADAS:
Mensagem Atual: "${sanitizedMessage}"
Histórico Recente (Opcional):
${historyText ? historyText : "Nenhum histórico recente."}

RETORNE APENAS O ARRAY JSON. NADA A MAIS.
Exemplo 1 (Acumulando): ["torneira de parede", "torneira elétrica parede"]
Exemplo 2 (Mudando Assunto): ["cimento cp2", "cimento votoran"]
Exemplo 3 (Novo): ["fita veda rosca", "fita teflon"]`;

        const result = await model.generateContent(prompt);
        let rawResponse = result.response.text().trim();

        if (rawResponse.startsWith('```json')) {
            rawResponse = rawResponse.substring(7, rawResponse.length - 3).trim();
        } else if (rawResponse.startsWith('```')) {
            rawResponse = rawResponse.substring(3, rawResponse.length - 3).trim();
        }

        const expandedTerms = JSON.parse(rawResponse);
        console.log(`[Query Expansion] Original: "${userMessage}" -> Expandido:`, expandedTerms);

        if (Array.isArray(expandedTerms)) {
            return expandedTerms;
        }
        return [userMessage];
    } catch (e) {
        console.error("Erro no expandSearchQuery da IA:", e);
        return [userMessage];
    }
}

/**
 * Classifica a intenção primária do usuário para evitar buscas desnecessárias na planilha
 */
async function classifyIntent(userMessage) {
    if (!userMessage || userMessage.trim() === '') return 'FAQ';

    try {
        const prompt = `Classifique a seguinte mensagem do cliente em uma das duas categorias:
1. "STORE_FAQ": Perguntas gerais da loja (horário de funcionamento, endereço, localização física, se tem tele-entrega, formas de pagamento) ou saudações muito básicas desvinculadas de produtos ("bom dia", "olá", "tudo bem").
2. "PRODUCT_SEARCH": Qualquer tentativa de encontrar, comprar, perguntar o preço ou saber informações sobre produtos mecânicos, elétricos, hidráulicos, tintas ou consertos ("tem chuveiro?", "qual o preço da torneira?", "cimento", "cano pvc").

Mensagem: "${userMessage}"

Retorne APENAS a string "STORE_FAQ" ou "PRODUCT_SEARCH".`;

        const result = await model.generateContent({
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            systemInstruction: { parts: [{ text: "Classificador de intenções estrito. Responda apenas com a tag solicitada." }] }
        });

        const intent = result.response.text().trim().toUpperCase();
        console.log(`[Intent Router] Classificação da Mensagem "${userMessage}": ${intent}`);

        return intent.includes('STORE_FAQ') ? 'FAQ' : 'SEARCH';
    } catch (e) {
        console.error("Erro na classificação de intenção:", e);
        return 'SEARCH'; // Default fallback = pesquisar produto
    }
}

module.exports = {
    generateResponse,
    transcribeAudio,
    extractImageKeywords,
    verifyProductImageWithCatalog,
    expandSearchQuery,
    classifyIntent
};
