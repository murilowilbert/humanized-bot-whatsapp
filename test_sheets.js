require('dotenv').config();
const { searchProductInSheet } = require('./src/services/googleSheetsService');

async function test() {
    console.log(await searchProductInSheet("ducha lorenzetti"));
}

test();
