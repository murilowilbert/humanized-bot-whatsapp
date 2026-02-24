const xlsx = require('xlsx');
const fs = require('fs');

if (!fs.existsSync('data/estoque.xlsx')) {
    const wb = xlsx.utils.book_new();
    const headers = ["Codigo", "Produto", "Preco", "Estoque", "Descricao", "Categoria", "Unidade"];
    const data = [
        headers,
        ["1001", "Martelo Unha", 25.90, 10, "Martelo de aço forjado cabo madeira", "Ferramentas", "un"],
        ["1002", "Chave de Fenda 1/4", 12.50, 5, "Chave fenda ponta chata", "Ferramentas", "un"],
        ["1003", "Cimento Votoran", 35.00, 0, "Saco de 50kg CP II", "Material Básico", "sc"],
        ["1004", "Tinta Suvinil Branco", 120.00, 2, "Lata 18L Acrilico Fosco", "Pintura", "lata"],
        ["1005", "Tijolo 6 Furos", 1.50, 1000, "Tijolo cerâmico 9x14x19", "Material Básico", "milheiro"],
        ["1006", "Broca Videa 6mm", 8.00, 20, "Broca para concreto 6mm", "Acessórios", "un"]
    ];

    // Create sheet
    const ws = xlsx.utils.aoa_to_sheet(data);

    // Add to workbook
    xlsx.utils.book_append_sheet(wb, ws, "Estoque");

    // Write file
    xlsx.writeFile(wb, 'data/estoque.xlsx');
    console.log("Estoque inicial 'data/estoque.xlsx' criado com sucesso.");
} else {
    console.log("Arquivo 'data/estoque.xlsx' já existe.");
}
