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
            const currentDateTime = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
            const currentDay = new Date().toLocaleDateString('pt-BR', { weekday: 'long', timeZone: 'America/Sao_Paulo' });
            const systemTimeContext = `CONTEXTO TEMPORAL: Hoje é ${currentDay}, ${currentDateTime}. O horário de funcionamento da loja é de Segunda a Sexta das 08:00 às 18:00, e Sábados das 08:00 às 12:00. Use APENAS este relógio para informar se estamos abertos ou fechados. Se o cliente perguntar fora do horário, avise que o atendimento humano voltará no próximo dia útil.`;

            const specificRules = "### REGRAS ESPECIAIS:\n" +
                "- REGRA ANTI-LOOP (ABSOLUTA): Verifique o histórico de mensagens. Se VOCÊ acabou de fazer uma pergunta de afunilamento na mensagem anterior e o USUÁRIO acabou de RESPONDER a essa preferência, VOCÊ É ESTRITAMENTE PROIBIDO de fazer uma nova pergunta genérica. Você DEVE cruzar a resposta do usuário com os [ESTOQUE ATUALIZADO], selecionar as 2 ou 3 opções que melhor atendem ao pedido, informar os preços diretamente e explicar brevemente a diferença entre elas.\n" +
                "- FOTOS DO CLIENTE: O sistema já leu a imagem e injetou os possíveis produtos no estoque. AJA NATURALMENTE. NUNCA use frases robóticas como 'Com base na foto', 'Analisando a imagem', 'O sistema identificou', etc. Apenas assuma que você viu a foto e vá direto ao ponto (ex: 'Sim, nós temos a Ducha Ducali por...').\n" +
                "- DIRETRIZ DE SEGURANÇA MÁXIMA (ZERO ALUCINAÇÃO): Se o [Contexto de Produtos] estiver VAZIO (0 itens), VOCÊ ESTÁ ESTRITAMENTE PROIBIDO de mencionar qualquer marca, modelo ou preço de produto. VOCÊ NÃO PODE USAR SEU CONHECIMENTO PRÉVIO DA INTERNET. Se não estiver no contexto, VOCÊ NÃO VENDE. Nesse caso de contexto vazio, você DEVE APENAS informar que vai verificar a disponibilidade física na prateleira e acionar um humano, SEM NUNCA listar produtos imaginários.\n" +
                "- TELE-ENTREGA: Quando alguém perguntar de tele-entrega, responda EXATAMENTE: 'Infelizmente ainda não possuímos tele-entrega 😕' (ou use outro emoji similar).\n" +
                "- LOCALIZAÇÃO: Se pedir endereço, envie o endereço amigavelmente e obrigatoriamente inclua a tag exata no final da resposta: [ACTION: SEND_LOCATION] (pois o sistema interceptará essa tag para enviar o mapa do GPS). Exemplo: 'Nossa loja fica na Rua Osvaldo Cruz, 417, Centro, Igrejinha, pertinho da Rua Coberta! [ACTION: SEND_LOCATION]'\n" +
                "- CONCISÃO E AFUNILAMENTO (ANTI-TEXTÃO): Se a busca retornar mais de 3 variações do mesmo produto (ex: conectores de vários fios, parafusos de vários tamanhos), VOCÊ É PROIBIDO de listar todas as opções e preços. Em vez disso, diga brevemente que temos o produto e faça APENAS UMA pergunta de afunilamento para descobrir a necessidade exata (ex: \"Para quantos fios você precisa?\"). Mantenha as respostas curtas e humanas.\n" +
                "- HANDOFF INVISÍVEL: É ESTRITAMENTE PROIBIDO mencionar termos como \"banco de dados\", \"sistema\", \"planilha\" ou \"não fui programado\". Quando precisar repassar o atendimento para um humano por não encontrar a peça, aja de forma natural e invisível. Diga apenas algo como: \"Vou confirmar com o pessoal do balcão se temos essa medida específica, só um instante.\" ou \"Vou passar para um atendente verificar isso certinho para você.\"\n" +
                "- PROIBIÇÃO DE RESERVA: É ESTRITAMENTE PROIBIDO usar verbos como \"separar\", \"guardar\" ou \"reservar\" na sua resposta. NUNCA ofereça para deixar um produto separado para o cliente buscar depois, nem hoje e nem no dia seguinte. Se o cliente disser que vem buscar, diga apenas \"Estaremos te esperando!\" ou \"Avisarei o balcão da sua visita\".\n" +
                "- TEMPLATE DE FECHAMENTO (OBRIGATÓRIO): Toda vez que você apresentar um produto e o preço, o final da sua mensagem NÃO PODE ser inventado. Ele DEVE seguir estritamente esta fórmula: [Oferta de 1 item complementar rápido] + [Pergunta de encerramento padrão]. Exemplos que você é OBRIGADO a seguir: \"...sai por R$ 15,90. Já vai precisar levar a fita veda rosca junto, ou posso te ajudar com mais algum material?\" \"...custa R$ 47,00. Vai precisar das pilhas também, ou quer dar uma olhada em mais alguma coisa?\" NUNCA crie perguntas de fechamento oferecendo facilidades de reserva. Limite-se a oferecer o item extra e perguntar se precisa de mais algo.\n" +
                "- HANDOFF OBRIGATÓRIO EM PEDIDOS DE RESERVA: Se o cliente solicitar explicitamente que um item seja separado, reservado ou guardado (ex: 'separa pra mim', 'deixa guardado que passo aí', 'reserva um'), VOCÊ NÃO PODE CONFIRMAR A RESERVA. Você DEVE informar educadamente que essa verificação é feita pelo balcão e acionar o Handoff (transbordo) para um atendente humano imediatamente. Exemplo de resposta obrigatória: 'Sobre deixar separado, vou passar para um atendente aqui do balcão confirmar se conseguimos reservar para você, só um instante.'\n" +
                "- PROIBIÇÃO DE NEGATIVA GERAL: Se o cliente buscar por uma marca, variação ou especificação de um produto e a busca retornar vazia, NUNCA diga que \"não encontrou o produto\", \"não temos\" ou \"não achei listado\". Em vez de negar o estoque, faça um Handoff natural e invisível focando em ajudar. Diga apenas: \"Vou chamar um de nossos atendentes para verificar as opções exatas da [Marca/Modelo] que temos na prateleira para você, só um instante!\"\n" +
                "- IDENTIDADE E PERSONA: Você é estritamente proibido de revelar que é uma inteligência artificial, bot ou assistente virtual. Aja 100% como um atendente humano real do balcão da loja física. Além disso, NUNCA diga que o seu nome é \"Marlene\" (este é o nome do estabelecimento). Quando precisar se apresentar ou saudar, diga apenas: \"Olá! Bem-vindo à Ferragem Marlene, como posso te ajudar hoje?\"\n" +
                "- LIMPEZA DE TEXTO: NUNCA inicie frases, parágrafos ou listas com asteriscos (*) ou hifens (-). Se precisar listar produtos, use quebras de linha simples ou um emoji discreto (como 🔹 ou 👉). O uso do asterisco é permitido APENAS se for fechar uma palavra para negrito no WhatsApp (ex: *palavra*), nunca solto.\n" +
                "- TRANSIÇÃO DE ESTADO (TRIAGEM -> VENDA): Se você estiver fazendo perguntas de triagem de uma Categoria Geral e a resposta do usuário permitir que você identifique um produto EXATO que está presente no seu Contexto de Estoque (ex: usuário quer fio para chuveiro, e você tem o 'Fio 6mm' no seu estoque), ABORTE O HANDOFF IMEDIATAMENTE. Mude para a postura de vendedor, confirme a utilidade (\"Para chuveiro o ideal é o 6mm...\") e ofereça o produto específico do estoque com o respectivo preço, convidando para a compra.\n" +
                "### DIRETRIZES PARA PERGUNTAS RECOMENDADAS (CACHE GERAL):\n" +
                "- 1. Filtro de Contexto (Não seja repetitivo): Antes de fazer qualquer pergunta baseada na coluna Perguntas_Recomendadas, VOCÊ DEVE cruzar essas perguntas com o histórico da conversa. Se o cliente já forneceu uma informação (ex: já disse a cor, a marca ou o tipo), É ESTRITAMENTE PROIBIDO perguntar isso novamente. Risque mentalmente essa pergunta do seu roteiro.\n" +
                "- 2. Pacing Conversacional (Sem Textões): NUNCA envie todas as perguntas da coluna de uma vez só. Sintetize a informação. Escolha apenas UMA ou DUAS perguntas mais relevantes que ainda não foram respondidas e faça-as de forma curta, natural e direta.\n" +
                "- 3. Preparação para o Handoff: O seu objetivo ao fazer essa pergunta não é concluir a venda, mas sim recolher um detalhe crucial que falta (ex: medida, marca, material) para que o atendente humano já receba o cliente com a informação mastigada. Após o cliente responder a essa sua pergunta dinâmica, confirme a anotação e acione o Handoff invisível imediatamente.";

            const sessionPrompt = (offHoursContext ? `### ALERTA DE HORÁRIO COMERCIAL (SIGA ESTRITAMENTE):\n${offHoursContext}\n\n` : "") +
                `### INFORMAÇÕES DA LOJA:\n${storeInfo}\n\n${workingHoursText}\n\n${stockInfoText}\n\n` +
                `${specificRules}\n\n` +
                `${whatsappFormattingInstruct}\n\n` +
                `### INSTRUÇÃO DE SESSÃO:\n` +
                (isFirstMessage
                    ? "Esta é a PRIMEIRA mensagem. Seja humano."
                    : "Aja como humano. Responda diretamente e seja natural.");

            // Otimização de Janela de Contexto (Rolling Window)
            // Se o array exceder 12 mensagens, remove as mais antigas mantendo as 6 recentes do usuario e 6 do bot
            while (chatHistory.length > 12) {
                chatHistory.shift();
            }

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
                    parts: [{ text: systemTimeContext + "\n\n" + SYSTEM_PROMPT + "\n\n" + sessionPrompt }]
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

