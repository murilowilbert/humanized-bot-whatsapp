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
async function generateResponse(userText, mediaData, chatHistory, stockContext, onWait = null, offHoursContext = null) {
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
                "- REGRA ANTI-LOOP (ABSOLUTA): Verifique o histórico de mensagens. Se VOCÊ acabou de fazer uma pergunta de afunilamento na mensagem anterior e o USUÁRIO acabou de RESPONDER a essa preferência, VOCÊ É ESTRITAMENTE PROIBIDO de fazer uma nova pergunta genérica. Você DEVE cruzar a resposta do usuário com os [ESTOQUE ATUALIZADO], selecionar as 2 ou 3 opções que melhor atendem ao pedido, informar os preços diretamente e explicar brevemente a diferença entre elas.\n" +
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
                (offHoursContext ? `### ALERTA DE HORÁRIO COMERCIAL (SIGA ESTRITAMENTE):\n${offHoursContext}\n\n` : "") +
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
                // Ao retornar o throw, o bot.js vai capturar e anunciar o Timeout Fallback
                throw new Error(`[AI Timeout] Limite de ${MAX_RETRIES} tentativas alcançado.`);
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
        promptText += `Você é um auditor visual implacável. COMPARE estritamente as características físicas da foto do usuário (curvaturas, espessura, formato da base e do espalhador) com as URLs de imagem ou dados numéricos fornecidos nas opções abaixo. Você NÃO PODE deduzir apenas pelo texto. Se a imagem do usuário for plana/slim, não selecione um modelo com base cilíndrica. Retorne APENAS o código/EAN da correspondência visual exata. Se nenhuma foto/item corresponder EXATAMENTE ao design físico (ou for muito duvidoso), retorne ESTRITAMENTE a palavra NENHUM.\n\nEstas são as ${candidates.length} opções pré-selecionadas do nosso banco de dados:\n`;
        promptText += `Eu, como sistema do estoque, consegui resgatar ${candidates.length} fotos dos produtos que mais se assemelham ao que ele pediu, lendo nossa prateleira.\n\n`;
        promptText += `Sua missão como 'Oráculo Master': Olhe a foto do cliente e compare com o nosso GABARITO (as fotos de estoque anexadas abaixo). Me diga qual é O PRODUTO PRINCIPAL (o hospedeiro) da foto corporificada.\n`;
        promptText += `Mesmo que o cliente peça uma peça de reposição ("resistência", "refil"), VOCÊ DEVE me indicar qual o CHUVEIRO/MÁQUINA/HOSPEDEIRO inteiro que está batendo com a foto, e nunca tentar adivinhar qual é a pecinha interna solta.\n\n`;
        promptText += `AÇÃO EXTREMAMENTE TOLERANTE: As fotos de referência (gabaritos) são fotos de catálogo e podem ter fundos de cores sólidas. A foto do usuário é real, com fundos sujos, azulejos, ângulos tortos. IGNORE COMPLETAMENTE o fundo. Foque 100% na silhueta do produto hospedeiro principal.\n\n`;
        promptText += `Me retorne APENAS o CÓDIGO EXATO (os números) do gabarito correspondente ao produto hospedeiro. Mais nada.\n`;
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
        const rawResponse = result.response.text();
        // Regex para tirar os blocos de código se a IA mandar (ex ```json ["1"] ```)
        const cleanJson = rawResponse.replace(/```json/gi, '').replace(/```/g, '').trim();
        const keywordsArray = JSON.parse(cleanJson);
        console.log(`[AI Keyword Expansion] Sucesso! Termos: ${JSON.stringify(keywordsArray)}`);
        return keywordsArray;
    } catch (e) {
        console.error("❌ [AI Fallback] Erro na Expansão de Busca JSON:", e);
        // Fallback seguro: Retorna a string bruta encapsulada num array se o JSON.parse quebrar
        // ou se a API der Timeout.
        return userMessage ? [userMessage.trim().substring(0, 50)] : [];
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
SE o usuário enviar apenas uma palavra, um nome solto, uma marca ou um modelo de produto (ex: optima, zagonel, parafuso), a intenção DEVE ser ESTRITAMENTE PRODUCT_SEARCH. Use STORE_FAQ APENAS para perguntas claras sobre horário, localização, telefone ou formas de pagamento.

Mensagem: "${userMessage}"

Retorne APENAS a string "STORE_FAQ" ou "PRODUCT_SEARCH".`;

        const result = await model.generateContent({
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            systemInstruction: { parts: [{ text: "Classificador de intenções estrito. Responda apenas com a tag solicitada." }] }
        });

        const rawResponse = result.response.text();

        // 1. Higienização Prévia
        const cleanRes = rawResponse.trim().replace(/```json|```/gi, '');

        // 2. Fallback de String Crua (Bypass de Parse)
        // O bot.js internamente escuta os retornos 'FAQ' e 'SEARCH'. Mapeamos a string da IA direto para eles.
        if (cleanRes.includes('STORE_FAQ') || cleanRes === 'FAQ') {
            console.log(`[AI Classification Scanner] Intenção Bypassed (Raw String): FAQ`);
            return 'FAQ';
        }
        if (cleanRes.includes('PRODUCT_SEARCH') || cleanRes === 'SEARCH') {
            console.log(`[AI Classification Scanner] Intenção Bypassed (Raw String): SEARCH`);
            return 'SEARCH';
        }

        // Tenta fazer o parse caso o modelo devolva o formato antigo
        const answer = JSON.parse(cleanRes);
        console.log(`[AI Classification Scanner] Intenção Detectada via JSON: ${answer.intent} | Racional: "${answer.explanation || 'N/A'}"`);

        if (answer.intent === 'STORE_FAQ' || answer.intent === 'FAQ') return 'FAQ';
        return 'SEARCH';

    } catch (e) {
        // 3. Try/Catch Seguro com Default
        console.error("❌ [Erro Crítico Pós-Debounce] Falha na Classificação de Intenções JSON:", e);
        // Retorna a intenção primária como default para manter o robô rodando no fluxo de estoque
        return "SEARCH";
    }
}

/**
 * Cruza a descrição visual com os resultados brutos do Fuse.js e extrai os 5 mais prováveis
 * baseados em formato, cor e tipo (Fim da Busca Burra).
 */
async function semanticPreRanking(visualDescription, contextItems) {
    if (!contextItems || contextItems.length === 0) return [];

    // Preparar lista enxuta para o Prompt
    const itemsListTxt = contextItems.map((c, index) => {
        const item = c.item || c;
        const code = item['código'] || item['codigo'] || item.Codigo || index;
        const desc = item['modelo/produto'] || item.Produto || "";
        const tags = item['tags para busca (sinônimos)'] || item['características principais'] || "";
        let line = `ID: ${code} | Nome: ${desc}`;
        if (tags) line += ` | Tags: ${tags}`;
        return line;
    }).join('\n');

    const prompt = `Você atua como um pre-rankeador de banco de dados.
Sua missão: Cruze a descrição da busca/foto recebida com a lista candidata de produtos do nosso estoque. Foque estritamente nas características físicas e de formato (ex: se é redondo, quadrado, haste solta, cor, acabamento).
Retorne APENAS até 8 códigos numéricos (EAN ou ID) separados por vírgula, sem texto adicional e sem blocos de código.
Se houver menos parecidos, retorne os que houverem.

[Descrição da Foto/Busca]: ${visualDescription}

[Lista de Produtos do Estoque]:
${itemsListTxt}`;

    try {
        const result = await model.generateContent({
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            systemInstruction: { parts: [{ text: "Processador de Dados. Responda ESTRITAMENTE com os IDs separados por vírgula. Zero conversação." }] }
        });

        const rawText = result.response.text().trim();
        // Bug Fix: Regex estrito para capturar apenas blocos numéricos de 7 a 14 dígitos (EANs) ignorando lixo Markdown/Texto
        const ids = rawText.match(/\d{7,14}/g) || [];

        if (ids.length === 0) {
            console.log("[Semantic Pre-Ranking] Nenhum ID numérico detectado na resposta da IA. Retornando os padrões integrais.");
            return contextItems.slice(0, 8);
        }

        const refinedItems = [];
        const seenCodes = new Set();

        // 1. Prioriza os que a IA escolheu
        for (const id of ids) {
            const found = contextItems.find(c => {
                const item = c.item || c;
                const code = item['código'] || item['codigo'] || item.Codigo;
                return code && code.toString() === id.toString();
            });

            if (found) {
                const uniqueCode = (found.item || found)['código'] || (found.item || found)['codigo'] || (found.item || found).Codigo;
                if (!seenCodes.has(uniqueCode)) {
                    seenCodes.add(uniqueCode);
                    refinedItems.push(found);
                }
            }
        }

        // 2. Completa com os itens do topo do Fuse.js caso a IA não retorne 8 (Garante o fluxo de amostragem longo para o Oráculo Visual)
        for (const c of contextItems) {
            if (refinedItems.length >= 8) break;
            const item = c.item || c;
            const uniqueCode = item['código'] || item['codigo'] || item.Codigo;
            if (uniqueCode && !seenCodes.has(uniqueCode)) {
                seenCodes.add(uniqueCode);
                refinedItems.push(c);
            }
        }

        console.log(`[Semantic Pre-Ranking] Sucesso! Filtrou as opções do DB para: ${refinedItems.map(r => {
            const item = r.item || r;
            return item['código'] || item['codigo'] || item['ean'] || item.Codigo || item['modelo/produto'] || item.Produto || 'N/A';
        }).join(', ')}`);
        return refinedItems.slice(0, 8); // Passa a amostragem máxima para o Oracle Visual


    } catch (e) {
        console.error("Erro no Semantic Pre-Ranking:", e);
        return contextItems.slice(0, 5); // Fallback seguro
    }
}

/**
 * Naturaliza a pergunta de triagem formatada crua da planilha
 */
async function naturalizeTriageQuestion(category, rawInstructions) {
    if (!rawInstructions) return "Qual modelo ou marca você prefere?";

    try {
        const prompt = `O usuário está buscando um produto da categoria '${category}'.
Sua única tarefa é formular UMA (1) pergunta rápida, direta, prestativa e amigável baseada nestas diretrizes operacionais: "${rawInstructions}".
LEIA AS DIRETRIZES. Escolha NO MÁXIMO 1 ou 2 perguntas cruciais. NUNCA faça um interrogatório longo. 
SE houver uma recomendação ou dica (ex: "mandar foto" ou "trazer a peça"), você DEVE obrigatoriamente separar a sua resposta usando o delimitador exato |||. 
NÃO use vocabulário complexo. NÃO diga "bom dia/boa tarde". NÃO diga que vai repassar para um atendente.
Exemplo ruim: "Irei repassar ao humano, mas antes me diga qual o formato do vaso, ou me mande uma foto da peça."
Exemplo excelente: "Para qual modelo de vaso seria? Saberia me dizer a cor? ||| Se puder mandar uma foto da peça, ajuda bastante!"`;

        const result = await model.generateContent({
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            systemInstruction: { parts: [{ text: "Você é um atendente rápido de WhatsApp transformando instruções engessadas em perguntas naturais limitadas a 2. Use ||| apenas para separar recomendações de envio de mídia." }] }
        });

        const naturalText = result.response.text().trim();
        console.log(`[Triage AI] Instrução '${rawInstructions}' -> Naturalizada: '${naturalText}'`);
        return naturalText;
    } catch (e) {
        console.error("Erro ao naturalizar pergunta de triagem:", e);
        // Fallback: tenta pegar a primeira frase do raw e limpar
        return rawInstructions.split(/(?:\r?\n|;)/)[0] || "Saberia me dar mais detalhes sobre o modelo?";
    }
}

module.exports = {
    generateResponse,
    transcribeAudio,
    extractImageKeywords,
    verifyProductImageWithCatalog,
    expandSearchQuery,
    classifyIntent,
    semanticPreRanking,
    naturalizeTriageQuestion
};
