# Arquitetura e Fluxo do Bot Whatsapp "Ferragem Marlene"

Este documento descreve a arquitetura, o fluxo de mensagens e a integração com Inteligência Artificial (Gemini 1.5 Flash) do bot de WhatsApp da Ferragem Marlene. Este texto foi otimizado para servir como **Contexto de Sistema** para outras ferramentas de IA que irão sugerir melhorias.

## 1. Stack Tecnológico
*   **Plataforma de Mensageria:** Baileys (API não-oficial de WhatsApp via WebSockets).
*   **Linguagem & Backend:** Node.js.
*   **Banco de Dados (Histórico e Sessões):** Prisma ORM com SQLite (armazenamento persistente do histórico de conversas).
*   **Motor de Inteligência Artificial:** Google Gemini (1.5 Flash), escolhido por suportar respostas rápidas (texto) e visão computacional (análise de fotos enviadas por clientes).
*   **Banco de Dados (Estoque/Produtos):** Google Sheets API (como CMS primário e espelho do estoque).
    *   Tabela Principal (Produtos com preços e códigos).
    *   Tabela de Categoria Geral (Casos genéricos e perguntas de triagem/afunilamento).
*   **Motor de Busca (Fuzzy):** Fuse.js (Busca difusa nas planilhas em memória para tolerar erros de digitação antes de passar para o Gemini).

## 2. Visão Geral do Fluxo Principal (Pipeline de Atendimento)

O bot age como um atendente humano simulado (*Agent*) que preza pela eficiência ("Zero-Robô"). Quando um cliente manda uma mensagem, este é o caminho crítico:

### Estágio A: Recepção e Proteções Iniciais
1.  **Webhooks/Eventos Baileys:** A mensagem chega (`messages.upsert`).
2.  **Interceptadores de Handoff/Mute:** O bot verifica se a conversa está travada para um atendente humano (`userPausedStates`). Se um documento (PDF) for recebido, ou se o humano marcou a conversa com a flag de pausa temporal (Handoff Invisível de 6 horas), o bot **ignora** silenciosamente.
3.  **Fila e Debounce:** Usuários de WhatsApp costumam mandar várias mensagens curtas (ex: "Oi" > "Tudo Bem?" > "Tem chuveiro?"). O bot acumula (`Fila/Debouncing` de ~5s) os textos e a última mídia de imagem numa única string/payload para consolidar o contexto.

### Estágio B: Expansão de Contexto e Visão (IA Pre-Flight)
1.  **Histórico Amnésico:** O Prisma ORM busca as últimas 12 mensagens (janela rolante) apenas das últimas 36 horas para dar contexto de memória sem estourar tokens do LLM.
2.  **Leitura Visual:** Se a mensagem possuir uma foto, aciona-se um prompt *Pre-Flight* (função `extractImageKeywords`). O Gemini avalia a foto isoladamente e tenta deduzir "termos físicos neutros" (ex: "chuveiro elétrico de parede", "fita veda rosca") do produto na imagem corporificada na vida real, juntando isso à *query* de texto.

### Estágio C: Classificação e Busca de Estoque
1.  **Roteador de Intenção (`classifyIntent`):** Outro prompt rápido avalia se a intenção é FAQ da loja ("que horas abre?"), busca de produto ("tem parafuso?"), ou confirmação de transação/reserva ("quero esse").
2.  **Busca Difusa Unificada (Se *SEARCH*):**
    *   O LLM cria Variações Rápidas (`expandSearchQuery`) para as buscas baseadas em gírias ou erros ortográficos.
    *   O motor Fuse.js consulta, SIMULTANEAMENTE, a aba "Produtos Específicos" e a aba "Categorias Gerais" do Google Sheets guardadas no cache local.
    *   Os ~15 itens mais relevantes retornam.