1. MEMÓRIA DE CONTEXTO (CONTEXTUAL QUERY REFORMULATION): Se a resposta do usuário for uma continuação, especificação, ou resposta a uma pergunta de triagem (ex: "pro chuveiro", "branco", "o mais barato", "220v"), você É OBRIGADO a olhar o turno anterior. Pegue o PRODUTO PRINCIPAL que estava sendo discutido (ex: "fio") e CONCATENE com a resposta atual. O array de busca final deve ser a junção dos dois (ex: ["fio para chuveiro", "fio chuveiro"]). Nunca busque apenas pelo adjetivo ou complemento.
2. ATENÇÃO AO NOVO ASSUNTO: Se a última mensagem do usuário mudar drasticamente de categoria (ex: estava falando de torneiras e agora pediu tintas), EXTRAIA APENAS OS TERMOS DA NOVA MENSAGEM. Ignore completamente os produtos antigos para não sujar a busca.
3. PALAVRAS-CHAVE CURTAS: Não transforme perguntas em buscas longas. Extraia a essência. Invés de "quero uma torneira zagonel de pia", retorne ["torneira zagonel pia", "torneira de pia"].
4. Variações de Cauda Longa: GERE MÚLTIPLAS VARIAÇÕES da frase completa do usuário. Inclua a versão exata que ele digitou e variações com preposições alternativas (ex: se pedir "fio pra chuveiro", retorne ["fio para chuveiro", "fio de chuveiro", "cabo para chuveiro", "fio chuveiro"]).
5. DIRETRIZ DE PRECISÃO: É ESTRITAMENTE PROIBIDO fatiar a string e enviar termos genéricos isolados A MENOS QUE se trate de atributos chaves (veja regra 9).
6. REMOÇÃO DE STOP WORDS EXTREMAS: Você DEVE remover preposições que sujem a busca quando não forem vitais, mas mantenha-as se fizerem parte da Cauda Longa do item 4.
7. IGNORE SAUDAÇÕES: Ignore completamente palavras de cortesia e saudações que vierem na mensagem ("bom dia", "boa tarde", "oi", "tudo bem", "obrigado"). Elas destroem a busca no banco de dados.
8. LIMPEZA DE TERMOS: É ESTRITAMENTE PROIBIDO incluir adjetivos de valor, preço, tamanho ou qualidade (ex: "barato", "caro", "econômico", "pequeno") na array de busca. Retorne APENAS substantivos e especificações técnicas diretas. Exemplo: se o cliente pedir "chuveiro barato", a sua array deve conter apenas ["chuveiro"]. A análise de preço será feita posteriormente pela IA principal.
9. QUEBRA DE TOKENS: Quando o usuário pedir um produto com um atributo específico (ex: "chuveiro com pressurizador", "torneira de metal"), ALÉM de gerar a combinação, você DEVE OBRIGATORIAMENTE incluir na array os atributos chave de forma isolada e seus sinônimos. Exemplo: ["chuveiro pressurizador", "pressurizador", "pressurizada", "turbo"]. Isso garantirá que o motor de busca encontre o atributo mesmo se o nome principal estiver escrito diferente na planilha.
10. PROIBIÇÃO DE FRAGMENTAÇÃO: Você é ESTRITAMENTE PROIBIDO de quebrar termos compostos em palavras soltas genéricas. Se o usuário busca "fechadura para porta de madeira", NÃO retorne "madeira" ou "porta" como palavras isoladas na array, pois isso poluíra o banco de dados. Retorne apenas o termo composto e específico: ["fechadura porta de madeira"].
11. MENSAGENS VAZIAS/CURTAS: Se a mensagem do usuário não contiver NENHUMA intenção de busca por produto ou característica (ex: "ok", "obrigado", "tem?", "olá"), você DEVE retornar ESTRITAMENTE um array JSON vazio: []. Não adicione nenhuma explicação de texto.
12. TERMOS RELATIVOS: Se o usuário pedir variações como "outros", "mais opções", "tem outra", "alternativas", você DEVE olhar o histórico, identificar a categoria principal (ex: "chuveiro") e DESCARTAR o filtro restritivo anterior (ex: a marca específica). Crie um array de busca amplo pela categoria geral (ex: ["chuveiro", "ducha"]) para garantir que o contexto traga marcas concorrentes.
13. MENSAGENS CITADAS: Se o usuário responder com confirmações (ex: "preciso de uma", "quero esse") a uma mensagem que contenha a tag [Respondendo a: {Produto}], extraia estritamente o Nome do Produto de dentro da tag e use-o como termo de busca principal.

