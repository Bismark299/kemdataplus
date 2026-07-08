/**
 * freeze-failed-orders-as-processing-jun22-24.js
 *
 * Per explicit admin decision: freeze the 596 MTN OrderItems from
 * 2026-06-22 - 2026-06-24 (which genuinely failed at the DataGatekeeper
 * provider) on PROCESSING status, and disconnect them from the automatic
 * background status-checker so they stop flip-flopping back to FAILED.
 *
 * IMPORTANT CAVEAT (documented for future reference):
 * This does NOT deliver the bundles and does NOT refund the customers.
 * It only stops the system from re-verifying these orders against the
 * provider. They will sit as "Processing" indefinitely until someone
 * manually resolves them (refund or manual resend). A failureReason note
 * is preserved on each record explaining this for future admins.
 *
 * How it works: clears externalReference/externalStatus/apiSentAt so the
 * item no longer matches the DataGatekeeper sync query
 * (`externalReference: { startsWith: 'DGK-' }`) or any retry query
 * (which requires status PENDING), so it will never be auto-checked again.
 *
 * Safe by default: runs as a DRY RUN. Pass --apply to actually update.
 *
 * Usage (on Render, via Shell tab):
 *   node scripts/freeze-failed-orders-as-processing-jun22-24.js            (dry run)
 *   node scripts/freeze-failed-orders-as-processing-jun22-24.js --apply    (applies changes)
 */

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const APPLY = process.argv.includes('--apply');

const START = new Date('2026-06-22T00:00:00.000Z');
const END = new Date('2026-06-25T00:00:00.000Z');

const FREEZE_NOTE = 'FROZEN as PROCESSING by admin decision on 2026-07-08 — provider (DataGatekeeper) confirmed this order failed and was never delivered. Disconnected from auto status-checker. Requires manual resolution: refund customer or manually resend.';

async function main() {
  console.log(`\nMode: ${APPLY ? 'APPLY (will write changes)' : 'DRY RUN (no changes will be made)'}`);
  console.log(`Date range: ${START.toISOString()} -> ${END.toISOString()}\n`);

  const items = await prisma.orderItem.findMany({
    where: {
      createdAt: { gte: START, lt: END },
      bundle: { network: 'MTN' },
      OR: [
        { status: 'FAILED' },
        { status: 'PROCESSING', externalReference: { startsWith: 'DGK-' } }
      ]
    },
    select: { id: true, reference: true, status: true, externalReference: true }
  });

  console.log(`Found ${items.length} item(s) matching (FAILED, or still-PROCESSING-but-DGK-linked) in range.`);
  items.slice(0, 10).forEach(i => console.log(`  ${i.reference} | current status: ${i.status} | extRef: ${i.externalReference || '-'}`));
  if (items.length > 10) console.log(`  ...and ${items.length - 10} more`);

  if (items.length === 0) {
    console.log('\nNothing to update. Exiting.');
    return;
  }

  if (!APPLY) {
    console.log(`\n${items.length} item(s) would be frozen on PROCESSING (externalReference cleared).`);
    console.log('Re-run with --apply to actually make this change.');
    return;
  }

  console.log(`\nApplying: freezing ${items.length} item(s) on PROCESSING...`);

  const result = await prisma.orderItem.updateMany({
    where: { id: { in: items.map(i => i.id) } },
    data: {
      status: 'PROCESSING',
      externalReference: null,
      externalStatus: null,
      apiSentAt: null,
      apiConfirmedAt: null,
      failureReason: FREEZE_NOTE
    }
  });

  console.log(`\nDone. OrderItems frozen on PROCESSING: ${result.count}`);
}

main()
  .catch(e => { console.error('Error:', e); process.exit(1); })
  .finally(() => prisma.$disconnect());
