const { genAI, modelConfig, SYSTEM_PROMPT } = require('../config/ai_config');
const stockService = require('./stockService');
const settings = require('../config/settings');
const fs = require('fs');
const path = require('path');

const model = genAI.getGenerativeModel(modelConfig);

// === CACHE LAYER (Otimização: evita leitura de disco a cada mensagem) ===
let _cachedStoreInfo = null;
let _cachedStoreInfoTime = 0;
let _cachedExceptions = null;
let _cachedExceptionsTime = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutos

function getCachedStoreInfo() {
    const now = Date.now();
    if (_cachedStoreInfo && (now - _cachedStoreInfoTime < CACHE_TTL)) return _cachedStoreInfo;
    try {
        _cachedStoreInfo = fs.readFileSync(path.join(__dirname, '../../data/store_info.md'), 'utf8');
        _cachedStoreInfoTime = now;
    } catch (e) {
        console.error("Erro ao ler store_info.md:", e);
        _cachedStoreInfo = _cachedStoreInfo || "";
    }
    return _cachedStoreInfo;
}

function getCachedExceptions() {
    const now = Date.now();
    if (_cachedExceptions && (now - _cachedExceptionsTime < CACHE_TTL)) return _cachedExceptions;
    try {
        const exceptionsPath = path.join(__dirname, '../../data/store_exceptions.json');
        if (fs.existsSync(exceptionsPath)) {
            _cachedExceptions = JSON.parse(fs.readFileSync(exceptionsPath, 'utf8'));
        } else {
            _cachedExceptions = [];
        }
        _cachedExceptionsTime = now;
    } catch (e) {
        console.error("[Cache] Erro ao ler store_exceptions.json:", e);
        _cachedExceptions = _cachedExceptions || [];
    }
    return _cachedExceptions;
}

function invalidateExceptionsCache() {
    _cachedExceptions = null;
    _cachedExceptionsTime = 0;
    _cachedStoreInfo = null;
    _cachedStoreInfoTime = 0;
    console.log("[Cache] Cache de exceções e store_info invalidado com sucesso.");
}


/**
 * Enxuga o JSON de estoque para enviar apenas campos essenciais à IA.
 * Reduz ~40% dos tokens de input por produto.
 */
function slimStockContext(items) {
    if (!items || items.length === 0) return [];
    return items.map(item => {
        const slim = {};
        
        // Find price key (containing 'preço' or 'preco')
        const priceKey = Object.keys(item).find(k => k.toLowerCase().includes('preço') || k.toLowerCase().includes('preco'));
        if (priceKey && item[priceKey] !== undefined && item[priceKey] !== '') {
            slim['preço'] = item[priceKey];
        }

        // Find product name key (containing 'produto' or matching 'modelo')
        const productKey = Object.keys(item).find(k => k.toLowerCase().includes('produto') || k.toLowerCase() === 'modelo');
        if (productKey && item[productKey] !== undefined && item[productKey] !== '') {
            slim['modelo/produto'] = item[productKey];
        }

        // Find code / EAN key (containing 'código', 'codigo' or matching 'ean')
        const codeKey = Object.keys(item).find(k => k.toLowerCase().includes('código') || k.toLowerCase().includes('codigo') || k.toLowerCase() === 'ean');
        if (codeKey && item[codeKey] !== undefined && item[codeKey] !== '') {
            slim['código'] = item[codeKey];
        }

        // Find stock / quantity key (containing 'estoque' or matching 'qtd')
        const stockKey = Object.keys(item).find(k => k.toLowerCase().includes('estoque') || k.toLowerCase() === 'qtd');
        if (stockKey && item[stockKey] !== undefined && item[stockKey] !== '') {
            slim['estoque'] = item[stockKey];
        }

        // Find characteristics key (containing 'característica' or 'caracteristica')
        const charKey = Object.keys(item).find(k => k.toLowerCase().includes('característica') || k.toLowerCase().includes('caracteristica'));
        if (charKey && item[charKey] !== undefined && item[charKey] !== '') {
            slim['características'] = item[charKey];
        }

        // Find general category key
        const catKey = Object.keys(item).find(k => k.toLowerCase().includes('categoria_geral') || k.toLowerCase() === 'categoria');
        if (catKey && item[catKey] !== undefined && item[catKey] !== '') {
            slim['categoria_geral'] = item[catKey];
        }

        // Find recommended questions
        const reqKey = Object.keys(item).find(k => k.toLowerCase().includes('perguntas_recomendadas') || k.toLowerCase().includes('perguntas recomendadas'));
        if (reqKey && item[reqKey] !== undefined && item[reqKey] !== '') {
            slim['perguntas_recomendadas'] = item[reqKey];
        }

        // Find power / voltage key
        const powerKey = Object.keys(item).find(k => k.toLowerCase().includes('potên') || k.toLowerCase().includes('poten') || k.toLowerCase().includes('voltag'));
        if (powerKey && item[powerKey] !== undefined && item[powerKey] !== '') {
            slim['potência'] = item[powerKey];
        }

        // Find brand key
        const brandKey = Object.keys(item).find(k => k.toLowerCase() === 'marca');
        if (brandKey && item[brandKey] !== undefined && item[brandKey] !== '') {
            slim['marca'] = item[brandKey];
        }

        if (item['_isSuggestion']) slim['_isSuggestion'] = true;
        if (item['_temFoto']) slim['_temFoto'] = true;
        if (item['_relevancia'] !== undefined) slim['_relevancia'] = item['_relevancia'];
        return slim;
    });
}

