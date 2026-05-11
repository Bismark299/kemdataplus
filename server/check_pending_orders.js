const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  // Pending OrderItems with externalReference (submitted to API, waiting for status)
  const processingItems = await prisma.orderItem.findMany({
    where: { status: { in: ['PROCESSING', 'PENDING'] }, externalReference: { not: null } },
    select: { id: true, reference: true, status: true, externalReference: true, createdAt: true, apiSentAt: true },
    orderBy: { createdAt: 'asc' }
  });

  // Pending OrderItems with NO externalReference (never submitted to API)
  const neverSentItems = await prisma.orderItem.findMany({
    where: { status: 'PENDING', externalReference: null },
    select: { id: true, reference: true, status: true, createdAt: true, apiSentAt: true },
    orderBy: { createdAt: 'asc' }
  });

  // Legacy orders
  const legacyPending = await prisma.order.findMany({
    where: { status: { in: ['PROCESSING', 'PENDING'] }, externalReference: { not: null } },
    select: { id: true, reference: true, status: true, externalReference: true, createdAt: true },
    orderBy: { createdAt: 'asc' }
  });

  console.log('=== PROCESSING/PENDING OrderItems WITH externalReference ===');
  processingItems.forEach(i => console.log(JSON.stringify(i)));
  console.log('=== PENDING OrderItems with NO externalReference (never sent to API) ===');
  neverSentItems.forEach(i => console.log(JSON.stringify(i)));
  console.log('=== Legacy Orders PROCESSING/PENDING ===');
  legacyPending.forEach(o => console.log(JSON.stringify(o)));
  console.log('Counts:', { processingItems: processingItems.length, neverSentItems: neverSentItems.length, legacyPending: legacyPending.length });
}

main().catch(console.error).finally(() => prisma.$disconnect());
