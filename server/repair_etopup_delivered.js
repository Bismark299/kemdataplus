/**
 * ONE-TIME REPAIR: Mark all SUBMITTED etopup batch items as COMPLETED.
 *
 * Use this when you know etopup has delivered the orders but the system
 * failed to pick up the delivery status (sync bug).
 *
 * Affects: all OrderItems linked to a TopUpGHBatch with status SUBMITTED,
 *          where the item itself is still PROCESSING (not already resolved).
 *
 * Run: node repair_etopup_delivered.js
 * Run (dry-run): node repair_etopup_delivered.js --dry
 */

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const DRY_RUN = process.argv.includes('--dry');

async function main() {
  console.log(DRY_RUN ? '=== DRY RUN (no changes) ===' : '=== LIVE RUN ===');

  // Find all SUBMITTED batches (sent to etopup but never resolved)
  const batches = await prisma.topUpGHBatch.findMany({
    where : { status: 'SUBMITTED', topupghOrderId: { not: null } },
    include: { items: { where: { status: 'PROCESSING' } } },
    orderBy: { sentAt: 'asc' }
  });

  if (batches.length === 0) {
    console.log('No SUBMITTED batches found. Nothing to do.');
    return;
  }

  let totalItems = 0;
  const now = new Date();

  for (const batch of batches) {
    const processingItems = batch.items;
    console.log(`\nBatch ${batch.batchRef} (etopup order: ${batch.topupghOrderId}) — ${processingItems.length} PROCESSING item(s)`);

    if (processingItems.length === 0) {
      console.log(`  → Skipping (no PROCESSING items)`);
      continue;
    }

    for (const item of processingItems) {
      console.log(`  Item ${item.reference} | phone: ${item.recipientPhone}`);
    }

    if (!DRY_RUN) {
      // Mark all PROCESSING items in this batch as COMPLETED
      await prisma.orderItem.updateMany({
        where: {
          topupghBatchId : batch.id,
          status         : 'PROCESSING'
        },
        data: {
          status                : 'COMPLETED',
          processedAt           : now,
          topupghDeliveryStatus : 'delivered (manual repair)',
          failureReason         : null
        }
      });

      // Mark batch as DELIVERED
      await prisma.topUpGHBatch.update({
        where : { id: batch.id },
        data  : {
          status            : 'DELIVERED',
          deliveryCheckedAt : now
        }
      });

      // Update parent OrderGroup summaryStatus
      const orderGroupId = processingItems[0]?.orderGroupId;
      if (orderGroupId) {
        const allItems = await prisma.orderItem.findMany({
          where  : { orderGroupId },
          select : { status: true }
        });
        const allDone = allItems.every(i => i.status === 'COMPLETED' || i.status === 'FAILED');
        const anyCompleted = allItems.some(i => i.status === 'COMPLETED');
        if (allDone) {
          await prisma.orderGroup.update({
            where : { id: orderGroupId },
            data  : { status: anyCompleted ? 'COMPLETED' : 'FAILED', summaryStatus: anyCompleted ? 'COMPLETED' : 'FAILED' }
          });
        }
      }

      console.log(`  ✓ Marked ${processingItems.length} item(s) COMPLETED, batch DELIVERED`);
      totalItems += processingItems.length;
    } else {
      console.log(`  → Would mark ${processingItems.length} item(s) COMPLETED`);
      totalItems += processingItems.length;
    }
  }

  console.log(`\n${DRY_RUN ? '[DRY RUN]' : '[DONE]'} ${batches.length} batch(es), ${totalItems} item(s) ${DRY_RUN ? 'would be' : ''} marked COMPLETED`);
}

main()
  .catch(e => { console.error('Error:', e.message); process.exit(1); })
  .finally(() => prisma.$disconnect());