// === CONSTANTES DE PROMPT COMPRIMIDAS (Otimização: evita recriação a cada chamada) ===
const WHATSAPP_FORMATTING = "### FORMATAÇÃO WHATSAPP:\n" +
    "Use *asteriscos* para negrito no WhatsApp (produtos, preços em R$, dias da semana).\n" +
    "HUMANIZAÇÃO DE NOMES: NUNCA cite nomes técnicos ALL CAPS do estoque. Converta para Title Case legível.\n" +
    "Ex: 'DUCHA OPTIMA ELETR. 7700W 220V ZAGONEL' → '*Ducha Zagonel Optima Eletrônica* (7700W)'. ALL CAPS = falha crítica.";

const SPECIFIC_RULES = "### REGRAS ESPECIAIS:\n" +
    "- ANTI-LOOP: Se você acabou de perguntar preferência e o cliente RESPONDEU, CRUZE a resposta com o estoque e ofereça 2-3 opções com preço. Proibido repetir pergunta genérica.\n" +
    "- FOTOS DO CLIENTE: Aja naturalmente. PROIBIDO: 'Com base na foto', 'Analisando a imagem', 'O sistema identificou'. Vá direto ao ponto.\n" +
    "- ZERO ALUCINAÇÃO: Contexto VAZIO = PROIBIDO mencionar qualquer marca/modelo/preço por conta própria. Diga que vai pedir pro pessoal verificar e pergunte se o cliente precisa de mais algo. NÃO invente informações.\n" +
    "- TELE-ENTREGA: Responda 'Infelizmente ainda não possuímos tele-entrega 😕'.\n" +
    "- LOCALIZAÇÃO: Envie endereço + tag [ACTION: SEND_LOCATION] no final.\n" +
    "- CONCISÃO: >3 variações do mesmo produto → NÃO liste todas. Faça UMA pergunta de afunilamento.\n" +
    "- HANDOFF INVISÍVEL (REGRA MÁXIMA): Você trabalha com um CATÁLOGO PARCIAL — ele NÃO contém todos os produtos da loja. Quando um produto não está no seu contexto, isso NÃO SIGNIFICA que a loja não tem. Você simplesmente não tem a informação agora. NUNCA transmita ao cliente que 'não encontrou', 'não localizou' ou que o produto 'não está no sistema'. FRASES PROIBIDAS: 'banco de dados', 'sistema', 'planilha', 'não localizei', 'não encontrei', 'não está listado', 'não consta', 'não achei', 'não identifiquei', 'não temos esse', 'vi que não tenho', 'infelizmente não', 'não está disponível no momento'. AÇÃO CORRETA: Diga apenas que vai pedir pro pessoal do balcão verificar, de forma natural e positiva, como se você fosse um atendente humano pedindo para um colega conferir na prateleira. Exemplos: 'Vou pedir pro pessoal aqui verificar esse pra você!' | 'Deixa eu confirmar com o balcão se temos disponível, rapidinho!'\n" +
    "- PROIBIÇÃO DE RESERVA: PROIBIDO usar 'separar', 'guardar', 'reservar'. Cliente pediu separar → Handoff pro balcão.\n" +
    "- TEMPLATE FECHAMENTO: [Produto+preço] + [1 item complementar] + [pergunta se precisa de mais algo].\n" +
    "- TAG [HANDOFF]: Inclua no FINAL da mensagem APENAS quando o cliente CONFIRMAR que não precisa de mais nada e a conversa precisa ser transferida definitivamente (ex: reserva, pedido complexo, cliente insistindo em algo que você já pediu pro balcão verificar). NÃO use [HANDOFF] apenas porque um produto não foi encontrado no contexto — nesse caso, diga que vai verificar e pergunte se precisa de mais algo. NÃO use em despedidas ou quando já apresentou produtos.\n" +
    "- IDENTIDADE: PROIBIDO revelar que é IA/bot. Aja como atendente humano. NUNCA diga que seu nome é 'Marlene' (é o nome do estabelecimento).\n" +
    "- LIMPEZA: NUNCA inicie frases com * ou -. Para listas use quebras de linha ou emojis discretos (🔹, 👉).\n" +
    "- TRANSIÇÃO TRIAGEM→VENDA: Se durante triagem identificar produto EXATO no estoque, ABORTE handoff e venda diretamente.\n" +
    "- PERGUNTAS RECOMENDADAS: Cruze com histórico (não repita info já dada). Máx 1-2 perguntas curtas. Objetivo: coletar detalhes antes do handoff.\n" +
    "- OBRIGATORIEDADE DE TRIAGEM: Se houver uma CATEGORIA DE TRIAGEM DISPONÍVEL no contexto, você DEVE enviar a pergunta de triagem recomendada. É expressamente PROIBIDO fazer o handoff direto sem fazer a pergunta de triagem antes neste caso. A triagem serve para coletar informações para o atendente.\n" +
    "- FONÉTICA: 'acento'='assento', 'xave'='chave'. Corrija silenciosamente sem mencionar erro.\n" +
    "- PRECIFICAÇÃO: PROIBIDO inventar/deduzir preços fora do contexto.\n" +
    "- MÚLTIPLOS ITENS PARCIAIS: Apresente encontrados com preço/foto. Para não encontrados, diga que vai verificar. NUNCA faça handoff total se achou itens parciais.\n" +
    "- FOTOS INTELIGENTES: O campo '_temFoto' indica produtos com foto no servidor. Use {{COD:xxx}} SOMENTE para produtos com _temFoto=true. Produtos sem _temFoto NÃO têm foto disponível — não tente enviar.\n" +
    "- RELEVÂNCIA: O campo '_relevancia' indica confiança do match (maior = melhor). Priorize produtos com _relevancia alta ao sugerir opções ao cliente.\n" +
    "- MARCA EXPLÍCITA: Sempre cite o campo 'marca' ao apresentar produtos. NUNCA invente marca que não está no contexto.";


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

    // Load store info from cache
    const storeInfo = getCachedStoreInfo();

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            // Prepare context string
            // Usa constantes pré-computadas (Otimização: evita recriação a cada chamada)
            const whatsappFormattingInstruct = WHATSAPP_FORMATTING;

            const server = require('../server/app');
            const isFullStockEnabled = server.isFullStockEnabled();

            // Detecta se os itens no contexto são SUGESTÕES (busca relaxada) ou matches exatos
            const hasSuggestionItems = stockContext.length > 0 && stockContext.some(item => item._isSuggestion === true);

            let stockInfoText = "";
            const slimStock = slimStockContext(stockContext);
            const categoryItems = slimStock.filter(item => item.perguntas_recomendadas && !item.código);
            const productItems = slimStock.filter(item => !item.perguntas_recomendadas || item.código);

            if (categoryItems.length > 0) {
                stockInfoText += "### CATEGORIA DE TRIAGEM DISPONÍVEL (OBRIGATÓRIO PERGUNTAR):\n" +
                    "O cliente está buscando sobre um assunto geral/categoria. Você deve fazer a pergunta de triagem recomendada abaixo para qualificar o atendimento antes de transferir para o balcão. NUNCA faça Handoff direto sem fazer essa pergunta antes.\n" +
                    "Você deve naturalizar esta pergunta recomendada para o cliente:\n" +
                    JSON.stringify(categoryItems) + "\n\n";
            }

            if (productItems.length > 0) {
                if (hasSuggestionItems) {
                    stockInfoText += "### PRODUTOS SIMILARES (SUGESTÃO):\n" +
                        "Os itens abaixo são da mesma família do que o cliente pediu. Apresente 2-3 opções com preço de forma natural. Se nenhum servir, diga que vai pedir pro pessoal do balcão verificar se temos outras opções. Pergunte se o cliente precisa de mais alguma coisa.\n\n" +
                        JSON.stringify(productItems);
                } else {
                    stockInfoText += "### ESTOQUE ATUALIZADO:\n" + JSON.stringify(productItems);
                }
            } else if (categoryItems.length === 0) {
                stockInfoText += "### CATÁLOGO PARCIAL — ITEM NÃO PRÉ-CARREGADO:\n" +
                    "CONTEXTO IMPORTANTE: Sua tabela de produtos é PARCIAL — ela NÃO contém todos os itens da loja, apenas uma seleção. Não encontrar aqui NÃO SIGNIFICA que a loja não tem o produto.\n" +
                    "AÇÃO OBRIGATÓRIA: Diga ao cliente de forma natural e positiva que vai pedir para o pessoal do balcão verificar. NÃO acione [HANDOFF] automaticamente — o cliente pode querer mais alguma coisa. Pergunte se precisa de mais algo.\n" +
                    "EXEMPLOS CORRETOS: 'Vou pedir pro pessoal aqui verificar esse item pra você! Enquanto isso, precisa de mais alguma coisa?' | 'Deixa eu pedir pro balcão dar uma olhada nesse, já já te retorno! Quer ver mais algum produto?'\n" +
                    "FRASES ABSOLUTAMENTE PROIBIDAS: 'não encontrei', 'não localizei', 'não temos', 'não está no sistema', 'não consta', 'não achei', 'não identifiquei', 'infelizmente não', 'não está disponível', 'não possuo', 'vi que não tenho', 'não está listado'.";
            }

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
                const storeExceptions = getCachedExceptions();
                targetException = storeExceptions.find(ex => ex.date === currentDateIso);
                if (targetException) {
                    isExceptionDay = true;
                }
            } catch (err) {
                console.error("[Calendário de Exceções] Falha ao processar exceções:", err);
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
                // Lógica Rotineira Padrão (Sem Feriados) calculada dinamicamente via settings.workingHours
                const dayNames = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];
                const todaySchedule = settings.workingHours[currentDayOfWeekly] || [];
                let isCurrentlyOpen = false;

                for (const range of todaySchedule) {
                    const [startH, startM] = range.start.split(':').map(Number);
                    const [endH, endM] = range.end.split(':').map(Number);
                    const startTotal = startH * 60 + startM;
                    const endTotal = endH * 60 + endM;
                    if (currentTotal >= startTotal && currentTotal < endTotal) {
                        isCurrentlyOpen = true;
                        break;
                    }
                }

                if (isCurrentlyOpen) {
                    storeStatusStr = "ABERTA";
                } else {
                    storeStatusStr = "FECHADA";
                    // Checa se abre mais tarde hoje
                    let foundLaterToday = false;
                    for (const range of todaySchedule) {
                        const [startH, startM] = range.start.split(':').map(Number);
                        const startTotal = startH * 60 + startM;
                        if (currentTotal < startTotal) {
                            nextOpenStr = `hoje às ${range.start}`;
                            foundLaterToday = true;
                            break;
                        }
                    }

                    // Se não abre mais hoje, busca o próximo dia que abre
                    if (!foundLaterToday) {
                        for (let offset = 1; offset <= 7; offset++) {
                            const nextDay = (currentDayOfWeekly + offset) % 7;
                            const nextSchedule = settings.workingHours[nextDay] || [];
                            if (nextSchedule.length > 0) {
                                const firstRange = nextSchedule[0];
                                const dayLabel = offset === 1 ? (nextDay === 6 ? "amanhã (sábado)" : "amanhã") : dayNames[nextDay];
                                nextOpenStr = `${dayLabel} às ${firstRange.start}`;
                                break;
                            }
                        }
                    }
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
                systemTimeContext = `[SISTEMA: Hoje é ${currentDayStr}, ${currentTimeStr}. Data de hoje: ${currentDateIso}. A loja está atualmente ${storeStatusStr}.${openingPhrase} Use APENAS esta informação como relógio oficial.]`;
            }

            // Injetar CALENDÁRIO DE EXCEÇÕES FUTURAS para a IA saber sobre feriados/datas especiais
            try {
                const allExceptions = getCachedExceptions();
                const todayMs = new Date(currentDateIso).getTime();
                const futureLimit = todayMs + (60 * 24 * 60 * 60 * 1000); // Próximos 60 dias
                    
                const upcomingExceptions = allExceptions.filter(ex => {
                    if (!ex.date) return false;
                    const exMs = new Date(ex.date + 'T12:00:00').getTime();
                    return exMs > todayMs && exMs <= futureLimit;
                });

                if (upcomingExceptions.length > 0) {
                    const exList = upcomingExceptions.map(ex => {
                        const exDate = new Date(ex.date + 'T12:00:00');
                        const dayName = new Intl.DateTimeFormat('pt-BR', { weekday: 'long', day: '2-digit', month: '2-digit' }).format(exDate);
                        const tipo = ex.type === 'horario_especial' 
                            ? `Horário Especial (${ex.specialHours?.open || '?'} às ${ex.specialHours?.close || '?'})` 
                            : 'FECHADA';
                        return `- ${dayName} (${ex.date}): ${ex.reason} → ${tipo}${ex.returnDate ? `. Retorno: ${ex.returnDate}` : ''}`;
                    }).join('\n');
                        
                    systemTimeContext += `\n[CALENDÁRIO DE EXCEÇÕES - DATAS ESPECIAIS PRÓXIMAS (CONSULTE OBRIGATORIAMENTE se o cliente perguntar sobre dias futuros)]:\n${exList}`;
                }
            } catch (calErr) {
                console.error("[Calendário Futuro] Erro ao injetar exceções futuras:", calErr);
            }

            const specificRules = SPECIFIC_RULES;

            // --- FIX 4: TRIAGEM OBRIGATÓRIA PARA CATEGORIA GERAL ---
            // Detecta se o contexto retornou SOMENTE itens da Tabela Geral (sem produtos da Tabela Principal)
            // Esses itens têm 'categoria_geral' mas não têm 'código' ou 'modelo/produto'
            const hasOnlyGeralItems = stockContext.length > 0 &&
                stockContext.every(item => item['categoria_geral'] && !item['código'] && !item['codigo']);

            let triageDirective = '';
            if (hasOnlyGeralItems) {
                const geralItem = stockContext[0];
                const triageQuestions = geralItem['perguntas_recomendadas'] || geralItem['Perguntas_Recomendadas'] || '';
                triageDirective = `\n### DIRETIVA DE TRIAGEM OBRIGATÓRIA (CATEGORIA GERAL DETECTADA):\n` +
                    `O cliente pediu um produto que está na nossa tabela de categorias gerais, mas SEM estoque específico listado. ` +
                    `Categoria identificada: "${geralItem['categoria_geral'] || 'Geral'}". ` +
                    `VOCÊ DEVE OBRIGATORIAMENTE fazer 1 ou 2 perguntas de triagem ANTES de acionar qualquer handoff. ` +
                    `O objetivo é coletar informações (medida, marca, voltagem, modelo) para que o atendente humano já receba o contexto mastigado. ` +
                    (triageQuestions ? `Perguntas sugeridas para esta categoria: "${triageQuestions}". ` : '') +
                    `REGRA INVIOLÁVEL: É ESTRITAMENTE PROIBIDO fazer handoff sem primeiro fazer ao menos 1 pergunta de triagem. ` +
                    `Somente após o cliente responder à triagem, faça o handoff com o contexto completo.\n`;
                console.log(`[Triagem Obrigatória] Categoria Geral detectada: "${geralItem['categoria_geral']}". Injetando diretiva de triagem.`);
            }

            const sessionPrompt = (offHoursContext ? `### ALERTA DE HORÁRIO COMERCIAL (SIGA ESTRITAMENTE):\n${offHoursContext}\n\n` : "") +
                `### INFORMAÇÕES DA LOJA:\n${storeInfo}\n\n${stockInfoText}\n\n` +
                `${specificRules}\n\n` +
                `${triageDirective}` +
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
                const cleanJsonParse = text.replace(/```json/gi, '').replace(/```/g, '').trim();
                const obj = JSON.parse(cleanJsonParse);
                if (obj.intent === 'HANDOFF') {
                    isJsonHandoff = true;
                }
            } catch (e) {
                // É texto normal
            }

            // Detect Handoff via TAG explícita [HANDOFF] ou JSON
            const hasHandoffTag = text.includes('[HANDOFF]');
            const needsHandoff = isJsonHandoff || hasHandoffTag;

            // Limpa a tag [HANDOFF] do texto antes de enviar ao cliente
            if (hasHandoffTag) {
                text = text.replace(/\[HANDOFF\]/g, '').trim();
            }

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
            { text: `Você é um assistente de uma loja de ferragem e materiais de construção. O cliente mandou fotos no WhatsApp com a legenda/mensagem: "${textContent || 'Nenhuma legenda'}".

REGRA DE OURO (PRIORIDADE ABSOLUTA — NÃO VIOLE):
A legenda do cliente é a FONTE DE VERDADE sobre o que ele quer. Se a legenda contiver um SUBSTANTIVO DE PRODUTO (ex: "mangueira", "cano", "torneira", "chuveiro", "fio", "parafuso", "válvula", etc.), esse substantivo é SAGRADO e DEVE aparecer obrigatoriamente no resultado final. Você NUNCA pode substituí-lo por outro produto baseando-se na aparência visual. A imagem pode parecer um "fio elétrico", mas se o cliente escreveu "mangueira", ele sabe o que é — e o resultado DEVE conter "mangueira".

TAREFA (siga nesta ordem estrita):

PASSO 1 — EXTRAIR DA LEGENDA: Identifique se a legenda contém substantivos de produto (nomes de itens reais de ferragem/construção). Exemplos: mangueira, cano, fio, cabo, torneira, chuveiro, registro, válvula, conector, abraçadeira, parafuso, prego, etc. Extraia também qualquer medida/tamanho mencionado (ex: 6mm, 1/2", 3m).

PASSO 2 — CLASSIFICAR A LEGENDA:
  a) LEGENDA COM PRODUTO: Se a legenda contém pelo menos UM substantivo de produto (ex: "Tem essa mangueira de 6mm?", "Preciso desse registro", "Quanto custa esse cano?"), o substantivo do produto é OBRIGATÓRIO no resultado. Use a imagem APENAS para extrair atributos COMPLEMENTARES (cor, material, formato) que não estejam na legenda.
  b) LEGENDA GENÉRICA: Se a legenda contém APENAS frases genéricas SEM substantivo de produto (ex: "Tem esse?", "Quanto custa?", "Olha isso", "Esse aqui"), aí sim use a análise visual da imagem para identificar o produto.

PASSO 3 — MONTAR RESULTADO:
  - Para legenda COM produto: [substantivo da legenda] + [medida da legenda se houver] + [atributos visuais complementares: cor, material]. Exemplo: legenda "Tem essa mangueira de 6mm?" + imagem mostra item azul → resultado: "mangueira 6mm azul"
  - Para legenda GENÉRICA: Use a descrição visual do produto. Exemplo: legenda "Tem esse?" + imagem de chuveiro branco → resultado: "chuveiro elétrico branco"

REGRA RESTRITA: Retorne APENAS O TEXTO FINAL de busca, sem explicações, sem aspas, numa única linha. PROIBIDO CHUTAR MARCAS OU LINHAS COMERCIAIS se o texto da marca não estiver 100% legível na embalagem do produto.` }
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
            systemInstruction: { parts: [{ text: "Você é um extrator semântico cirúrgico de uma loja de ferragem. A LEGENDA DO CLIENTE TEM PRIORIDADE ABSOLUTA sobre a análise visual. Nunca contradiga o substantivo de produto que o cliente escreveu. Gere queries de busca curtas e precisas." }] }
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

        const prompt = `Especialista em ferragens/materiais de construção. Gere array JSON de palavras-chave curtas para busca textual.

REGRAS:
1. CONTEXTO: Se resposta é continuação ("pro chuveiro", "branco"), concatene com produto do turno anterior (ex: ["fio para chuveiro", "fio chuveiro"]). Nunca busque só o complemento.
2. NOVO ASSUNTO: Se mudou de categoria, extraia SÓ termos novos.
3. PALAVRAS CURTAS: Extraia essência. "torneira zagonel de pia" → ["torneira zagonel pia", "torneira de pia"].
4. VARIAÇÕES: Gere múltiplas com preposições (pra/para/de). Ex: "fio pra chuveiro" → ["fio para chuveiro", "fio de chuveiro", "cabo para chuveiro"].
5. Proibido fatiar em termos genéricos isolados (exceto atributos-chave, regra 9).
6. Remova stop words não essenciais mas mantenha em variações de cauda longa.
7. IGNORE saudações ("bom dia", "oi", "obrigado"). NUNCA inclua saudação nos termos.
8. Proibido adjetivos de valor/preço ("barato", "caro", "econômico"). Só substantivos e specs técnicas.
9. ATRIBUTOS: Produto + atributo → gere combinação + atributo isolado + sinônimos. Ex: ["chuveiro pressurizador", "pressurizador", "pressurizada", "turbo"].
10. Proibido fragmentar termos compostos ("fechadura porta madeira" → NÃO retorne "madeira" ou "porta" isolados).
11. Sem intenção de produto ("ok", "obrigado", "olá") → retorne [].
12. RELATIVOS ("outros", "mais opções"): olhe histórico, identifique categoria, descarte filtro restritivo. Busque amplo.
13. CITAÇÕES: [Respondendo a: {Produto}] → extraia o produto da tag.
14. MEDIDAS: Separe medida do nome base. Ex: ["fita isolante 5m", "fita isolante 5"].
15. FORNECEDORES (oferecendo catálogos/parcerias) → ["INTENCAO_FORNECEDOR"].
16. CORREÇÃO ORTOGRÁFICA: Contexto de ferragem. 'acento'='assento', 'xave'='chave'. Corrija silenciosamente.
17. MULTI-PRODUTO: 2+ produtos distintos → termos SEPARADOS para cada. Nunca misture nomes.
18. SINÔNIMOS TÉCNICOS: "peça porcelana/fio terra"→"conector porcelana"; "espelho tomada"→"espelho"; "joelho cano"→"joelho","cotovelo"; "presilha cano"→"abraçadeira"; "cano fogão/chaminé"→"cano fogão","chaminé","cano galvanizado".

### ENTRADAS:
Mensagem: "${sanitizedMessage}"
Histórico:
${historyText || "Nenhum."}

RETORNE APENAS array JSON válido. Sem markdown, sem explicações.
Ex: ["torneira de parede", "torneira elétrica parede"]`;

        const result = await model.generateContent(prompt);
        const rawResponse = result.response.text();
        // Regex para tirar os blocos de código se a IA mandar (ex ```json ["1"] ```)
        let cleanJson = rawResponse.replace(/```json/gi, '').replace(/```/g, '').trim();
        const arrayMatch = cleanJson.match(/\[[\s\S]*\]/);
        if (arrayMatch) {
            cleanJson = arrayMatch[0];
        }
        cleanJson = cleanJson.replace(/[\r\n\t]/g, ''); // Sanitização agressiva para manter formato válido
        cleanJson = cleanJson.replace(/[\u201C\u201D]/g, '"'); // Smart quotes → aspas normais
        cleanJson = cleanJson.replace(/[\u2018\u2019]/g, "'"); // Smart single quotes
        // Try-Catch Silencioso para Proteção do Motor (Anti-Array corrompido)
        let keywordsArray = [];
        try {
            keywordsArray = JSON.parse(cleanJson);
        } catch (parseError) {
            console.log(`[AI Keyword] JSON parse falhou para: "${cleanJson.substring(0, 200)}". Usando mensagem bruta como fallback.`);
            // Fallback: usa a mensagem original do usuário como termo de busca
            // ao invés de [] (que seria interpretado como "sem intenção de produto")
            keywordsArray = sanitizedMessage.trim().length > 2 ? [sanitizedMessage.trim().substring(0, 80)] : [];
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
    naturalizeTriageQuestion,
    invalidateExceptionsCache
};
