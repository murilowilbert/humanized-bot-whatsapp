const { genAI, modelConfig, SYSTEM_PROMPT } = require('./src/config/ai_config');

async function run() {
    const model = genAI.getGenerativeModel(modelConfig);
    const contents = [
        { role: 'user', parts: [{ text: '[Foto do Usuário]' }] }
    ];

    // Simulate stock Info
    const sessionPrompt = `### INFORMAÇÕES DA LOJA:\nFerragem Marlene.\n\n### ESTOQUE: Produto não encontrado para esta busca específica.\n\n### INSTRUÇÃO DE SESSÃO:\nEsta é a PRIMEIRA mensagem. Você DEVE saudar o cliente educadamente (Bom dia/Boa tarde/Boa noite) e perguntar como pode ajudar.`;

    const result = await model.generateContent({
        contents: contents,
        systemInstruction: {
            parts: [{ text: SYSTEM_PROMPT + "\n\n" + sessionPrompt }]
        }
    });

    console.log("RESPONSE TEXT:");
    console.log(result.response.text());
}

run().catch(console.error);
