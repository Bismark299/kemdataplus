/**
 * One-off reconciliation CLI wrapper around
 * orderGroupService.reconcileStorefrontOrders().
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
const orderGroupService = require('../src/services/order-group.service');

const APPLY = process.argv.includes('--apply');

async function main() {
  console.log(`[Reconcile] Mode: ${APPLY ? 'APPLY (will write + credit profit)' : 'DRY RUN (read-only)'}`);

  const report = await orderGroupService.reconcileStorefrontOrders(APPLY);

  console.log(`[Reconcile] Scanned ${report.storefrontOrdersScanned} completed orders with a storefront link.`);
  console.log(`[Reconcile] Found ${report.storefrontOrdersStuck.length} StorefrontOrder(s) stuck behind.`);
  for (const s of report.storefrontOrdersStuck) {
    console.log(`  - Order ${s.orderReference} -> StorefrontOrder ${s.storefrontOrderId} is '${s.currentStatus}' | paymentMethod=${s.paymentMethod} | profitCredited=${s.profitCredited}`);
  }

  console.log(`[Reconcile] Found ${report.legacyOrdersStuck.length} legacy Order(s) stuck behind their completed OrderItem.`);
  for (const s of report.legacyOrdersStuck) {
    console.log(`  - OrderItem ${s.itemReference} COMPLETED, legacy Order ${s.orderReference} is '${s.currentStatus}'`);
  }

  if (!APPLY) {
    console.log('[Reconcile] Dry run only — no changes made. Re-run with --apply to fix.');
    return;
  }

  console.log(`[Reconcile] Fixed ${report.legacyOrdersFixed} legacy Order rows to COMPLETED.`);
  console.log(`[Reconcile] Fixed ${report.storefrontOrdersFixed} StorefrontOrder rows to COMPLETED.`);
  console.log(`[Reconcile] Credited profit for ${report.profitsCredited} orders (${report.profitsSkipped} skipped — MoMo orders or already credited).`);
  if (report.errors.length) {
    console.log('[Reconcile] Errors:', report.errors);
  }
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
