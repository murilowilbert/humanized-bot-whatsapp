require('dotenv').config();
const { searchProductInSheet } = require('./src/services/googleSheetsService');

async function test() {
    const results = await searchProductInSheet("patinho zagonel");
    console.log(JSON.stringify(results, null, 2));
}

test();
