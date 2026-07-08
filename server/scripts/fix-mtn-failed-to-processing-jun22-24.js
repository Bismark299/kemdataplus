/**
 * fix-mtn-failed-to-processing-jun22-24.js
 *
 * One-off repair script: flips FAILED MTN orders/order items placed
 * between 2026-06-22 and 2026-06-24 (inclusive) back to PROCESSING,
 * so the existing auto-sync poller (runs every 30s) will pick them up
 * and re-check/confirm their real status with the provider.
 *
 * Safe by default: runs as a DRY RUN (just lists what would change).
 * Pass --apply to actually perform the update.
 *
 * Usage (on Render, via Shell tab):
 *   node scripts/fix-mtn-failed-to-processing-jun22-24.js            (dry run)
 *   node scripts/fix-mtn-failed-to-processing-jun22-24.js --apply    (applies changes)
 */

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const APPLY = process.argv.includes('--apply');

// Inclusive start, exclusive end (covers all of June 22, 23, 24)
const START = new Date('2026-06-22T00:00:00.000Z');
const END = new Date('2026-06-25T00:00:00.000Z');

async function main() {
  console.log(`\nMode: ${APPLY ? 'APPLY (will write changes)' : 'DRY RUN (no changes will be made)'}`);
  console.log(`Date range: ${START.toISOString()} -> ${END.toISOString()}\n`);

  const failedOrders = await prisma.order.findMany({
    where: {
      status: 'FAILED',
      createdAt: { gte: START, lt: END },
      bundle: { network: 'MTN' }
    },
    select: {
      id: true, reference: true, recipientPhone: true,
      externalReference: true, failureReason: true, createdAt: true
    },
    orderBy: { createdAt: 'asc' }
  });

  const failedItems = await prisma.orderItem.findMany({
    where: {
      status: 'FAILED',
      createdAt: { gte: START, lt: END },
      bundle: { network: 'MTN' }
    },
    select: {
      id: true, reference: true, recipientPhone: true,
      externalReference: true, failureReason: true, createdAt: true
    },
    orderBy: { createdAt: 'asc' }
  });

  console.log(`Found ${failedOrders.length} legacy FAILED MTN Orders:`);
  failedOrders.forEach(o =>
    console.log(`  ${o.reference} | ${o.recipientPhone} | extRef: ${o.externalReference || '-'} | reason: ${o.failureReason || '-'} | ${o.createdAt.toISOString()}`)
  );

  console.log(`\nFound ${failedItems.length} FAILED MTN OrderItems:`);
  failedItems.forEach(o =>
    console.log(`  ${o.reference} | ${o.recipientPhone} | extRef: ${o.externalReference || '-'} | reason: ${o.failureReason || '-'} | ${o.createdAt.toISOString()}`)
  );

  const total = failedOrders.length + failedItems.length;
  if (total === 0) {
    console.log('\nNothing to update. Exiting.');
    return;
  }

  if (!APPLY) {
    console.log(`\n${total} record(s) would be updated to PROCESSING.`);
    console.log('Re-run with --apply to actually make this change.');
    return;
  }

  console.log(`\nApplying: updating ${total} record(s) to PROCESSING...`);

  const orderResult = await prisma.order.updateMany({
    where: {
      status: 'FAILED',
      createdAt: { gte: START, lt: END },
      bundle: { network: 'MTN' }
    },
    data: { status: 'PROCESSING', failureReason: null }
  });

  const itemResult = await prisma.orderItem.updateMany({
    where: {
      status: 'FAILED',
      createdAt: { gte: START, lt: END },
      bundle: { network: 'MTN' }
    },
    data: { status: 'PROCESSING', failureReason: null }
  });

  console.log(`\nDone.`);
  console.log(`  Orders updated: ${orderResult.count}`);
  console.log(`  OrderItems updated: ${itemResult.count}`);
  console.log(`\nThe auto-sync poller (every 30s) will now re-check these against the provider and update them to COMPLETED/FAILED based on real status.`);
}

main()
  .catch(e => { console.error('Error:', e); process.exit(1); })
  .finally(() => prisma.$disconnect());
