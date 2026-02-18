/**
 * Shared Prisma Client Singleton
 * ==============================
 * All files should import from here to avoid creating multiple connection pools.
 * Each new PrismaClient() creates a new connection pool, which can exhaust
 * the database's connection limit (typically 20-100).
 */

const { PrismaClient } = require('@prisma/client');

// Create a single shared instance
const prisma = global.prisma || new PrismaClient({
  log: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
});

// In development, store on global to prevent multiple instances during hot-reload
if (process.env.NODE_ENV !== 'production') {
  global.prisma = prisma;
}

module.exports = prisma;
