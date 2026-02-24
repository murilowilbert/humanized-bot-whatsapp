const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') }); // Absolute path safer
const { GoogleGenerativeAI } = require("@google/generative-ai");

async function checkModels() {
    console.log("Verificando modelos disponíveis...");
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

    try {
        // For older SDKs, it might be different, but for 0.21+ this is standard
        // Does this SDK expose listModels directly on genAI or via a manager?
        // Actually, usually it's via a model manager or just creating a model and trying.
        // But the error message suggested "Call ListModels".
        // Let's try to find if the SDK has a list helper, if not we try a raw request.

        // Strategy A: Try to simulate a list via simple fetch if SDK doesn't make it obvious
        // But wait, the SDK usually has it.
        // Let's try to look up the SDK docs from memory or just try a standard fetch pattern since we have the key.

        const key = process.env.GEMINI_API_KEY;
        const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${key}`;

        const response = await fetch(url);
        const data = await response.json();

        if (data.models) {
            console.log("✅ Modelos Disponíveis para sua Chave:");
            data.models.forEach(m => {
                if (m.supportedGenerationMethods.includes('generateContent')) {
                    console.log(`- ${m.name.replace('models/', '')}`);
                }
            });
        } else {
            console.error("❌ Erro ao listar models:", data);
        }
    } catch (error) {
        console.error("❌ Erro fatal no teste:", error);
    }
}

checkModels();