### Estágio D: O "Oráculo Master" (Gabarito Visual vs Foto Real)
*   **Auditoria de Arquivos Locais:** Se for uma *Busca com Foto*, pegamos os IDs/Tags resultantes da busca do Fuse.js e olhamos no HD local (`data/fotos_sheets`) do servidor. Se esses produtos do sistema possuírem as suas "fotos de vitrine oficiais", carregamos os metadados.
*   **Confronto Visão Computacional:** Disparamos um prompt gigante de "Auditoria Master". Mandamos a "Foto Mal Tirada do Cliente" + "Múltiplas Fotos Perfeitas do Nosso Banco de Dados". O Gemini faz um de-para, ignorando fundos sujos, e verifica *qual foto de sistema* corresponde exatamente à silhueta do produto que o usuário fotografou. Se bater, a IA aborta a lista gigante do Fuse.js e elege AQUELE EAN (produto exato) como a resposta a ser trabalhada.

### Estágio E: Estratégias de Resposta e Triagem (State Machine)
Baseado no que retornou do Estoque (ou Oráculo), o LLM Final deve formatar o estilo de resposta:
1.  **Se caiu numa Categoria Geral (ex: Tintas):** Aciona o "Triage Bypass". Em vez de listar 300 latas de tinta, o sistema encontra recomendação de triagem na planilha (ex: "pergunte se quer acrílica ou esmalte"), usa o Gemini para tornar essa pergunta amigável e natural, envia pro cliente e *Trava a Sessão* (State Machine: `AWAITING_TRIAGE_ANSWER`) esperando a resposta afunilada nas próximas interações.
2.  **Se o Contexto de Estoque voltar Vazio:** Aciona "Handoff Invisível". A IA Final instrui que "vai buscar na prateleira" e para de falar, transferindo silenciosamente para o atendente. **Há diretrizes severas ("Zero Tolerance") impedindo de alucinar informações ou inventar preços**.
3.  **Se Achou Produtos Específicos:** A IA avalia preço, tamanho e sugere a venda de forma humanizada.

### Estágio F: Injeções Sistêmicas (System Prompt Dinâmico)
Antes do prompt ir para a Geração Final, algumas injeções automáticas ("Clock Sync") ocorrem a nível de código (`aiService.js`):
*   **Timezone Forte:** O bot pega o `new Date().toLocaleString({timeZone: 'America/Sao_Paulo'})` e adiciona estritamente no início do prompt, informando à IA que horas são no mundo real da loja física. Para que ela saiba afirmar de forma síncrona se "neste exato segundo estamos abertos ou fechados" proativamente nas resenhas.

## 3. Diretrizes Críticas de Persona ("Regras de Ouro" das IAs do Sistema)
Para impedir o aspecto robótico, aplicam-se restrições extremas e constantes:
1.  **Zero-Robotic e Anti-Textão:** Mensagens curtas, sem asteriscos perdidos, parágrafos imensos, e sem jargões de "inteligência" ("o sistema aponta...", "analisando a imagem").
2.  **Humanização de Títulos Dinâmica:** Proibido vomitar `ALL CAPS` do banco de dados (ex: `DUCHA TOP 7K ZAGONEL`). Deve formatar as letras em 'Title Case' bonito *on-the-fly*.
3.  **Handoff Natural:** Nunca dizer "Vou passá-lo ao meu programador/supervisor" ou "Sou um robô em treinamento". Deve dizer "*Vou confirmar no balcão se temos essa peça exata para o colega despachar, só 1 minuto*".
4.  **Resistência à Mudança de Estado (Triagem -> Venda):** Se uma pessoa numa "triagem geral contínua" afunilar num nível de especificar um EAN que tenhamos (ex: "fio de chuveiro > fio 6mm da cor azul"), a IA recebe autorização do *SystemPrompt* para interromper a triagem, cancelar o repasse ao humano, voltar para "Modo Vendedor" e confirmar a venda proativamente enviando o preço e garantindo as polegadas.
