/**
 * Backfill Agent Codes
 * ====================
 * Assigns unique KDP-XXXX codes to all existing users who don't have one.
 * Uses the same UUID-derivation logic so existing displayed codes stay the same.
 *
 * Usage: node server/prisma/backfill-agent-codes.js
 */

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

function deriveCodeFromId(userId) {
  const hash = userId.toString().replace(/-/g, '').slice(-4);
  const numericCode = parseInt(hash, 16) % 10000 || parseInt(userId.slice(-4)) || 1000;
  return 'KDP-' + String(numericCode).padStart(4, '0');
}

async function backfill() {
  const users = await prisma.user.findMany({
    where: { agentCode: null },
    select: { id: true },
    orderBy: { createdAt: 'asc' } // Oldest first get priority on preferred code
  });

  if (users.length === 0) {
    console.log('All users already have agent codes.');
    return;
  }

  console.log(`Backfilling ${users.length} users...`);

  // Get already-assigned codes
  const existing = await prisma.user.findMany({
    where: { agentCode: { not: null } },
    select: { agentCode: true }
  });
  const takenSet = new Set(existing.map(u => u.agentCode));

  let assigned = 0;
  for (const user of users) {
    let code = deriveCodeFromId(user.id);

    if (takenSet.has(code)) {
      // Collision — find next available
      const startNum = parseInt(code.slice(4));
      let found = false;
      for (let i = 1; i < 10000; i++) {
        const candidate = 'KDP-' + String((startNum + i) % 10000).padStart(4, '0');
        if (!takenSet.has(candidate)) {
          code = candidate;
          found = true;
          break;
        }
      }
      if (!found) {
        console.error('ERROR: All 10,000 KDP codes are in use!');
        break;
      }
    }

    await prisma.user.update({
      where: { id: user.id },
      data: { agentCode: code }
    });

    takenSet.add(code);
    assigned++;
  }

  console.log(`Done. Assigned codes to ${assigned} users.`);
}

backfill()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
