const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient({
  datasources: { db: { url: 'process.env.DATABASE_URL' } }
});

async function main() {
  const today = new Date('2026-05-07T00:00:00Z');

  // Failed Orders
  const failedOrders = await prisma.order.findMany({
    where: { status: 'FAILED', createdAt: { gte: today } },
    select: { id: true, reference: true, status: true, recipientPhone: true, externalReference: true, apiSentAt: true, failureReason: true, createdAt: true },
    orderBy: { createdAt: 'desc' }
  });

  // Failed OrderItems
  const failedItems = await prisma.orderItem.findMany({
    where: { status: 'FAILED', createdAt: { gte: today } },
    select: { id: true, reference: true, status: true, recipientPhone: true, externalReference: true, apiSentAt: true, failureReason: true, createdAt: true, orderGroupId: true },
    orderBy: { createdAt: 'desc' }
  });

  console.log('\n=== FAILED ORDERS (' + failedOrders.length + ') ===');
  failedOrders.forEach(o => {
    console.log(`  ${o.reference} | ${o.recipientPhone} | extRef: ${o.externalReference} | reason: ${o.failureReason} | ${o.createdAt}`);
  });

  console.log('\n=== FAILED ORDER ITEMS (' + failedItems.length + ') ===');
  failedItems.forEach(o => {
    console.log(`  ${o.reference} | ${o.recipientPhone} | extRef: ${o.externalReference} | reason: ${o.failureReason} | ${o.createdAt}`);
  });

  // Also check PENDING orders that may be stuck (created today, never sent)
  const stuckPending = await prisma.order.findMany({
    where: { status: 'PENDING', createdAt: { gte: today }, paymentStatus: 'PAID' },
    select: { id: true, reference: true, status: true, recipientPhone: true, externalReference: true, apiSentAt: true, failureReason: true, createdAt: true },
    orderBy: { createdAt: 'desc' }
  });

  console.log('\n=== STUCK PENDING PAID ORDERS (' + stuckPending.length + ') ===');
  stuckPending.forEach(o => {
    console.log(`  ${o.reference} | ${o.recipientPhone} | apiSentAt: ${o.apiSentAt} | reason: ${o.failureReason} | ${o.createdAt}`);
  });

  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
