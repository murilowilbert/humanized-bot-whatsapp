const { PrismaClient } = require('@prisma/client');

// PrismaClient Singleton para evitar múltiplos pools de conexão no SQLite
const prisma = new PrismaClient();

module.exports = prisma;
