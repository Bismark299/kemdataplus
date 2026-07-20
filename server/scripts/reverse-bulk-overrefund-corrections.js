/**
 * Reversal script: undo the ADMIN-RECOVERY-OVERREFUND bulk deductions applied
 * on 20 Jul 2026 by recover-overrefunds.js.
 *
 * Context: recover-overrefunds.js applied lump-sum bulk deductions with no
 * order breakdown. recover-new-overrefunds.js then applied per-order
 * RECOVERY-ORD-* deductions for the SAME over-refund orders. This caused all
 * four agents below to be double-charged.
 *
 * This script credits back the bulk (ADMIN-RECOVERY-OVERREFUND) deduction for
 * each agent, leaving the accurate per-order RECOVERY-ORD-* entries in place.
 *
 * DRY RUN by default. Set DRY_RUN=false to commit.
 * Run: node server/scripts/reverse-bulk-overrefund-corrections.js
 * Run: DRY_RUN=false node server/scripts/reverse-bulk-overrefund-corrections.js
 */
const { PrismaClient } = require('@prisma/client');
const { v4: uuidv4 } = require('uuid');
const prisma = new PrismaClient();

const DRY_RUN = process.env.DRY_RUN !== 'false';

function r2(n) { return Math.round(n * 100) / 100; }

async function main() {
  if (DRY_RUN) console.log('=== DRY RUN — no changes will be committed ===\n');
  else         console.log('=== LIVE RUN — committing reversals ===\n');

  const agents = [
    { email: 'kwekutheo59@gmail.com',     name: 'Flashdealsgh'   },
    { email: 'kenethkumesi@gmail.com',    name: 'Kenneth'         },
    { email: 'charlescam55@gmail.com',    name: 'Notify'          },
    { email: 'lawrencekumah99@gmail.com', name: 'Lawrence Kumah'  },
  ];

  let totalReversed = 0;
  let skipped = 0;

  for (const agent of agents) {
    // Load user + wallet
    const user = await prisma.user.findUnique({
      where: { email: agent.email },
      include: { wallet: true },
    });

    if (!user?.wallet) {
      console.log(`⚠  SKIP  ${agent.name} — user/wallet not found`);
      skipped++;
      continue;
    }

    const wallet = user.wallet;

    // Find the original bulk deduction entry
    const bulkRef = `ADMIN-RECOVERY-OVERREFUND-${user.id}`;
    const original = await prisma.walletLedger.findUnique({ where: { reference: bulkRef } });

    if (!original) {
      console.log(`⚠  SKIP  ${agent.name} — original bulk entry not found (ref: ${bulkRef})`);
      skipped++;
      continue;
    }

    const bulkAmount = Math.abs(original.amount); // e.g. 607.60
    const reversalRef = `REVERSAL-${bulkRef}`;

    // Idempotency: skip if reversal already applied
    const existing = await prisma.walletLedger.findFirst({ where: { reference: reversalRef } });
    if (existing) {
      console.log(`⏩  ALREADY DONE  ${agent.name} — reversal already applied`);
      skipped++;
      continue;
    }

    const newBalance = r2(wallet.balance + bulkAmount);

    console.log(
      `${DRY_RUN ? '[DRY]' : '✓ REVERSED'}  ${agent.name}` +
      `  refund +GH₵${bulkAmount.toFixed(2)}` +
      `  balance: GH₵${wallet.balance.toFixed(2)} → GH₵${newBalance.toFixed(2)}`
    );

    if (!DRY_RUN) {
      await prisma.$transaction(async (tx) => {
        await tx.walletLedger.create({
          data: {
            id: uuidv4(),
            walletId: wallet.id,
            entryType: 'REFUND',
            amount: bulkAmount,
            runningBalance: newBalance,
            description:
              `Reversal of erroneous bulk over-refund deduction (20 Jul 2026). ` +
              `ADMIN-RECOVERY-OVERREFUND was a duplicate of per-order RECOVERY-ORD-* entries.`,
            reference: reversalRef,
          },
        });

        await tx.wallet.update({
          where: { id: wallet.id },
          data: { balance: newBalance },
        });

        await tx.auditLog.create({
          data: {
            userId: user.id,
            action: 'ADMIN_OVERRIDE',
            entityType: 'Wallet',
            entityId: wallet.id,
            newValues: {
              reason: 'reversal of double-charge: bulk ADMIN-RECOVERY-OVERREFUND was duplicate of per-order recoveries',
              credited: bulkAmount,
              balanceBefore: wallet.balance,
              balanceAfter: newBalance,
              originalRef: bulkRef,
              reversalRef,
            },
          },
        });
      });
    }

    totalReversed += bulkAmount;
  }

  console.log('\n=== SUMMARY ===');
  console.log(`Total reversed : GH₵${r2(totalReversed).toFixed(2)}`);
  console.log(`Skipped        : ${skipped} agent(s)`);
  if (DRY_RUN) console.log('\nRe-run with DRY_RUN=false to commit.');
}

main()
  .catch(err => { console.error('Script failed:', err); process.exit(1); })
  .finally(() => prisma.$disconnect());
