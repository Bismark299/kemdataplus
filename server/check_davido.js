const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

(async () => {
  // Find NyameBa Davido's user record
  const user = await prisma.user.findFirst({
    where: { name: { contains: 'NyameBa' } },
    select: { id: true, name: true, agentCode: true, email: true }
  });

  if (!user) {
    console.log('User not found');
    await prisma.$disconnect();
    return;
  }

  console.log('Agent:', user.name, '| Code:', user.agentCode, '| ID:', user.id);
  console.log('');

  const start = new Date('2026-03-16T00:00:00Z');
  const end = new Date('2026-03-16T23:59:59Z');

  // Get ALL storefront orders for this agent on Mar 16 (any status)
  const storefront = await prisma.storefront.findFirst({
    where: { ownerId: user.id }
  });

  if (storefront) {
    const allOrders = await prisma.storefrontOrder.findMany({
      where: {
        storefrontId: storefront.id,
        createdAt: { gte: start, lte: end }
      },
      include: {
        bundle: { select: { name: true, network: true } }
      },
      orderBy: { createdAt: 'asc' }
    });

    console.log(`ALL StorefrontOrders for ${user.name} on Mar 16: ${allOrders.length}`);
    console.log('');
    allOrders.forEach((o, i) => {
      console.log(`${i + 1}. Status: ${o.status} | Payment: ${o.paymentStatus}`);
      console.log(`   Bundle: ${o.bundle?.name} - ${o.bundle?.network}`);
      console.log(`   Phone: ${o.customerPhone} -> ${o.paymentPhone || o.customerPhone}`);
      console.log(`   Amount: GHS ${o.amount} | OwnerProfit: GHS ${o.ownerProfit} | PlatformProfit: GHS ${o.platformProfit || 0}`);
      console.log(`   ProfitCredited: ${o.profitCredited} | CreditedAt: ${o.profitCreditedAt ? o.profitCreditedAt.toISOString() : 'N/A'}`);
      console.log(`   OrderID linked: ${o.orderId || 'NONE'}`);
      console.log(`   Created: ${o.createdAt.toISOString()}`);
      console.log('');
    });
  }

  // Also check OrderItems placed by this user on Mar 16
  const orderItems = await prisma.orderItem.findMany({
    where: {
      orderGroup: { userId: user.id },
      createdAt: { gte: start, lte: end }
    },
    include: {
      bundle: { select: { name: true, network: true } },
      orderGroup: { select: { idempotencyKey: true, displayId: true } }
    },
    orderBy: { createdAt: 'asc' }
  });

  console.log(`ALL OrderItems for ${user.name} on Mar 16: ${orderItems.length}`);
  console.log('');
  orderItems.forEach((o, i) => {
    const isStore = o.orderGroup?.idempotencyKey?.startsWith('STORE-');
    console.log(`${i + 1}. ${o.orderGroup?.displayId} | Status: ${o.status} | ${isStore ? 'STORE' : 'DIRECT'}`);
    console.log(`   Bundle: ${o.bundle?.name} - ${o.bundle?.network}`);
    console.log(`   Phone: ${o.recipientPhone} | Price: GHS ${o.totalPrice}`);
    console.log(`   Created: ${o.createdAt.toISOString()}`);
    console.log('');
  });

  await prisma.$disconnect();
})();
