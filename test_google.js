require('dotenv').config();
const fs = require('fs');

function parseCSVRow(str) {
    const arr = [];
    let quote = false;
    let col = "";

    for (let c of str) {
        if (c === '"' && quote === false) { quote = true; continue; }
        if (c === '"' && quote === true) { quote = false; continue; }
        if (c === ',' && quote === false) { arr.push(col.trim()); col = ""; continue; }
        col += c;
    }
    arr.push(col.trim());
    return arr;
}

async function test() {
    const csvUrl = process.env.GOOGLE_SHEET_CSV_URL;
    const response = await fetch(csvUrl);
    const text = await response.text();
    const lines = text.split('\n').map(l => l.trim()).filter(l => l !== '');

    const headers = parseCSVRow(lines[0]).map(h => h.toLowerCase().trim());
    console.log("HEADERS:", headers);

    const rowValues = parseCSVRow(lines[1]);
    const item = {};
    for (let j = 0; j < headers.length; j++) {
        item[headers[j]] = rowValues[j] || "";
    }
    console.log("ITEM 1:", item);
}

test();