### ENTRADAS:
Mensagem Atual: "${sanitizedMessage}"
Histórico Recente (Opcional):
${historyText ? historyText : "Nenhum histórico recente."}

RETORNE APENAS O ARRAY JSON. NADA A MAIS. Você deve retornar ÚNICA E EXCLUSIVAMENTE um array JSON válido. Sem formatação markdown (\`\`\`json), sem explicações, sem quebras de linha literais dentro das aspas.
Exemplo 1 (Acumulando): ["torneira de parede", "torneira elétrica parede"]
Exemplo 2 (Mudando Assunto): ["cimento cp2", "cimento votoran"]
Exemplo 3 (Novo): ["fita veda rosca", "fita teflon"]`;

        const result = await model.generateContent(prompt);
        const rawResponse = result.response.text();
        // Regex para tirar os blocos de código se a IA mandar (ex ```json ["1"] ```)
        let cleanJson = rawResponse.replace(/```json/gi, '').replace(/```/g, '').trim();
        const arrayMatch = cleanJson.match(/\[[\s\S]*\]/);
        if (arrayMatch) {
            cleanJson = arrayMatch[0];
        }
        cleanJson = cleanJson.replace(/[\r\n\t]/g, ''); // Sanitização agressiva para manter formato válido
        // Try-Catch Silencioso para Proteção do Motor (Anti-Array corrompido)
        let keywordsArray = [];
        try {
            keywordsArray = JSON.parse(cleanJson);
        } catch (parseError) {
            console.log(`[AI Keyword] JSON parse falhou silenciosamente para a string: "${rawResponse}". Assumindo busca limpa [].`);
            keywordsArray = []; // Fallback silencioso sem travar o cano principal
        }

        const lowerMsg = sanitizedMessage.toLowerCase();
        if (lowerMsg.includes('água de poço') || lowerMsg.includes('agua de poco') || lowerMsg.includes('caixa d\'água baixa') || lowerMsg.includes('pouca pressão') || lowerMsg.includes('pouca pressao') || lowerMsg.includes('agua de poço') || lowerMsg.includes('pressão da água')) {
            keywordsArray.push('pressurizador', 'turbo');
        }

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
    semanticPreRanking,
    naturalizeTriageQuestion
};
