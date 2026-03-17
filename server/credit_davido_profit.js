/**
 * One-time script: Credit NyameBa Davido's missing profit for ORD-015147
 * 
 * ORD-015147's OrderItem is COMPLETED but StorefrontOrder is stuck at PROCESSING
 * with profitCredited: false. Uses the existing processCompletedStorefrontOrder
 * service to fix it properly.
 * 
 * Usage: DATABASE_URL="..." node credit_davido_profit.js
 */

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const orderId = '90e2d93f-5a8b-40cd-80f0-bfcea844f723';

  // Verify order state first
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { storefrontOrder: { include: { storefront: { include: { owner: true } } } } }
  });

  if (!order) { console.log('❌ Order not found'); return; }

  const sf = order.storefrontOrder;
  console.log(`Order: ${order.reference}, Status: ${order.status}`);
  console.log(`StorefrontOrder: ${sf.id}, Status: ${sf.status}, profitCredited: ${sf.profitCredited}`);
  console.log(`OwnerProfit: GHS ${sf.ownerProfit}, Agent: ${sf.storefront.owner.name}`);

  if (sf.profitCredited) { console.log('✅ Already credited'); return; }

  // 1. Fix Order status to COMPLETED first (required for creditAgentProfit check)
  if (order.status !== 'COMPLETED') {
    await prisma.order.update({
      where: { id: orderId },
      data: { status: 'COMPLETED', apiConfirmedAt: new Date() }
    });
    console.log(`✅ Order ${order.reference} → COMPLETED`);
  }

  // 2. Use the existing service to handle StorefrontOrder + profit crediting
  const financialOrderService = require('./src/services/financial-order.service');
  const result = await financialOrderService.processCompletedStorefrontOrder(orderId);
  console.log('Result:', JSON.stringify(result, null, 2));

  if (result.credited) {
    console.log(`\n🎉 Done! GHS ${result.amount} credited to ${result.ownerName}`);
  } else if (result.pending) {
    console.log(`\n🎉 Done! GHS ${result.amount} queued for ${result.payoutMode} payout to ${result.ownerName}`);
  } else {
    console.log(`\n⚠️ Not credited: ${result.reason}`);
  }
}

main()
  .catch(e => { console.error('Error:', e); process.exit(1); })
  .finally(() => prisma.$disconnect());
