const client = require('./src/bot');
const server = require('./src/server/app');

console.log("Iniciando Sistema Ferragem Marlene...");

// 1. Start Dashboard Server
server.startServer();

console.log("Sistema Ferragem Marlene iniciado.");
console.log("Aguardando inicialização do Bot via Painel Web...");
