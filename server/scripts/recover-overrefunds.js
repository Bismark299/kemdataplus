/**
 * One-time script: recover wallet over-refunds caused by the bulk-cancel bug.
 * The bug refunded orderGroup.totalAmount instead of item.totalPrice for each
 * cancelled item, giving some agents far more than they were owed.
 *
 * Run: node server/scripts/recover-overrefunds.js
 */
const { PrismaClient } = require('@prisma/client');
const { v4: uuidv4 } = require('uuid');

const prisma = new PrismaClient();

// Over-refund amounts calculated from production data (order ref → over-refund GH₵)
// Only users whose balance comfortably covers the deduction are included.
// Emmanuel Simpson (GH₵80 owed, GH₵1.60 balance) and Dela Kwesi (GH₵8 owed, GH₵3.80 balance)
// are excluded — cannot recover without going negative.
const RECOVERIES = [
  { email: 'kwekutheo59@gmail.com',     name: 'Flashdealsgh',     amount: 607.60 },
  { email: 'kenethkumesi@gmail.com',    name: 'Kenneth',           amount: 350.50 },
  { email: 'charlescam55@gmail.com',    name: 'Notify',            amount: 347.00 },
  { email: 'lawrencekumah99@gmail.com', name: 'Lawrence Kumah',    amount: 8.00   },
];

async function main() {
  console.log('=== Over-refund Recovery Script ===\n');

  let totalRecovered = 0;
  let skipped = 0;

  for (const rec of RECOVERIES) {
    const user = await prisma.user.findUnique({
      where: { email: rec.email },
      include: { wallet: true }
    });

    if (!user || !user.wallet) {
      console.log(`⚠  SKIP  ${rec.name} (${rec.email}) — user/wallet not found`);
      skipped++;
      continue;
    }

    const wallet = user.wallet;
    const available = wallet.balance - (wallet.lockedBalance || 0);

    if (available < rec.amount) {
      console.log(`⚠  SKIP  ${rec.name} — insufficient balance (have GH₵${available.toFixed(2)}, need GH₵${rec.amount.toFixed(2)})`);
      skipped++;
      continue;
    }

    const reference = `ADMIN-RECOVERY-OVERREFUND-${user.id}`;

    // Check if already applied (idempotent)
    const existing = await prisma.walletLedger.findUnique({ where: { reference } });
    if (existing) {
      console.log(`⏩  SKIP  ${rec.name} — recovery already applied (ref exists)`);
      skipped++;
      continue;
    }

    const newBalance = Math.round((wallet.balance - rec.amount) * 1e10) / 1e10;

    await prisma.$transaction(async (tx) => {
      await tx.walletLedger.create({
        data: {
          id: uuidv4(),
          walletId: wallet.id,
          entryType: 'PURCHASE',
          amount: -rec.amount,
          runningBalance: newBalance,
          description: `Admin correction: over-refund recovery (bulk-cancel bug). Excess refund deducted.`,
          reference,
        }
      });

      await tx.wallet.update({
        where: { id: wallet.id },
        data: { balance: newBalance }
      });

      await tx.auditLog.create({
        data: {
          userId: user.id,
          action: 'ADMIN_OVERRIDE',
          entityType: 'Wallet',
          entityId: wallet.id,
          newValues: {
            reason: 'over-refund recovery',
            deducted: rec.amount,
            balanceBefore: wallet.balance,
            balanceAfter: newBalance,
          }
        }
      });
    });

    console.log(`✓  RECOVERED  ${rec.name} (${rec.email}): -GH₵${rec.amount.toFixed(2)}  |  balance: GH₵${wallet.balance.toFixed(2)} → GH₵${newBalance.toFixed(2)}`);
    totalRecovered += rec.amount;
  }

  console.log('\n=== Summary ===');
  console.log(`Recovered : GH₵${totalRecovered.toFixed(2)}`);
  console.log(`Skipped   : ${skipped} user(s)`);
  console.log('\nUsers NOT recovered (balance too low — handle manually):');
  console.log('  - Emmanuel Simpson (blockerbee1@gmail.com)  owes GH₵80.00, balance GH₵1.60');
  console.log('  - Dela Kwesi       (kwesidela5670@gmail.com) owes GH₵8.00,  balance GH₵3.80');
}

main()
  .catch(err => { console.error('Script failed:', err); process.exit(1); })
  .finally(() => prisma.$disconnect());
