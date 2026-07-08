/**
 * fix-cancelled-storefront-sync-jun22-24.js
 *
 * One-off repair script: finds OrderItems that were cancelled by an admin
 * between 2026-06-22 and 2026-06-24 (inclusive) whose linked legacy Order
 * and/or StorefrontOrder were never synced to CANCELLED (they were left
 * stuck on PROCESSING/PENDING on the storefront "All Orders" page).
 *
 * This is the historical cleanup for the cancel-sync gap in
 * POST /admin/item/:itemId/cancel, which has now been fixed going
 * forward so new cancellations sync automatically via
 * orderGroupService.syncLegacyOrderStatus().
 *
 * Safe by default: runs as a DRY RUN (just lists what would change).
 * Pass --apply to actually perform the update.
 *
 * Usage (on Render, via Shell tab):
 *   node scripts/fix-cancelled-storefront-sync-jun22-24.js            (dry run)
 *   node scripts/fix-cancelled-storefront-sync-jun22-24.js --apply    (applies changes)
 */

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const APPLY = process.argv.includes('--apply');

const START = new Date('2026-06-22T00:00:00.000Z');
const END = new Date('2026-06-25T00:00:00.000Z');

async function main() {
  console.log(`\nMode: ${APPLY ? 'APPLY (will write changes)' : 'DRY RUN (no changes will be made)'}`);
  console.log(`Date range: ${START.toISOString()} -> ${END.toISOString()}\n`);

  const cancelledItems = await prisma.orderItem.findMany({
    where: {
      status: 'CANCELLED',
      createdAt: { gte: START, lt: END }
    },
    select: { id: true, reference: true, createdAt: true }
  });

  console.log(`Found ${cancelledItems.length} cancelled OrderItem(s) in range. Checking legacy Order / StorefrontOrder sync status...\n`);

  const legacyOrderIdsToFix = [];
  const storefrontOrderIdsToFix = [];
  const details = [];

  for (const item of cancelledItems) {
    const orderRef = item.reference?.replace(/-\d+$/, '');
    if (!orderRef) continue;

    const order = await prisma.order.findFirst({ where: { reference: orderRef } });
    if (!order) continue; // no legacy Order record for this item, nothing to sync

    const needsOrderFix = order.status !== 'CANCELLED' && order.status !== 'COMPLETED';
    let needsStorefrontFix = false;
    let storefrontOrder = null;

    if (order.storefrontOrderId) {
      storefrontOrder = await prisma.storefrontOrder.findUnique({ where: { id: order.storefrontOrderId } });
      if (storefrontOrder && storefrontOrder.status !== 'CANCELLED' && storefrontOrder.status !== 'COMPLETED') {
        needsStorefrontFix = true;
      }
    }

    if (needsOrderFix || needsStorefrontFix) {
      details.push({
        itemRef: item.reference,
        orderRef: order.reference,
        orderStatus: order.status,
        storefrontOrderId: order.storefrontOrderId,
        storefrontStatus: storefrontOrder?.status,
        needsOrderFix,
        needsStorefrontFix
      });
      if (needsOrderFix) legacyOrderIdsToFix.push(order.id);
      if (needsStorefrontFix) storefrontOrderIdsToFix.push(order.storefrontOrderId);
    }
  }

  console.log(`Stale record(s) found: ${details.length}`);
  details.forEach(d =>
    console.log(`  item ${d.itemRef} -> Order ${d.orderRef} (status: ${d.orderStatus}${d.needsOrderFix ? ' -> will fix' : ''}) | StorefrontOrder ${d.storefrontOrderId || '-'} (status: ${d.storefrontStatus || '-'}${d.needsStorefrontFix ? ' -> will fix' : ''})`)
  );

  if (details.length === 0) {
    console.log('\nNothing to update. Exiting.');
    return;
  }

  if (!APPLY) {
    console.log(`\n${legacyOrderIdsToFix.length} legacy Order(s) and ${storefrontOrderIdsToFix.length} StorefrontOrder(s) would be updated to CANCELLED.`);
    console.log('Re-run with --apply to actually make this change.');
    return;
  }

  console.log(`\nApplying fixes...`);

  if (legacyOrderIdsToFix.length > 0) {
    const r1 = await prisma.order.updateMany({
      where: { id: { in: legacyOrderIdsToFix } },
      data: { status: 'CANCELLED' }
    });
    console.log(`Legacy Orders updated: ${r1.count}`);
  }

  if (storefrontOrderIdsToFix.length > 0) {
    const r2 = await prisma.storefrontOrder.updateMany({
      where: { id: { in: storefrontOrderIdsToFix } },
      data: { status: 'CANCELLED' }
    });
    console.log(`StorefrontOrders updated: ${r2.count}`);
  }

  console.log('\nDone.');
}

main()
  .catch(e => { console.error('Error:', e); process.exit(1); })
  .finally(() => prisma.$disconnect());
