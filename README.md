# Ferragem Marlene - Whatsapp Stock Bot 🤖🛠️

Um assistente virtual avançado para lojas de materiais de construção e ferragens. Construído com **Node.js, Baileys (WhatsApp Web API)** e o poder do **Modelo Multimodal Gemini (1.5 Flash)**.

Esta aplicação revoluciona o balcão de atendimento transformando o WhatsApp em um consultor de vendas em tempo real, integrado à planilhas de estoque e com visão computacional para auditoria de manutenção mecânica.

---

## 🚀 Funcionalidades Principais (As 8 Features)

O bot conta com um ecossistema complexo de funil de vendas, dividido nas seguintes engrenagens:

1. **Inteligência Artificial Humanizada:** Não parece um robô. Fala com gírias corporativas de balcão (cumpadre, amigão), tem memória de conversa (`Prisma SQLite`) e adequa os nomes maiúsculos do banco de dados (ex: `PARAF SEX 12X45`) para formatos amigáveis ("Parafuso Sextavado 12x45").
2. **Sistema de "Handoff" Dinâmico (Mute):** Quando o assunto é complexo ou um orçamento corporativo, o bot "sai de cena", avisa o cliente que um humano vai assumir o balcão, e fica em silêncio (até o dia seguinte).
3. **Menu Dinâmico de Desambiguação:** O cliente pediu "tinta" ou "parafuso"? O banco de dados vai retornar milhares de itens. Invés do bot explodir a tela, ele cria um menu reduzido: *"Tenho vários tipos! Você procura pra 1. Parede, ou 2. Madeira?"*
4. **Verificação de Estoque em Tempo Real (Scraper Híbrido):** Antes da IA dizer "sim nós temos 3 unidades", o bot ativa o `Puppeteer` em background rodando Headless e varre o sistema central da empresa usando requisições Lazy Evaluation em Singleton (Mutex) para checar se as unidades estão presas num carrinho de outra pessoa pelo PDV!
5. **Redirecionamento para Grupo VIP:** O cliente pediu algo que estava com "Estoque 0" no Scraper? A IA aborta a venda, gera um Upsell para ele entrar no grupo exclusivo onde a loja anuncia quando chegam mercadorias.
6. **Dashboard Analítico e Demanda Reprimida:** Quantas vendas de peças faltantes foram perdidas ontem? O bot armazena cada frustração de estoque num banco `SQLite`. Ao acessar seu servidor `http://localhost:3000/admin/dashboard` você visualiza o Ranking Top 10 coisas que você Precisa comprar para a sua loja lucrar amanhã.
7. **Oráculo de Manutenção (Vision Base):** Cliente mandou uma foto de uma torneira que não desliga ou de um esmeril sem capa protetora? A IA não diz apenas "é uma torneira", o Prompt Multimodal estrito instrui a adivinhar **a peça de reposição faltante necessária para o conserto**.
8. **Verificação de Gabarito Cego:** Chegou uma imagem, o Bot carrega as fotos do seu almoxarifado local (`data/fotos_sheets/1234.jpg`) cruzando a foto do cliente com 3 fotos de catálogo usando o Gemini para uma auditoria visual 100% matadora com o sistema da loja.

---

## ⚙️ Pré-Requisitos e Instalação

* **Node.js** (Versão 18 ou superior)
* **Google Chrome / Chromium** (Para o Puppeteer rodar o Scraper Web localmente)

1. Clone ou baixe esse repositório na sua máquina Servidor/PDV.
2. Abra o terminal na pasta do projeto e rode:
   ```bash
   npm install
   ```
3. Crie o Banco de Dados inicial (Demanda Reprimida + Histórico de Mensagens):
   ```bash
   npx prisma migrate dev --name init
   npx prisma generate
   ```

## 🔐 Configurando o Ambiente (.env)

Crie um arquivo `.env` puro na raiz do projeto contendo as seguintes credenciais:

```env
GEMINI_API_KEY="SUA_CHAVE_AQUI"
WHATSAPP_PHONE_NUMBER="55DDD99999999"

# Url Pública (Apenas se não quer ler do ./data/estoque.xlsx)
GOOGLE_SHEETS_CSV_URL="URL_COMPLETA_AQUI_OPCIONAL"

# Configurações do Scraper Puppeteer (Sistema Real-Time do PDV da loja)
SNAPCONTROL_URL="https://sua-empresa.snapcontrol.com.br/...."
SNAPCONTROL_USER="ferragens.marlene"
SNAPCONTROL_PASS="12345"

# Credencial para logar no http://localhost:3000/admin/dashboard
DASHBOARD_USER="admin"
DASHBOARD_PASS="suasenha"
```

## 📦 Estrutura Essencial de Dados

Para que o bot opere offline e veloz com 10.000+ linhas de itens sem sobrecarregar a memória com imagens, posicione três itens corretamente na pasta `data/`:

* `data/estoque.xlsx`: Sua planilha com colunas (obrigatório: `Código` ou `codigo`, `Produto` ou `modelo/produto`).
* `data/fotos_sheets/`: Diretório de imagens do seu sistema. Cada imagem de um produto **DEVE** ter o nome estritamente igual a coluna `codigo` (ex: `123789.jpg` ou `123789.png`).
* `dev.db`: Arquivo prisma de histórico (não apague manuamelte). 

## 🤖 Como Iniciar o Sistema

Rode o Index principal, ou clique no `start_bot.bat` (se estiver no Windows).

```bash
node index.js
```

1. Na sua primeira rodada, o `qrcode-terminal` vai printar um QRCode gigante no seu CMD/Terminal black. Sincronize com o Whatsapp Web no celular da Loja.
2. Ao ler o código com sucesso, você terá ativado dois serviços simultâneos:
    * As **conexões WebSocket** interceptando mensagens no número oficial da loja.
    * O **Dashboard Port 3000** ligando `app.js` escutando interações no painel gerencial restrito pela senha do `.env`.

> ⚠️ **Reset Inteligente:** O bot apaga o histórico e des-Muta todo usuário bloqueado virando a madrugada! A regra é `se diaHoje != pausedDate, reativar`.

**Sua Ferragem Oficialmente Automatizada e Escalando Faturamentos!** 🔥🔩