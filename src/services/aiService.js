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
 * @param {Array} audioParts - Arrays with audio files { inlineData... }
 * @param {Array} chatHistory - Previous messages
 * @param {Array} stockContext - Products available/relevant
 * @param {Function} onWait - Optional callback when waiting for Rate Limits
 */
async function generateResponse(userText, imageParts, audioParts, chatHistory, stockContext, onWait = null, offHoursContext = null, dailyGreetingContext = null) {
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
                    ? "### ESTOQUE: O contexto não retornou itens específicos para essa busca. Você DEVE agir como se fosse verificar com o pessoal do balcão. NUNCA diga que 'não encontrou', 'não identificou' ou 'não temos'. Diga apenas que vai passar para um atendente verificar as opções exatas desse produto na prateleira."
                    : "### ESTOQUE: O contexto não retornou itens. Você DEVE acionar a transferência para um atendente humano imediatamente. Diga APENAS que vai repassar para o pessoal do balcão verificar. NUNCA negue a existência do produto.");

            const isFirstMessage = chatHistory.length <= 1; // includes current message

            // 1. Relógio Blindado e Injeção de Contexto de Tempo
            const nowTime = new Date();
            const timeFormatter = new Intl.DateTimeFormat('pt-BR', {
                timeZone: 'America/Sao_Paulo',
                hour: '2-digit', minute: '2-digit', hour12: false
            });
            const dayFormatter = new Intl.DateTimeFormat('pt-BR', {
                timeZone: 'America/Sao_Paulo',
                weekday: 'long'
            });

            // ISO FORMATTING PARA CALENDÁRIO NO FUSO SP
            const yearFormatter = new Intl.DateTimeFormat('en-CA', { // en-CA gives YYYY-MM-DD
                timeZone: 'America/Sao_Paulo',
                year: 'numeric', month: '2-digit', day: '2-digit'
            });
            const currentDateIso = yearFormatter.format(nowTime); // ex: '2026-04-03'

            const currentTimeStr = timeFormatter.format(nowTime);
            let currentDayStr = dayFormatter.format(nowTime);
            // Capitalize first letter
            currentDayStr = currentDayStr.charAt(0).toUpperCase() + currentDayStr.slice(1);

            const nowParts = currentTimeStr.split(':');
            const currentTotal = parseInt(nowParts[0]) * 60 + parseInt(nowParts[1]);

            // Formatação do Dia (0 = Domingo) compatível com o getDay() local do settings
            const localDateForDay = new Date(nowTime.toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }));
            const currentDayOfWeekly = localDateForDay.getDay();

            let storeStatusStr = "FECHADA";
            let nextOpenStr = "";
            let holidayReason = "";

            // PRIORIDADE MÁXIMA: Verificação do array storeExceptions
            let isExceptionDay = false;
            let targetException = null;

            try {
                const exceptionsPath = path.join(__dirname, '../../data/store_exceptions.json');
                if (fs.existsSync(exceptionsPath)) {
                    const storeExceptions = JSON.parse(fs.readFileSync(exceptionsPath, 'utf8'));
                    targetException = storeExceptions.find(ex => ex.date === currentDateIso);
                    if (targetException) {
                        isExceptionDay = true;
                    }
                }
            } catch (err) {
                console.error("[Calendário de Exceções] Falha ao ler store_exceptions.json:", err);
            }

            if (isExceptionDay) {
                if (targetException.type === 'horario_especial' && targetException.specialHours) {
                    // Horário Especial: verifica se está dentro das horas customizadas
                    const [openH, openM] = targetException.specialHours.open.split(':').map(Number);
                    const [closeH, closeM] = targetException.specialHours.close.split(':').map(Number);
                    const openTotal = openH * 60 + openM;
                    const closeTotal = closeH * 60 + closeM;

                    if (currentTotal >= openTotal && currentTotal < closeTotal) {
                        storeStatusStr = "ABERTA (Horário Especial)";
                        holidayReason = targetException.reason;
                    } else {
                        storeStatusStr = "FECHADA";
                        holidayReason = targetException.reason;
                        if (currentTotal < openTotal) {
                            nextOpenStr = `hoje às ${targetException.specialHours.open} (horário especial)`;
                        } else {
                            nextOpenStr = "amanhã às 08:00";
                        }
                    }
                } else {
                    // Dia Fechado (tipo padrão)
                    storeStatusStr = "FECHADA (Feriado/Evento)";
                    holidayReason = targetException.reason;
                    nextOpenStr = targetException.returnDate;
                }
            } else {
                // Lógica Rotineira Padrão (Sem Feriados)
                // Lógica de Segunda a Sexta (Dias 1 a 5)
                if (currentDayOfWeekly >= 1 && currentDayOfWeekly <= 5) {
                    if ((currentTotal >= 480 && currentTotal < 720) || (currentTotal >= 810 && currentTotal < 1140)) {
                        storeStatusStr = "ABERTA";
                    } else if (currentTotal < 480) {
                        nextOpenStr = "hoje às 08:00";
                    } else if (currentTotal >= 720 && currentTotal < 810) {
                        nextOpenStr = "hoje às 13:30"; // Horário de Almoço
                    } else {
                        nextOpenStr = currentDayOfWeekly === 5 ? "amanhã (sábado) às 08:00" : "amanhã às 08:00";
                    }
                }
                // Lógica de Sábado (Dia 6)
                else if (currentDayOfWeekly === 6) {
                    if ((currentTotal >= 480 && currentTotal < 720) || (currentTotal >= 840 && currentTotal < 1050)) {
                        storeStatusStr = "ABERTA";
                    } else if (currentTotal < 480) {
                        nextOpenStr = "hoje às 08:00";
                    } else if (currentTotal >= 720 && currentTotal < 840) {
                        nextOpenStr = "hoje às 14:00"; // Horário de Almoço de Sábado
                    } else {
                        nextOpenStr = "segunda-feira às 08:00";
                    }
                }
                // Lógica de Domingo (Dia 0)
                else {
                    nextOpenStr = "segunda-feira às 08:00";
                }
            }

            // Montagem inteligente da frase
            let systemTimeContext = "";

            if (isExceptionDay) {
                if (storeStatusStr.includes('ABERTA (Horário Especial)')) {
                    systemTimeContext = `[SISTEMA: Hoje é ${currentDayStr}, ${currentTimeStr}. Hoje é dia de ${holidayReason}, mas a loja está ABERTA em horário especial (${targetException.specialHours.open} às ${targetException.specialHours.close}). Informe o horário reduzido ao cliente com naturalidade se for relevante.]`;
                } else if (storeStatusStr === 'FECHADA' && holidayReason) {
                    let closedMsg = `A loja está FECHADA devido a: ${holidayReason}.`;
                    if (nextOpenStr) closedMsg += ` Só retornaremos o atendimento em: ${nextOpenStr}.`;
                    systemTimeContext = `[SISTEMA: Hoje é ${currentDayStr}, ${currentTimeStr}. ${closedMsg} Informe isso ao cliente com naturalidade.]`;
                } else {
                    systemTimeContext = `[SISTEMA: Hoje é ${currentDayStr}, ${currentTimeStr}. A loja está FECHADA devido ao feriado/motivo: ${holidayReason}. Só retornaremos o atendimento em: ${nextOpenStr}. Informe isso ao cliente com naturalidade.]`;
                }
            } else {
                let openingPhrase = '';
                if (storeStatusStr === 'FECHADA') {
                    openingPhrase = ' Só abriremos ' + nextOpenStr + '.';
                }
                systemTimeContext = `[SISTEMA: Hoje é ${currentDayStr}, ${currentTimeStr}. A loja está atualmente ${storeStatusStr}.${openingPhrase} Use APENAS esta informação como relógio oficial.]`;
            }

            const specificRules = "### REGRAS ESPECIAIS:\n" +
                "- REGRA ANTI-LOOP (ABSOLUTA): Verifique o histórico de mensagens. Se VOCÊ acabou de fazer uma pergunta de afunilamento na mensagem anterior e o USUÁRIO acabou de RESPONDER a essa preferência, VOCÊ É ESTRITAMENTE PROIBIDO de fazer uma nova pergunta genérica. Você DEVE cruzar a resposta do usuário com os [ESTOQUE ATUALIZADO], selecionar as 2 ou 3 opções que melhor atendem ao pedido, informar os preços diretamente e explicar brevemente a diferença entre elas.\n" +
                "- FOTOS DO CLIENTE: O sistema já leu a imagem e injetou os possíveis produtos no estoque. AJA NATURALMENTE. NUNCA use frases robóticas como 'Com base na foto', 'Analisando a imagem', 'O sistema identificou', etc. Apenas assuma que você viu a foto e vá direto ao ponto (ex: 'Sim, nós temos a Ducha Ducali por...').\n" +
                "- DIRETRIZ DE SEGURANÇA MÁXIMA (ZERO ALUCINAÇÃO): Se o [Contexto de Produtos] estiver VAZIO (0 itens), VOCÊ ESTÁ ESTRITAMENTE PROIBIDO de mencionar qualquer marca, modelo ou preço de produto. VOCÊ NÃO PODE USAR SEU CONHECIMENTO PRÉVIO DA INTERNET. Se não estiver no contexto, VOCÊ NÃO VENDE. Nesse caso de contexto vazio, você DEVE APENAS informar que vai verificar a disponibilidade física na prateleira e acionar um humano, SEM NUNCA listar produtos imaginários.\n" +
                "- TELE-ENTREGA: Quando alguém perguntar de tele-entrega, responda EXEMPLO: 'Infelizmente ainda não possuímos tele-entrega 😕' (ou use outro emoji similar).\n" +
                "- LOCALIZAÇÃO: Se pedir endereço, envie o endereço amigavelmente e obrigatoriamente inclua a tag exata no final da resposta: [ACTION: SEND_LOCATION] (pois o sistema interceptará essa tag para enviar o mapa do GPS). Exemplo: 'Nossa loja fica na Rua Osvaldo Cruz, 417, Centro, Igrejinha, pertinho da Rua Coberta! [ACTION: SEND_LOCATION]'\n" +
                "- CONCISÃO E AFUNILAMENTO (ANTI-TEXTÃO): Se a busca retornar mais de 3 variações do mesmo produto (ex: conectores de vários fios, parafusos de vários tamanhos), VOCÊ É PROIBIDO de listar todas as opções e preços. Em vez disso, diga brevemente que temos o produto e faça APENAS UMA pergunta de afunilamento para descobrir a necessidade exata (ex: \"Para quantos fios você precisa?\"). Mantenha as respostas curtas e humanas.\n" +
                "- HANDOFF INVISÍVEL: É ESTRITAMENTE PROIBIDO mencionar termos como \"banco de dados\", \"sistema\", \"planilha\" ou \"não fui programado\". Quando precisar repassar o atendimento para um humano por não encontrar a peça, aja de forma natural e invisível. Diga apenas algo como: \"Vou confirmar com o pessoal do balcão se temos essa medida específica, só um instante.\" ou \"Vou passar para um atendente verificar isso certinho para você.\"\n" +
                "- PROIBIÇÃO DE RESERVA: É ESTRITAMENTE PROIBIDO usar verbos como \"separar\", \"guardar\" ou \"reservar\" na sua resposta. NUNCA ofereça para deixar um produto separado para o cliente buscar depois, nem hoje e nem no dia seguinte. Se o cliente disser que vem buscar, diga apenas \"Estaremos te esperando!\" ou \"Avisarei o balcão da sua visita\".\n" +
                "- TEMPLATE DE FECHAMENTO (OBRIGATÓRIO): Toda vez que você apresentar um produto e o preço, o final da sua mensagem NÃO PODE ser inventado. Ele DEVE seguir estritamente esta fórmula: [Oferta de 1 item complementar rápido] + [Pergunta de encerramento padrão]. Exemplos que você é OBRIGADO a seguir: \"...sai por R$ 15,90. Já vai precisar levar a fita veda rosca junto, ou posso te ajudar com mais algum material?\" \"...custa R$ 47,00. Vai precisar das pilhas também, ou quer dar uma olhada em mais alguma coisa?\" NUNCA crie perguntas de fechamento oferecendo facilidades de reserva. Limite-se a oferecer o item extra e perguntar se precisa de mais algo.\n" +
                "- HANDOFF OBRIGATÓRIO EM PEDIDOS DE RESERVA: Se o cliente solicitar explicitamente que um item seja separado, reservado ou guardado (ex: 'separa pra mim', 'deixa guardado que passo aí', 'reserva um'), VOCÊ NÃO PODE CONFIRMAR A RESERVA. Você DEVE informar educadamente que essa verificação é feita pelo balcão e acionar o Handoff (transbordo) para um atendente humano imediatamente. Exemplo de resposta obrigatória: 'Sobre deixar separado, vou passar para um atendente aqui do balcão confirmar se conseguimos reservar para você, só um instante.'\n" +
                "- PROIBIÇÃO DE NEGATIVA GERAL: Se o cliente buscar por uma marca, variação ou especificação de um produto e a busca retornar vazia, NUNCA diga que \"não encontrou\", \"não identificou\", \"não temos\", \"não achei listado\" ou \"não consegui identificar\". Em vez de negar o estoque, faça um Handoff natural e invisível focando em ajudar. Diga apenas: \"Vou passar para um atendente verificar essa questão desse produto pra você, só um instante!\" Se o cliente pedir outro produto enquanto o anterior está pendente, atenda normalmente e lembre que o anterior já está sendo verificado.\n" +
                "- IDENTIDADE E PERSONA: Você é estritamente proibido de revelar que é uma inteligência artificial, bot ou assistente virtual. Aja 100% como um atendente humano real do balcão da loja física. Além disso, NUNCA diga que o seu nome é \"Marlene\" (este é o nome do estabelecimento). Quando precisar se apresentar ou saudar, diga apenas: \"Olá! Bem-vindo à Ferragem Marlene, como posso te ajudar hoje?\"\n" +
                "- LIMPEZA DE TEXTO: NUNCA inicie frases, parágrafos ou listas com asteriscos (*) ou hifens (-). Se precisar listar produtos, use quebras de linha simples ou um emoji discreto (como 🔹 ou 👉). O uso do asterisco é permitido APENAS se for fechar uma palavra para negrito no WhatsApp (ex: *palavra*), nunca solto.\n" +
                "- TRANSIÇÃO DE ESTADO (TRIAGEM -> VENDA): Se você estiver fazendo perguntas de triagem de uma Categoria Geral e a resposta do usuário permitir que você identifique um produto EXATO que está presente no seu Contexto de Estoque (ex: usuário quer fio para chuveiro, e você tem o 'Fio 6mm' no seu estoque), ABORTE O HANDOFF IMEDIATAMENTE. Mude para a postura de vendedor, confirme a utilidade (\"Para chuveiro o ideal é o 6mm...\") e ofereça o produto específico do estoque com o respectivo preço, convidando para a compra.\n" +
                "### DIRETRIZES PARA PERGUNTAS RECOMENDADAS (CACHE GERAL):\n" +
                "- 1. Filtro de Contexto (Não seja repetitivo): Antes de fazer qualquer pergunta baseada na coluna Perguntas_Recomendadas, VOCÊ DEVE cruzar essas perguntas com o histórico da conversa. Se o cliente já forneceu uma informação (ex: já disse a cor, a marca ou o tipo), É ESTRITAMENTE PROIBIDO perguntar isso novamente. Risque mentalmente essa pergunta do seu roteiro.\n" +
                "- 2. Pacing Conversacional (Sem Textões): NUNCA envie todas as perguntas da coluna de uma vez só. Sintetize a informação. Escolha apenas UMA ou DUAS perguntas mais relevantes que ainda não foram respondidas e faça-as de forma curta, natural e direta.\n" +
                "- 3. Preparação para o Handoff: O seu objetivo ao fazer essa pergunta não é concluir a venda, mas sim recolher um detalhe crucial que falta (ex: medida, marca, material) para que o atendente humano já receba o cliente com a informação mastigada. Após o cliente responder a essa sua pergunta dinâmica, confirme a anotação e acione o Handoff invisível imediatamente.\n" +
                "- [INTERPRETAÇÃO FONÉTICA]: Se o cliente escrever palavras com erros ortográficos (como 'acento'), use o contexto da loja para deduzir o item correto (assento sanitário). Responda com a grafia correta de forma natural e empática, NUNCA corrigindo o cliente ou mencionando o erro de digitação.\n" +
                "- [REGRA DE PRECIFICAÇÃO]: VOCÊ É ESTRITAMENTE PROIBIDO DE INVENTAR OU DEDUZIR PREÇOS. Se o preço exato do produto solicitado não estiver no bloco [Itens no Contexto], você DEVE dizer que precisa confirmar o valor no sistema. Jamais utilize seu conhecimento prévio para dar preços.\n" +
                "- [MÚLTIPLOS ITENS - REFORÇO]: Se o cliente pediu vários produtos e o contexto contém resultados para APENAS ALGUNS, APRESENTE os encontrados normalmente (com preço e foto) e para os que NÃO estão no contexto diga que vai verificar com o balcão. NUNCA faça handoff total quando há itens parciais encontrados. A VENDA dos itens encontrados tem prioridade absoluta.";

            const sessionPrompt = (offHoursContext ? `### ALERTA DE HORÁRIO COMERCIAL (SIGA ESTRITAMENTE):\n${offHoursContext}\n\n` : "") +
                `### INFORMAÇÕES DA LOJA:\n${storeInfo}\n\n${stockInfoText}\n\n` +
                `${specificRules}\n\n` +
                `${whatsappFormattingInstruct}\n\n` +
                `### INSTRUÇÃO DE SESSÃO E IDENTIDADE:\n` +
                (dailyGreetingContext ? `${dailyGreetingContext}\n` : "") +
                (isFirstMessage
                    ? "Esta é a PRIMEIRA mensagem que o bot recebe no banco de dados, mas baseie-se estritamente na regra de saudação (dailyGreetingContext) fornecida acima se já houveram conversas hoje."
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

            // Append ALL media to the LAST user message
            if ((imageParts.length > 0 || audioParts.length > 0) && contents.length > 0 && contents[contents.length - 1].role === 'user') {
                for (const img of imageParts) {
                    contents[contents.length - 1].parts.push(img);
                }
                for (const aud of audioParts) {
                    contents[contents.length - 1].parts.push(aud);
                }
            }

            console.log(`[AI] Gerando resposta. Histórico: ${contents.length} msgs. Imagens: ${imageParts.length}, Áudios: ${audioParts.length}`);

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

            // Identifica Handoff Hardcoded por JSON
            let isJsonHandoff = false;
            try {
                // Tenta fazer parse na resposta braba (pode vir como ```json ... ```)
                const cleanJsonParse = text.replace(/```json/gi, '').replace(/```/g, '').trim();
                const obj = JSON.parse(cleanJsonParse);
                if (obj.intent === 'HANDOFF') {
                    isJsonHandoff = true;
                }
            } catch (e) {
                // É texto normal
            }

            // Detect Handoff Legacy textual ou via JSON
            const needsHandoff = isJsonHandoff || text.toLowerCase().includes("atendente humano") || text.toLowerCase().includes("fixar nossa conversa") || text.toLowerCase().includes("vou confirmar com o pessoal");

            // Se for JSON de handoff, devolvemos uma flag explícita pra interface limpar o fallback
            if (isJsonHandoff) {
                text = "[JSON_HANDOFF]";
            }

            return {
                text: text,
                needsHandoff: needsHandoff
            };

        } catch (error) {
            console.error(`❌ Erro IA (Tentativa ${attempt}/${MAX_RETRIES}):`, error.message);
            console.error('[Erro Gemini API]:', error); // Log detalhado conforme solicitado

            // Check if retryable (429 or 503)
            const isRetryable = error.message.includes('429') || error.message.includes('503') || error.message.includes('Overloaded') || error.message.includes('fetch failed');

            if (isRetryable && attempt < MAX_RETRIES) {
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
                // If 404/403 or MAX_RETRIES reached, return friendly fallback
                console.error("❌ FALHA DEFINITIVA NA IA APÓS TENTATIVAS OU ERRO CRÍTICO.");

                return {
                    text: "Opa, meu sistema deu uma pequena engasgada aqui para buscar essa informação. Pode repetir?",
                    needsHandoff: false
                };
            }
        }
    }

    // Safeguard caso saia do try-catch sem return
    return {
        text: "Opa, meu sistema deu uma pequena engasgada aqui para buscar essa informação. Pode repetir?",
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
async function extractImageKeywords(imageParts, textContent) {
    if (!imageParts || imageParts.length === 0) return textContent;
    try {
        const parts = [
            { text: `Aja como um assistente de ferragem. O cliente mandou fotos no WhatsApp com a legenda/mensagem: "${textContent || 'Nenhuma legenda'}". \n\nTAREFA 1: Extraia UMA DESCRIÇÃO NEUTRA das características físicas primárias do que está nas imagens (ex: 'chuveiro eletrico branco', 'cano de pvc').\n\nTAREFA 2: Analise a legenda. Se a legenda for genérica (ex: 'tem esse?', 'quanto custa', 'olha isso', 'esse aqui'), IGNORE o texto do usuário e retorne APENAS a descrição física gerada na Tarefa 1. Se a legenda for ESPECÍFICA contendo metragens, tamanhos ou detalhes complementares (ex: 'tem desse de 150mm?', 'cabo igual esse de 5mm'), CONCATENE a descrição física com a informação útil (ex: 'cabo de cobre 5mm', 'tubo pvc 150mm').\n\nREGRA RESTRITA: Retorne APENAS O TEXTO FINAL de busca, sem explicações, sem aspas, numa única linha. PROIBIDO CHUTAR MARCAS OU LINHAS COMERCIAIS se o texto da marca não estiver 100% legível na embalagem do produto.` }
        ];
        for (const img of imageParts) {
            parts.push(img);
        }

        const result = await model.generateContent({
            contents: [
                {
                    role: 'user',
                    parts: parts
                }
            ],
            systemInstruction: { parts: [{ text: "Você é um extrator semântico cirúrgico. Você junta imagens com intenções textuais criando queries de banco de dados extremamente curtas." }] }
        });
        const unificado = result.response.text().trim();
        console.log(`[AI Vision Inteligente] Resultado da fusão Imagem + Texto: "${unificado}"`);
        return unificado; // Retorna a string pronta e tratada para ser enviada ao Unified Search
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
14. MEDIDAS E TAMANHOS: Ao extrair produtos com medidas (metros, mm, kg), forneça variações curtas e separe a medida do nome base para garantir o match no banco (ex: ["fita isolante 5m", "fita isolante 5", "fita isolante preta"]).
15. FORNECEDORES: Se a mensagem for claramente de um fornecedor, representante comercial oferecendo catálogos, parcerias, revenda ou tabela de preços, você DEVE retornar ESTRITAMENTE o array: ["INTENCAO_FORNECEDOR"].
16. [CORREÇÃO ORTOGRÁFICA CONTEXTUAL]: Você atua em uma FERRAGEM e LOJA DE MATERIAIS DE CONSTRUÇÃO. Clientes frequentemente cometem erros fonéticos ou de digitação (ex: 'acento' = 'assento de vaso', 'xave' = 'chave', 'tijo' = 'tijolo'). Antes de gerar os termos de busca, traduza e corrija as palavras do usuário para o português correto do varejo de construção. Suas palavras-chave geradas DEVEM conter a grafia correta do produto desejado, ignorando o erro do cliente.

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
