/**
 * One-off reconciliation script.
 *
 * Finds orders where the fulfillment side (legacy Order / OrderItem) is
 * COMPLETED but the linked StorefrontOrder never got the update (the sync
 * gap that existed before the fix to updateItemStatus()/processOrderItems()).
 *
 * Usage:
 *   node scripts/reconcile-storefront-orders.js            # dry run (default)
 *   node scripts/reconcile-storefront-orders.js --apply    # actually fix + credit profit
 */
const prisma = require('../src/lib/prisma');

const APPLY = process.argv.includes('--apply');

async function main() {
  console.log(`[Reconcile] Mode: ${APPLY ? 'APPLY (will write + credit profit)' : 'DRY RUN (read-only)'}`);

  // 1. Orders whose fulfillment (legacy Order) is COMPLETED but StorefrontOrder lags behind.
  const mismatched = await prisma.order.findMany({
    where: {
      status: 'COMPLETED',
      storefrontOrderId: { not: null }
    },
    include: { storefrontOrder: true }
  });

  const needsFix = mismatched.filter(o => o.storefrontOrder && o.storefrontOrder.status !== 'COMPLETED');

  console.log(`[Reconcile] Scanned ${mismatched.length} completed orders with a storefront link.`);
  console.log(`[Reconcile] Found ${needsFix.length} StorefrontOrder rows stuck behind (not COMPLETED).`);

  for (const o of needsFix) {
    console.log(
      `  - Order ${o.reference} (COMPLETED) -> StorefrontOrder ${o.storefrontOrderId} is currently '${o.storefrontOrder.status}'` +
      ` | paymentMethod=${o.storefrontOrder.paymentMethod} | profitCredited=${o.storefrontOrder.profitCredited}`
    );
  }

  // 2. Also catch OrderItems that are COMPLETED but whose legacy Order row lags behind
  //    (i.e. the legacy Order itself was never updated at all — deeper sync gap).
  const completedItems = await prisma.orderItem.findMany({
    where: { status: 'COMPLETED' },
    select: { id: true, reference: true }
  });

  let deeperGapCount = 0;
  const deeperGapRefs = [];
  for (const item of completedItems) {
    const orderRef = item.reference?.replace(/-\d+$/, '');
    if (!orderRef) continue;
    const order = await prisma.order.findFirst({ where: { reference: orderRef } });
    if (order && order.status !== 'COMPLETED') {
      deeperGapCount++;
      deeperGapRefs.push({ itemRef: item.reference, orderRef, orderId: order.id, orderStatus: order.status, storefrontOrderId: order.storefrontOrderId });
    }
  }
  console.log(`[Reconcile] Found ${deeperGapCount} legacy Orders stuck behind their completed OrderItem.`);
  for (const r of deeperGapRefs) {
    console.log(`  - OrderItem ${r.itemRef} COMPLETED, legacy Order ${r.orderRef} is '${r.orderStatus}'`);
  }

  if (!APPLY) {
    console.log('[Reconcile] Dry run only — no changes made. Re-run with --apply to fix.');
    return;
  }

  // --- APPLY: fix the deeper gap first (legacy Order lagging behind OrderItem) ---
  let legacyFixed = 0;
  for (const r of deeperGapRefs) {
    await prisma.order.update({
      where: { id: r.orderId },
      data: { status: 'COMPLETED', processedAt: new Date() }
    });
    legacyFixed++;
  }
  console.log(`[Reconcile] Fixed ${legacyFixed} legacy Order rows to COMPLETED.`);

  // --- APPLY: fix StorefrontOrder rows + credit profit ---
  const financialOrderService = require('../src/services/financial-order.service');

  // Re-fetch after the legacy fix above, since some orders just became eligible.
  const toFix = await prisma.order.findMany({
    where: {
      status: 'COMPLETED',
      storefrontOrderId: { not: null }
    },
    include: { storefrontOrder: true }
  });

  let sfFixed = 0;
  let profitsCredited = 0;
  let profitsSkipped = 0;

  for (const o of toFix) {
    if (!o.storefrontOrder || o.storefrontOrder.status === 'COMPLETED') continue;

    await prisma.storefrontOrder.update({
      where: { id: o.storefrontOrderId },
      data: { status: 'COMPLETED' }
    });
    sfFixed++;

    try {
      const result = await financialOrderService.creditAgentProfit(o.storefrontOrderId);
      if (result.credited) {
        profitsCredited++;
        console.log(`  - Credited profit for StorefrontOrder ${o.storefrontOrderId}: GHS ${result.amount ?? 0}`);
      } else {
        profitsSkipped++;
      }
    } catch (e) {
      console.error(`  - Profit credit failed for ${o.storefrontOrderId}: ${e.message}`);
    }
  }

  console.log(`[Reconcile] Fixed ${sfFixed} StorefrontOrder rows to COMPLETED.`);
  console.log(`[Reconcile] Credited profit for ${profitsCredited} orders (${profitsSkipped} skipped — MoMo orders or already credited).`);
  console.log('[Reconcile] Done.');
}

main()
  .catch(err => {
    console.error('[Reconcile] Fatal error:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
