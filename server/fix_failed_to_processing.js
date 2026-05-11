/**
 * fix_failed_to_processing.js
 * 
 * Marks today's FAILED orders and order items as PROCESSING.
 * Use after manually fulfilling failed orders so auto-sync can confirm them.
 * 
 * Run: node fix_failed_to_processing.js
 */

const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient({
  datasources: {
    db: { url: 'process.env.DATABASE_URL' }
  }
});

async function main() {
  const today = new Date('2026-05-08T00:00:00Z');

  // --- Check what we're about to update ---
  const failedOrders = await prisma.order.findMany({
    where: { status: 'FAILED', createdAt: { gte: today } },
    select: { id: true, reference: true, recipientPhone: true, externalReference: true, failureReason: true, createdAt: true }
  });

  const failedItems = await prisma.orderItem.findMany({
    where: { status: 'FAILED', createdAt: { gte: today } },
    select: { id: true, reference: true, recipientPhone: true, externalReference: true, failureReason: true, createdAt: true }
  });

  console.log(`\nFailed Orders today: ${failedOrders.length}`);
  failedOrders.forEach(o => console.log(`  ${o.reference} | ${o.recipientPhone} | extRef: ${o.externalReference} | reason: ${o.failureReason}`));

  console.log(`\nFailed OrderItems today: ${failedItems.length}`);
  failedItems.forEach(o => console.log(`  ${o.reference} | ${o.recipientPhone} | extRef: ${o.externalReference} | reason: ${o.failureReason}`));

  const total = failedOrders.length + failedItems.length;
  if (total === 0) {
    console.log('\nNo failed orders found for today. Nothing to update.');
    return;
  }

  console.log(`\nUpdating ${total} records to PROCESSING...`);

  // --- Update Orders ---
  const orderResult = await prisma.order.updateMany({
    where: { status: 'FAILED', createdAt: { gte: today } },
    data: { status: 'PROCESSING', failureReason: null }
  });

  // --- Update OrderItems ---
  const itemResult = await prisma.orderItem.updateMany({
    where: { status: 'FAILED', createdAt: { gte: today } },
    data: { status: 'PROCESSING', failureReason: null }
  });

  console.log(`\n✅ Done!`);
  console.log(`   Orders updated: ${orderResult.count}`);
  console.log(`   OrderItems updated: ${itemResult.count}`);
}

main()
  .catch(e => { console.error('Error:', e); process.exit(1); })
  .finally(() => prisma.$disconnect());
