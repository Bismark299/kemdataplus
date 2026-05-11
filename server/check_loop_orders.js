const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient({
  datasources: { db: { url: 'process.env.DATABASE_URL' } }
});

async function main() {
  const ids = [
    '7143dfeb-7cf3-455f-8f25-3f496b4a3b2a',
    '96482d6a-e458-40b4-8d5d-30bf33b64196'
  ];

  console.log('=== Checking as OrderItem ===');
  const items = await prisma.orderItem.findMany({
    where: { id: { in: ids } },
    include: { orderGroup: { select: { id: true, displayId: true, status: true, summaryStatus: true } } }
  });
  console.log(JSON.stringify(items, null, 2));

  console.log('\n=== Checking as Order ===');
  const orders = await prisma.order.findMany({
    where: { id: { in: ids } },
    select: { id: true, reference: true, status: true, recipientPhone: true, externalReference: true, apiSentAt: true, failureReason: true, paymentStatus: true, createdAt: true }
  });
  console.log(JSON.stringify(orders, null, 2));

  await prisma.$disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
