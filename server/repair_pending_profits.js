/**
 * Repair Script: Fix corrupted pendingProfit records
 * 
 * Problem: A double-deduction bug in processSinglePayout() marked pendingProfit
 * records as PAID prematurely (before the transfer actually completed). The webhook
 * handleTransferSuccess() then also tried to mark them PAID. This resulted in MORE
 * profits being marked PAID than the actual withdrawal amounts.
 * 
 * Fix Logic:
 * For each agent:
 *   - correctPaidAmount = SUM(completed agentPayout amounts)
 *   - actualPaidAmount = SUM(pendingProfit WHERE status='PAID')
 *   - If actualPaidAmount > correctPaidAmount, reset the excess PAID records
 *     back to PENDING (newest first, since those are most likely the incorrectly marked ones)
 * 
 * Usage: node repair_pending_profits.js [--dry-run]
 *   --dry-run: Show what would be changed without actually making changes (default)
 *   --apply:   Actually apply the fixes
 */

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const args = process.argv.slice(2);
const dryRun = !args.includes('--apply');

async function repair() {
  console.log(`\n========================================`);
  console.log(`  PendingProfit Repair Script`);
  console.log(`  Mode: ${dryRun ? 'DRY RUN (no changes)' : 'APPLYING FIXES'}`);
  console.log(`========================================\n`);

  // Get all agents who have any pendingProfit records
  const agents = await prisma.user.findMany({
    where: {
      pendingProfits: { some: {} }
    },
    select: { id: true, name: true, phone: true }
  });

  console.log(`Found ${agents.length} agents with profit records.\n`);

  let totalAgentsFixed = 0;
  let totalRecordsFixed = 0;
  let totalAmountRestored = 0;

  for (const agent of agents) {
    // Get total completed withdrawal amount
    const completedPayouts = await prisma.agentPayout.aggregate({
      where: { userId: agent.id, status: 'COMPLETED' },
      _sum: { amount: true }
    });
    const correctPaidAmount = completedPayouts._sum.amount || 0;

    // Get total PAID pendingProfit amount
    const paidProfits = await prisma.pendingProfit.aggregate({
      where: { userId: agent.id, status: 'PAID' },
      _sum: { amount: true },
      _count: true
    });
    const actualPaidAmount = paidProfits._sum.amount || 0;
    const actualPaidCount = paidProfits._count || 0;

    // Get total PENDING pendingProfit amount
    const pendingProfits = await prisma.pendingProfit.aggregate({
      where: { userId: agent.id, status: 'PENDING' },
      _sum: { amount: true },
      _count: true
    });
    const pendingAmount = pendingProfits._sum.amount || 0;

    // Get all-time profit from orders (ground truth)
    const storefrontIds = (await prisma.storefront.findMany({
      where: { ownerId: agent.id },
      select: { id: true }
    })).map(s => s.id);

    const orderProfit = storefrontIds.length > 0
      ? (await prisma.storefrontOrder.aggregate({
          where: {
            storefrontId: { in: storefrontIds },
            status: { in: ['COMPLETED', 'PROCESSING'] }
          },
          _sum: { ownerProfit: true }
        }))._sum.ownerProfit || 0
      : 0;

    const overPaid = actualPaidAmount - correctPaidAmount;

    if (overPaid > 0.01) { // Small tolerance for floating point
      console.log(`--- ${agent.name} (${agent.phone}) ---`);
      console.log(`  Order profit (ground truth): GH₵ ${orderProfit.toFixed(2)}`);
      console.log(`  Completed withdrawals:       GH₵ ${correctPaidAmount.toFixed(2)}`);
      console.log(`  PendingProfit PAID total:    GH₵ ${actualPaidAmount.toFixed(2)} (${actualPaidCount} records)`);
      console.log(`  PendingProfit PENDING total: GH₵ ${pendingAmount.toFixed(2)}`);
      console.log(`  Over-marked as PAID:         GH₵ ${overPaid.toFixed(2)}`);
      console.log(`  Expected available:          GH₵ ${(orderProfit - correctPaidAmount).toFixed(2)}`);
      console.log(`  Current available (PENDING): GH₵ ${pendingAmount.toFixed(2)}`);

      // Find PAID records to reset, newest first (most likely to be the incorrectly marked ones)
      const paidRecords = await prisma.pendingProfit.findMany({
        where: { userId: agent.id, status: 'PAID' },
        orderBy: { paidAt: 'desc' }, // Newest paid first
        select: { id: true, amount: true, paidAt: true, description: true }
      });

      // Accumulate records to reset until we've covered the overPaid amount
      let amountToRestore = overPaid;
      const recordsToReset = [];

      for (const record of paidRecords) {
        if (amountToRestore <= 0.01) break;
        recordsToReset.push(record);
        amountToRestore -= record.amount;
      }

      console.log(`  Records to reset to PENDING: ${recordsToReset.length}`);
      const restoredAmount = recordsToReset.reduce((sum, r) => sum + r.amount, 0);
      console.log(`  Amount being restored:       GH₵ ${restoredAmount.toFixed(2)}`);

      if (!dryRun && recordsToReset.length > 0) {
        const idsToReset = recordsToReset.map(r => r.id);
        await prisma.pendingProfit.updateMany({
          where: { id: { in: idsToReset } },
          data: { status: 'PENDING', paidAt: null }
        });
        console.log(`  ✅ Fixed ${recordsToReset.length} records.`);
      } else if (recordsToReset.length > 0) {
        console.log(`  ⏩ Would fix ${recordsToReset.length} records (dry run).`);
      }

      totalAgentsFixed++;
      totalRecordsFixed += recordsToReset.length;
      totalAmountRestored += restoredAmount;
      console.log('');
    }
  }

  console.log(`========================================`);
  console.log(`  Summary`);
  console.log(`========================================`);
  console.log(`  Agents affected:   ${totalAgentsFixed}`);
  console.log(`  Records to fix:    ${totalRecordsFixed}`);
  console.log(`  Amount restored:   GH₵ ${totalAmountRestored.toFixed(2)}`);
  console.log(`  Mode:              ${dryRun ? 'DRY RUN — run with --apply to fix' : 'APPLIED'}`);
  console.log(`========================================\n`);
}

repair()
  .catch(err => {
    console.error('Repair failed:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
