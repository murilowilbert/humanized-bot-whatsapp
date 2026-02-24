module.exports = {
    // Basic settings
    storeName: 'Ferragem Marlene',
    workingHours: {
        // 0 = Domingo, 1 = Segunda, ..., 6 = Sábado
        1: [{ start: '08:00', end: '12:00' }, { start: '13:30', end: '19:00' }], // Seg
        2: [{ start: '08:00', end: '12:00' }, { start: '13:30', end: '19:00' }], // Ter
        3: [{ start: '08:00', end: '12:00' }, { start: '13:30', end: '19:00' }], // Qua
        4: [{ start: '08:00', end: '12:00' }, { start: '13:30', end: '19:00' }], // Qui
        5: [{ start: '08:00', end: '12:00' }, { start: '13:30', end: '19:00' }], // Sex
        6: [{ start: '08:00', end: '12:00' }, { start: '14:00', end: '17:30' }], // Sab
        0: [] // Dom (Vazio = Fechado)
    },
    messages: {
        welcome: "Olá! Bem-vindo à Ferragem Marlene. Sou seu assistente virtual. Como posso ajudar com sua obra hoje? 🛠️",
        closed: "No momento estamos fechados. Verifique nossos horários no perfil ou mande sua dúvida que responderemos assim que abrirmos!",
        human_handoff: "Entendi, essa questão exige um especialista humano. Estou fixando nossa conversa e um atendente da Ferragem Marlene vai te chamar em breve!",
        group_invite: "Poxa, esse item acabou no estoque 😕. Mas ó, entra no nosso Grupo VIP! A gente sempre avisa lá quando chega reposição: [Link do Grupo]"
    }
};
