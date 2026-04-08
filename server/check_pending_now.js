const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient({
  datasources: { db: { url: 'postgresql://kemdataplus_db_user:1ADTCxFCqu6P2YxebCMcjL8YUDhKcFCD@dpg-d5g0ahvgi27c73e73cpg-a.oregon-postgres.render.com/kemdataplus_db' } }
});

(async () => {
  const stuck = await p.order.findMany({
    where: { status: 'PENDING', externalReference: null, apiSentAt: null, createdAt: { gt: new Date(Date.now() - 24*60*60*1000) } },
    include: { bundle: { select: { network: true, name: true } } }
  });
  console.log('Still stuck:', stuck.length);
  stuck.forEach(o => console.log(' ', o.recipientPhone, o.bundle?.network, o.bundle?.name, o.createdAt.toISOString().slice(0,19)));

  // Also check if any have apiSentAt set now (being processed)
  const inflight = await p.order.findMany({
    where: { status: 'PENDING', externalReference: null, apiSentAt: { not: null }, createdAt: { gt: new Date(Date.now() - 24*60*60*1000) } },
  });
  console.log('In-flight (apiSentAt set):', inflight.length);

  // Check recent PROCESSING orders
  const proc = await p.order.findMany({
    where: { status: 'PROCESSING', createdAt: { gt: new Date(Date.now() - 60*60*1000) } },
    select: { recipientPhone: true, externalReference: true, createdAt: true }
  });
  console.log('Recent PROCESSING:', proc.length);
  proc.forEach(o => console.log(' ', o.recipientPhone, o.externalReference, o.createdAt.toISOString().slice(0,19)));

  await p.$disconnect();
})();
