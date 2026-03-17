const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

(async () => {
  const start = new Date('2026-03-16T00:00:00Z');
  const end = new Date('2026-03-16T23:59:59Z');

  const orders = await prisma.storefrontOrder.findMany({
    where: {
      status: 'COMPLETED',
      createdAt: { gte: start, lte: end },
      profitCredited: true
    },
    include: {
      storefront: { include: { owner: { select: { id: true, name: true, agentCode: true } } } },
      bundle: { select: { name: true, network: true } }
    },
    orderBy: { createdAt: 'asc' }
  });

  console.log(`CREDITED STORE ORDERS - Mar 16 (${orders.length})\n`);
  orders.forEach((o, i) => {
    console.log(`${i + 1}. ${o.storefront?.owner?.name} (${o.storefront?.owner?.agentCode})`);
    console.log(`   Bundle: ${o.bundle?.name} - ${o.bundle?.network}`);
    console.log(`   Phone: ${o.customerPhone} -> ${o.paymentPhone || o.customerPhone}`);
    console.log(`   Customer Paid: GHS ${o.amount} | Agent Profit: GHS ${o.ownerProfit} | Platform Profit: GHS ${o.platformProfit || 0}`);
    console.log(`   Credited At: ${o.profitCreditedAt ? o.profitCreditedAt.toISOString() : 'N/A'}`);
    console.log('');
  });

  const byAgent = {};
  orders.forEach(o => {
    const name = o.storefront?.owner?.name || 'Unknown';
    if (!byAgent[name]) byAgent[name] = { code: o.storefront?.owner?.agentCode, orders: 0, totalProfit: 0, platformProfit: 0 };
    byAgent[name].orders++;
    byAgent[name].totalProfit += o.ownerProfit;
    byAgent[name].platformProfit += (o.platformProfit || 0);
  });

  console.log('=== SUMMARY BY AGENT ===');
  Object.entries(byAgent).forEach(([name, s]) => {
    console.log(`${name} (${s.code}): ${s.orders} orders | Agent Profit: GHS ${s.totalProfit.toFixed(2)} | Platform: GHS ${s.platformProfit.toFixed(2)}`);
  });

  await prisma.$disconnect();
})();
