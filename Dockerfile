FROM node:20

# Instala as dependências do sistema operacional para o navegador invisível
RUN apt-get update && apt-get install -y wget gnupg \
    && wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | apt-key add - \
    && sh -c 'echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" >> /etc/apt/sources.list.d/google.list' \
    && apt-get update && apt-get install -y google-chrome-stable

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .

# ESSA É A LINHA QUE VAI SALVAR O DIA:
RUN npx prisma generate

CMD npx prisma db push && node index.js
