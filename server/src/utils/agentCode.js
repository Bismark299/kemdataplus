/**
 * Agent Code Generator
 * ====================
 * Generates and assigns unique KDP-XXXX codes for agents.
 * Codes are stored in the database with a unique constraint.
 */

const prisma = require('../lib/prisma');

/**
 * Derive a KDP code from a UUID (matches the old client-side logic
 * so existing users keep the same displayed code when backfilled).
 */
function deriveCodeFromId(userId) {
  const hash = userId.toString().replace(/-/g, '').slice(-4);
  const numericCode = parseInt(hash, 16) % 10000 || parseInt(userId.slice(-4)) || 1000;
  return 'KDP-' + String(numericCode).padStart(4, '0');
}

/**
 * Assign a unique agent code to a user.
 * Tries the UUID-derived code first; on collision, finds the next available.
 * @param {string} userId - The user's UUID
 * @param {object} [tx] - Optional Prisma transaction client
 * @returns {string} The assigned KDP-XXXX code
 */
async function assignAgentCode(userId, tx) {
  const db = tx || prisma;

  // Start from the UUID-derived code
  const preferred = deriveCodeFromId(userId);
  const startNum = parseInt(preferred.slice(4));

  // Get all currently taken codes in one query
  const taken = await db.user.findMany({
    where: { agentCode: { not: null }, NOT: { id: userId } },
    select: { agentCode: true }
  });
  const takenSet = new Set(taken.map(u => u.agentCode));

  // Try preferred code first
  if (!takenSet.has(preferred)) return preferred;

  // Find next available code
  for (let i = 1; i < 10000; i++) {
    const candidate = 'KDP-' + String((startNum + i) % 10000).padStart(4, '0');
    if (!takenSet.has(candidate)) return candidate;
  }

  throw new Error('No available agent codes — all 10,000 KDP codes are in use');
}

module.exports = { deriveCodeFromId, assignAgentCode };
