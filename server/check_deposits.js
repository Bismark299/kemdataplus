const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

(async () => {
  // Check recent deposits
  const txns = await p.transaction.findMany({ 
    where: { type: 'DEPOSIT' }, 
    orderBy: { createdAt: 'desc' }, 
    take: 10 
  });
  console.log('Recent DEPOSIT transactions:');
  console.log(JSON.stringify(txns, null, 2));
  
  // Check pending payments
  const pending = await p.pendingPayment.findMany({
    orderBy: { createdAt: 'desc' },
    take: 10
  });
  console.log('\nRecent PendingPayments:');
  console.log(JSON.stringify(pending, null, 2));
  
  await p.$disconnect();
})();
