<p align="center">
  <h1 align="center">🔩 Ferragem Marlene — WhatsApp Stock Bot</h1>
  <p align="center">
    Assistente virtual de vendas com IA multimodal para lojas de materiais de construção.
    <br/>
    Construído com <strong>Node.js</strong> · <strong>Baileys</strong> · <strong>Google Gemini 1.5 Flash</strong> · <strong>Prisma</strong> · <strong>Puppeteer</strong>
  </p>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Node.js-20+-339933?logo=node.js&logoColor=white" alt="Node.js">
  <img src="https://img.shields.io/badge/Gemini-1.5_Flash-4285F4?logo=google&logoColor=white" alt="Gemini">
  <img src="https://img.shields.io/badge/WhatsApp-Baileys-25D366?logo=whatsapp&logoColor=white" alt="WhatsApp">
  <img src="https://img.shields.io/badge/DB-SQLite_+_Prisma-2D3748?logo=prisma&logoColor=white" alt="Prisma">
  <img src="https://img.shields.io/badge/Deploy-Docker_+_GH_Actions-2496ED?logo=docker&logoColor=white" alt="Docker">
</p>

---

## 📋 Índice

- [Sobre o Projeto](#-sobre-o-projeto)
- [Arquitetura](#-arquitetura)
- [Funcionalidades](#-funcionalidades)
- [Tech Stack](#-tech-stack)
- [Pré-Requisitos](#-pré-requisitos)
- [Instalação](#-instalação)
- [Configuração (.env)](#-configuração-env)
- [Estrutura de Pastas](#-estrutura-de-pastas)
- [Banco de Dados (Prisma)](#-banco-de-dados-prisma)
- [Dados e Planilhas](#-dados-e-planilhas)
- [Executando o Bot](#-executando-o-bot)
- [Painel Web (Dashboard)](#-painel-web-dashboard)
- [Deploy em Produção](#-deploy-em-produção-docker--github-actions)
- [Comandos Especiais do WhatsApp](#-comandos-especiais-do-whatsapp)
- [Prompt Engineering e Diretrizes da IA](#-prompt-engineering-e-diretrizes-da-ia)
- [Feriados e Exceções de Horário](#-feriados-e-exceções-de-horário)
- [Troubleshooting](#-troubleshooting)
- [Licença](#-licença)

---

## 🧠 Sobre o Projeto

O **Ferragem Marlene Bot** transforma o WhatsApp de uma loja física de materiais de construção em um consultor de vendas inteligente 24/7. Ele atende clientes em linguagem natural, consulta o estoque em tempo real via Google Sheets, identifica produtos por foto usando visão computacional, e transfere conversas complexas para atendentes humanos de forma invisível.

O sistema foi projetado para operar com **zero tolerância a alucinações**: a IA jamais inventa preços, marcas ou disponibilidade — tudo é extraído exclusivamente do contexto de estoque injetado na memória do modelo.

---

## 🏗️ Arquitetura

```
┌──────────────────────────────────────────────────────────┐
│                    CLIENTE (WhatsApp)                     │
└─────────────────────────┬────────────────────────────────┘
                          │ Mensagem (texto/foto/áudio)
                          ▼
┌──────────────────────────────────────────────────────────┐
│               LISTENER DE MENSAGENS (bot.js)             │
│  ┌──────────┐ ┌──────────────┐ ┌───────────────────────┐ │
│  │ Debounce │ │Human Takeover│ │ Message Queue Manager │ │
│  │  Timer   │ │   (fromMe)   │ │    (por usuário)      │ │
│  └──────────┘ └──────────────┘ └───────────────────────┘ │
└─────────────────────────┬────────────────────────────────┘
                          ▼
┌──────────────────────────────────────────────────────────┐
│              PIPELINE DE PROCESSAMENTO                    │
│                                                          │
│  1. Keyword Expansion (IA)  ─→  Correção Ortográfica    │
│  2. Unified Search (Fuse.js) ─→  Principal + Geral      │
│  3. Semantic Pre-Ranking (IA) ─→  Refinamento           │
│  4. Oracle Visual (IA Multimodal) ─→  Gabarito de Fotos │
│  5. Scraper Puppeteer ─→  Verificação real-time (PDV)   │
│  6. Gemini Response (IA) ─→  Resposta humanizada        │
└─────────────────────────┬────────────────────────────────┘
                          ▼
┌──────────────────────────────────────────────────────────┐
│  CAMADA DE DADOS                                         │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────────┐  │
│  │Google Sheets │ │ SQLite/Prisma│ │ Fotos Catálogo   │  │
│  │ (Estoque)    │ │(Chat History │ │ (data/fotos_     │  │
│  │              │ │ + Demanda)   │ │  sheets/*.jpg)   │  │
│  └──────────────┘ └──────────────┘ └──────────────────┘  │
└──────────────────────────────────────────────────────────┘
```

---

## 🚀 Funcionalidades

### Vendas e Atendimento
| Feature | Descrição |
|---------|-----------|
| **IA Humanizada** | Conversa como um atendente real de balcão, usando linguagem natural e empática. Nunca revela que é um bot. |
| **Busca Unificada** | Combina resultados da planilha principal (produtos) e geral (categorias/triagem) usando Fuse.js com threshold rigoroso (0.2). |
| **Expansão Semântica** | IA expande termos de busca com sinônimos, gírias e variações regionais antes de consultar o estoque. |
| **Correção Ortográfica** | Corrige automaticamente erros fonéticos do cliente (ex: "acento" → "assento sanitário") sem constrangê-lo. |
| **Cross-Selling Contextual** | Após informar preço, sugere 1-2 itens complementares lógicos (ex: torneira → fita veda rosca). |
| **Afunilamento Inteligente** | Para buscas genéricas com muitas opções, faz perguntas de refinamento ao invés de listar tudo. |
| **Precificação Proativa** | Sempre informa o preço junto com o produto, agindo como vendedor ágil. |
| **Anti-Alucinação (Zero Tolerance)** | Proibido inventar preços ou mencionar produtos que não estejam no contexto de estoque. |

### Visão Computacional
| Feature | Descrição |
|---------|-----------|
| **Identificação por Foto** | Cliente envia foto → IA extrai keywords visuais → busca no estoque → exibe produtos. |
| **Oráculo Visual (Gabarito)** | Cruza a foto do cliente com até 8 imagens de catálogo local para auditoria visual precisa. |
| **Semantic Pre-Ranking** | Antes do Oráculo, a IA reordena os candidatos por relevância visual e textual. |
| **Paradoxo do Acessório** | Se o cliente quer uma peça de reposição (resistência, refil), identifica o "hospedeiro" (chuveiro) e redireciona a busca. |

### Operacional
| Feature | Descrição |
|---------|-----------|
| **Handoff Invisível** | Transfere para humano sem mencionar "sistema", "planilha" ou "IA". |
| **Human Takeover** | Se o dono responde manualmente (`fromMe`), o bot silencia automaticamente naquele chat. Reativa com `!bot`. |
| **Scraper Real-Time (Puppeteer)** | Verifica estoque real no sistema PDV da loja via navegador headless. |
| **Grupo VIP** | Redireciona clientes de produtos esgotados para grupo exclusivo de reposição. |
| **Follow-Up Automático** | Envia lembrete após 5 minutos de inatividade do cliente na conversa. |
| **Demanda Reprimida** | Registra cada produto buscado e não encontrado para análise de compras futuras. |
| **Horário Comercial** | A IA sabe se a loja está aberta/fechada com base no relógio de Brasília e feriados cadastrados. |
| **Transcrição de Áudio** | Áudios de WhatsApp são transcritos pelo Gemini e processados normalmente. |

---

## 🛠️ Tech Stack

| Camada | Tecnologia | Função |
|--------|-----------|--------|
| **Runtime** | Node.js 20+ | Motor principal |
| **WhatsApp** | @whiskeysockets/baileys | Conexão com WhatsApp Web (Multi-Device) |
| **IA Generativa** | @google/generative-ai (Gemini 1.5 Flash) | Texto, visão, áudio e expansão semântica |
| **Busca Fuzzy** | Fuse.js | Busca aproximada no cache de produtos |
| **Banco de Dados** | SQLite + Prisma ORM | Histórico de conversas e demanda reprimida |
| **Scraping** | Puppeteer | Verificação de estoque em tempo real no PDV |
| **Dashboard** | Express + Socket.IO | Painel web administrativo com status em tempo real |
| **Estoque (CMS)** | Google Sheets (CSV público) | Planilha como fonte de dados de estoque |
| **Container** | Docker | Empacotamento para produção |
| **CI/CD** | GitHub Actions | Deploy automático em push na main |

---

## 📦 Pré-Requisitos

- **Node.js** v20 ou superior
- **npm** v9+
- **Google Chrome / Chromium** (necessário para o Puppeteer)
- **Chave da API Google Gemini** — Obtenha em [aistudio.google.com](https://aistudio.google.com/app/apikey)
- **Celular com WhatsApp** — Para escanear o QR Code na primeira conexão

---

## ⚡ Instalação

```bash
# 1. Clone o repositório
git clone https://github.com/murilowilbert/humanized-bot-whatsapp.git
cd humanized-bot-whatsapp

# 2. Instale as dependências
npm install

# 3. Gere o client Prisma e aplique as migrations
npx prisma generate
npx prisma migrate dev --name init
```

---

## 🔐 Configuração (.env)

Crie um arquivo `.env` na raiz do projeto. Use `.env.example` como referência:

```env
# ─── IA ───────────────────────────────────────────
GEMINI_API_KEY="sua_chave_gemini_aqui"

# ─── WhatsApp ─────────────────────────────────────
WHATSAPP_PHONE_NUMBER="5551999999999"

# ─── Planilhas Google (Estoque como CMS) ──────────
GOOGLE_SHEETS_URL_PRINCIPAL="https://docs.google.com/spreadsheets/d/.../export?format=csv"
GOOGLE_SHEETS_URL_GERAL="https://docs.google.com/spreadsheets/d/.../export?format=csv&gid=..."

# ─── Scraper do PDV (Estoque Real-Time) ───────────
SNAPCONTROL_URL="https://sua-empresa.snapcontrol.com.br/..."
SNAPCONTROL_USER="seu_usuario"
SNAPCONTROL_PASS="sua_senha"

# ─── Dashboard Administrativo ─────────────────────
DASHBOARD_USER="admin"
DASHBOARD_PASS="sua_senha_forte"
PORT=3000

# ─── Banco de Dados ──────────────────────────────
DATABASE_URL="file:./dev.db"

# ─── Timezone ─────────────────────────────────────
TZ=America/Sao_Paulo
```

---

## 📁 Estrutura de Pastas

```
whatsapp-stock-bot/
├── .github/
│   └── workflows/
│       └── deploy.yml              # Pipeline CI/CD (GitHub Actions → Docker → GCP)
├── data/
│   ├── estoque.xlsx                # Planilha offline de fallback
│   ├── fotos_sheets/               # Imagens dos produtos (nomeadas por código: 1234567.jpg)
│   ├── fotos/                      # Fotos auxiliares
│   ├── store_info.md               # Informações da loja injetadas no prompt
│   ├── store_exceptions.json       # Feriados e dias especiais
│   ├── metricas.json               # Métricas de uso
│   └── demanda_reprimida.csv       # Log de produtos não encontrados
├── prisma/
│   └── schema.prisma               # Schema do banco (ChatHistory + MissedDemand)
├── src/
│   ├── bot.js                      # 🧠 Orquestrador principal (listener, fila, pipeline)
│   ├── config/
│   │   ├── ai_config.js            # System Prompt principal (SYSTEM_PROMPT)
│   │   └── settings.js             # Horários, mensagens padrão, nome da loja
│   ├── services/
│   │   ├── aiService.js            # Todas as chamadas ao Gemini (chat, visão, expansão, triagem)
│   │   ├── googleSheetsService.js  # Cache e busca Fuse.js nas planilhas
│   │   ├── stockService.js         # Coordenador de busca (Sheets + Excel fallback)
│   │   ├── scraperService.js       # Puppeteer headless para PDV real-time
│   │   ├── catalogService.js       # Envio de imagens de catálogo ao cliente
│   │   └── metricsService.js       # Registro de métricas de uso
│   ├── server/
│   │   └── app.js                  # Express + Socket.IO (Dashboard API + Admin)
│   └── public/
│       ├── index.html              # Painel de controle (UI do dashboard)
│       ├── dashboard.html          # Tela de demanda reprimida
│       ├── script.js               # Lógica front-end do painel
│       └── style.css               # Estilos do painel
├── index.js                        # Entrypoint do aplicativo
├── Dockerfile                      # Container de produção (Node 20 + Chrome)
├── entrypoint.sh                   # Script de inicialização Docker
├── start_bot.bat                   # Atalho para Windows
├── package.json
└── .env.example
```

---

## 🗃️ Banco de Dados (Prisma)

O bot utiliza **SQLite** via **Prisma ORM** com dois modelos:

| Modelo | Função |
|--------|--------|
| `ChatHistory` | Armazena o histórico completo de mensagens (usuário e bot) por número de telefone. Usado para contexto de conversa e rolling window de 12 msgs. |
| `MissedDemand` | Registra cada produto buscado e não encontrado, com contagem de buscas e data da última requisição. Alimenta o dashboard de "Demanda Reprimida". |

**Comandos úteis:**
```bash
# Regenerar o client após mudar o schema
npx prisma generate

# Aplicar nova migration
npx prisma migrate dev --name descricao_da_mudanca

# Abrir o Prisma Studio (UI visual do banco)
npx prisma studio
```

---

## 📊 Dados e Planilhas

### Google Sheets (Fonte Principal)
O bot consome duas planilhas Google publicadas como CSV:

| Planilha | Variável `.env` | Conteúdo |
|----------|----------------|----------|
| **Principal** | `GOOGLE_SHEETS_URL_PRINCIPAL` | Catálogo de produtos com código, nome, preço, marca, tags, atributos físicos e EAN |
| **Geral** | `GOOGLE_SHEETS_URL_GERAL` | Categorias de triagem com perguntas recomendadas para afunilamento |

### Planilha Excel (Fallback Offline)
Se as URLs das Sheets não estiverem configuradas, o bot carrega `data/estoque.xlsx` automaticamente.

### Imagens de Catálogo
Coloque as fotos dos produtos em `data/fotos_sheets/` nomeando cada arquivo pelo **código do produto**:
```
data/fotos_sheets/
├── 7896001234567.jpg
├── 7896009876543.png
└── ...
```

---

## 🤖 Executando o Bot

### Desenvolvimento Local

```bash
# Iniciar (primeira vez: exibirá QR Code no terminal)
node index.js
```

Na primeira execução:
1. Um **QR Code** será exibido no terminal
2. Abra o WhatsApp no celular da loja → **Dispositivos conectados** → **Conectar dispositivo**
3. Escaneie o QR Code
4. Pronto! O bot estará ativo e o dashboard acessível em `http://localhost:3000`

### Windows (Atalho)
```bash
start_bot.bat
```

---

## 📈 Painel Web (Dashboard)

Acesse `http://localhost:3000` (protegido por Basic Auth com `DASHBOARD_USER`/`DASHBOARD_PASS`).

### Funcionalidades do Painel
- **Power On/Off** — Liga e desliga o bot remotamente
- **Modo Teste** — Restringe o bot para responder apenas números autorizados
- **QR Code** — Exibe o QR Code para reconexão sem precisar do terminal
- **Monitor de Status** — Estado da conexão WhatsApp em tempo real (Socket.IO)
- **Demanda Reprimida** — Ranking dos produtos mais buscados que não foram encontrados no estoque
- **Controle de Full Stock** — Toggle para busca completa vs. otimizada

### API REST do Dashboard
```bash
# Ligar/Desligar o bot
POST /api/toggle  {"type": "power", "enabled": true}

# Ativar modo teste
POST /api/toggle  {"type": "test", "enabled": true}

# Iniciar conexão WhatsApp
POST /api/start
```

---

## 🐳 Deploy em Produção (Docker + GitHub Actions)

O projeto inclui um pipeline completo de CI/CD:

```
Push na branch main → GitHub Actions → SCP para servidor → Docker build → Health check → Bot online
```

### GitHub Secrets Necessários

| Secret | Descrição |
|--------|-----------|
| `SERVER_IP` | IP público do servidor (ex: GCP Compute Engine) |
| `SERVER_USER` | Usuário SSH do servidor |
| `SSH_PRIVATE_KEY` | Chave privada SSH para acesso ao servidor |
| `GEMINI_API_KEY` | Chave da API Gemini |
| `WHATSAPP_PHONE_NUMBER` | Número do WhatsApp da loja |
| `GOOGLE_SHEETS_URL_PRINCIPAL` | URL da planilha principal |
| `GOOGLE_SHEETS_URL_GERAL` | URL da planilha geral |
| `SNAPCONTROL_URL` | URL do sistema PDV |
| `SNAPCONTROL_USER` | Usuário do sistema PDV |
| `SNAPCONTROL_PASS` | Senha do sistema PDV |
| `DASHBOARD_USER` | Usuário do painel web |
| `DASHBOARD_PASS` | Senha do painel web |

### Deploy Manual com Docker
```bash
# Build da imagem
docker build -t bot-marlene .

# Rodar o container
docker run -d -p 3000:3000 \
  --env-file .env \
  -v $(pwd)/auth_info_baileys:/app/auth_info_baileys \
  -v $(pwd)/dev.db:/app/dev.db \
  --name bot-marlene bot-marlene
```

> ⚠️ O volume `auth_info_baileys` é montado externamente para preservar a sessão do WhatsApp entre deploys. Se removê-lo, será necessário escanear o QR Code novamente.

---

## 💬 Comandos Especiais do WhatsApp

Estes comandos são enviados pelo **dono do aparelho** (mensagens `fromMe`):

| Comando | Ação |
|---------|------|
| Qualquer mensagem manual | **Silencia o bot** naquele chat (Human Takeover automático) |
| `!bot` | **Reativa o bot** naquele chat após intervenção humana |

---

## 🧬 Prompt Engineering e Diretrizes da IA

O sistema utiliza múltiplas camadas de prompts para controlar o comportamento da IA:

### Camada 1 — System Prompt (`ai_config.js`)
Define a persona base, informações da loja e instruções WhatsApp.

### Camada 2 — Regras Específicas (`aiService.js → specificRules`)
Regras rígidas de negócio, incluindo:

| Regra | Resumo |
|-------|--------|
| **Anti-Loop** | Se já perguntou e o cliente respondeu, não repita — venda! |
| **Zero Alucinação** | Se o contexto está vazio, nunca invente produtos |
| **Precificação** | Proibido inventar preços; se não está no contexto, confirmar no sistema |
| **Blocklist de Reserva** | Proibido usar "separar", "guardar", "reservar" proativamente |
| **Template de Fechamento** | [Cross-sell de 1 item] + "Precisa de mais algo?" |
| **Handoff Invisível** | Nunca mencionar "sistema", "banco de dados", "planilha" |
| **Handoff de Reserva** | Se o cliente pedir para reservar → transferir para humano |
| **Interpretação Fonética** | Corrigir erros ortográficos silenciosamente |
| **Negativa Proibida** | Nunca dizer "não temos" — sempre direcionar para humano verificar |

### Camada 3 — Keyword Expansion (`aiService.js → expandSearchQuery`)
Prompt especializado com 16 regras para gerar termos de busca precisos, incluindo:
- Correção ortográfica contextual
- Variações de cauda longa
- Remoção de stop words
- Proteção contra fragmentação de termos compostos
- Detecção de fornecedores
- Memória de contexto conversacional

### Camada 4 — Oráculo Visual (`aiService.js → verifyProductImageWithCatalog`)
Prompt multimodal que compara a foto do cliente com gabaritos do catálogo local.

---

## 📅 Feriados e Exceções de Horário

Edite o arquivo `data/store_exceptions.json` para cadastrar dias especiais:

```json
[
  {
    "date": "2026-05-01",
    "reason": "Dia do Trabalhador",
    "returnDate": "Sábado às 08:00"
  }
]
```

O bot detecta automaticamente o feriado pelo fuso `America/Sao_Paulo` e informa ao cliente que a loja está fechada com o motivo e a previsão de reabertura.

---

## 🔧 Troubleshooting

| Problema | Solução |
|----------|---------|
| QR Code não aparece | Verifique se a porta 3000 não está em uso. Delete a pasta `auth_info_baileys/` e reinicie. |
| Bot não responde | Verifique se `Power` está ligado no Dashboard. Confira logs com `docker logs bot-marlene`. |
| "lastMedia is not defined" | Atualizar para a versão mais recente — variável legada substituída por `imageParts[]`. |
| Busca retornando produtos errados | Verifique se as tags na planilha estão preenchidas corretamente. Ajuste o `threshold` do Fuse.js se necessário. |
| IA inventando preços | Confirme que a regra `[REGRA DE PRECIFICAÇÃO]` está ativa no `aiService.js`. |
| Bot respondendo após humano intervir | O mecanismo de Human Takeover deveria ter silenciado. Envie `!bot` para reativar e teste novamente. |
| API Gemini retornando 429 | O bot tem retry automático com backoff exponencial. Se persistir, verifique seu plano/quota no Google AI Studio. |
| Erro no Docker build | Certifique-se de que o `entrypoint.sh` tem line endings Unix (LF). O Dockerfile já aplica `sed -i 's/\r$//'`. |

---

## 📄 Licença

Este projeto é de uso privado da **Ferragem Marlene** — Igrejinha/RS.

---

<p align="center">
  Feito com 🔩 por <strong>Murilo Wilbert</strong> — Ferragem Marlene, Igrejinha/RS
</p>