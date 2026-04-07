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

// ---------------------------------------------------------------------------
// Middleware: Fix floating-point precision issues on wallet balance fields.
// IEEE 754 double-precision math can produce tiny negatives like -7.1e-15
// after operations like 5.00 - 2.50 - 2.50, violating the DB constraint
// "wallet_balance_non_negative". This middleware rounds balance/lockedBalance/
// pendingBalance values to 2 decimal places on every wallet write.
// ---------------------------------------------------------------------------
prisma.$use(async (params, next) => {
  if (params.model === 'Wallet' && ['update', 'updateMany', 'upsert'].includes(params.action)) {
    const data = params.action === 'upsert'
      ? params.args.update
      : params.args.data;

    if (data) {
      const balanceFields = ['balance', 'lockedBalance', 'pendingBalance'];
      for (const field of balanceFields) {
        const val = data[field];
        if (val && typeof val === 'object') {
          // Round increment/decrement amounts to avoid accumulating fp errors
          if (typeof val.decrement === 'number') {
            val.decrement = Math.round(val.decrement * 100) / 100;
          }
          if (typeof val.increment === 'number') {
            val.increment = Math.round(val.increment * 100) / 100;
          }
        } else if (typeof val === 'number') {
          // Direct set — clamp tiny negatives to 0 and round
          data[field] = Math.round(Math.max(0, val) * 100) / 100;
        }
      }
    }
  }

  const result = await next(params);

  // Post-query safety: if a wallet query returns a tiny negative balance, fix it
  if (params.model === 'Wallet' && result && typeof result === 'object' && !Array.isArray(result)) {
    const balanceFields = ['balance', 'lockedBalance', 'pendingBalance'];
    let needsFix = false;
    for (const field of balanceFields) {
      if (typeof result[field] === 'number' && result[field] < 0 && result[field] > -0.01) {
        needsFix = true;
        break;
      }
    }
    if (needsFix && result.id) {
      const patch = {};
      for (const field of balanceFields) {
        if (typeof result[field] === 'number' && result[field] < 0 && result[field] > -0.01) {
          patch[field] = 0;
          result[field] = 0;
        }
      }
      // Fire-and-forget fix — don't block the response
      prisma.wallet.update({ where: { id: result.id }, data: patch }).catch(() => {});
    }
  }

  return result;
});

// In development, store on global to prevent multiple instances during hot-reload
if (process.env.NODE_ENV !== 'production') {
  global.prisma = prisma;
}

module.exports = prisma;
