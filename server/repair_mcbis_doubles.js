/**
 * repair_mcbis_doubles.js
 * 
 * Repairs the 29 duplicate-send pairs found by check_mcbis_doubles.js.
 * 
 * For each pair (legacy Order + OrderItem for same ORD number):
 *   - "Both completed": both refs delivered data → mark legacy Order COMPLETED, log for financial review
 *   - "Safe" (only OrderItem delivered): mark legacy PENDING Order COMPLETED (data was delivered via OrderItem)
 * 
 * Run from: C:\Users\Kem\Desktop\Track\server
 */

const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient({
  datasources: { db: { url: 'process.env.DATABASE_URL' } }
});

// Orders where BOTH the legacy Order AND the OrderItem were delivered to MCBIS
// Customer received data TWICE — financial loss
const BOTH_COMPLETED = [
  { ordRef: 'ORD-047045', phone: '0538926918' },
  { ordRef: 'ORD-047048', phone: '0551095657' },
  { ordRef: 'ORD-047049', phone: '0534656143' },
  { ordRef: 'ORD-047058', phone: '0545419441' },
  { ordRef: 'ORD-047060', phone: '0245120807' },
  { ordRef: 'ORD-047063', phone: '0532633113' },
  { ordRef: 'ORD-047064', phone: '0538652972' },
  { ordRef: 'ORD-047069', phone: '0240127909' },
  { ordRef: 'ORD-047070', phone: '0597809994' },
  { ordRef: 'ORD-047071', phone: '0557400427' },
  { ordRef: 'ORD-047073', phone: '0538611149' },
  { ordRef: 'ORD-047076', phone: '0554090791' },
  { ordRef: 'ORD-047077', phone: '0248182623' },
  { ordRef: 'ORD-047078', phone: '0243170522' },
  { ordRef: 'ORD-047079', phone: '0549999862' },
  { ordRef: 'ORD-047082', phone: '0534655857' },
  { ordRef: 'ORD-047084', phone: '0596845225' },
  { ordRef: 'ORD-047086', phone: '0245003399' },
  { ordRef: 'ORD-047088', phone: '0538443704' },
  { ordRef: 'ORD-047090', phone: '0535354776' },
  { ordRef: 'ORD-047091', phone: '0539838312' },
];

// Orders where ONLY the OrderItem was delivered (legacy Order ref = "unknown" on MCBIS)
// Safe — customer got data once. Mark legacy Order as COMPLETED so retry doesn't re-send.
const SAFE_ONLY_ORDERITEM_DELIVERED = [
  { ordRef: 'ORD-047080', phone: '0534531729' },
  { ordRef: 'ORD-047083', phone: '0532437067' },
  { ordRef: 'ORD-047087', phone: '0546811651' },
  { ordRef: 'ORD-047089', phone: '0593019667' },
  { ordRef: 'ORD-047092', phone: '0547063089' },
  { ordRef: 'ORD-047093', phone: '0244925882' },
  { ordRef: 'ORD-047098', phone: '0245524950' },
  { ordRef: 'ORD-047100', phone: '0555521092' },
];

async function main() {
  console.log('=== MCBIS Duplicate Order Repair ===\n');

  // --- Step 1: Handle "both completed" pairs ---
  console.log(`--- Fixing ${BOTH_COMPLETED.length} double-delivery orders ---`);
  const doubleDelivered = [];

  for (const { ordRef, phone } of BOTH_COMPLETED) {
    // Get the legacy Order
    const order = await prisma.order.findFirst({
      where: { reference: ordRef },
      select: { id: true, reference: true, status: true, externalReference: true }
    });
    if (!order) { console.log(`  ⚠️  Order not found: ${ordRef}`); continue; }

    // Get the linked OrderItem (authoritative delivery record)
    const orderItem = await prisma.orderItem.findFirst({
      where: { reference: { startsWith: `${ordRef}-` } },
      select: { id: true, reference: true, status: true, externalReference: true, totalPrice: true }
    });

    // Mark legacy Order as COMPLETED (it DID send to MCBIS, data was delivered)
    if (order.status !== 'COMPLETED') {
      await prisma.order.update({
        where: { id: order.id },
        data: { status: 'COMPLETED', apiConfirmedAt: new Date() }
      });
      console.log(`  ✅ ${ordRef} (${phone}): Order marked COMPLETED (was ${order.status})`);
    } else {
      console.log(`  ✅ ${ordRef} (${phone}): Order already COMPLETED`);
    }

    // Mark OrderItem as COMPLETED too (if not already)
    if (orderItem && orderItem.status !== 'COMPLETED') {
      await prisma.orderItem.update({
        where: { id: orderItem.id },
        data: { status: 'COMPLETED', apiConfirmedAt: new Date() }
      });
      console.log(`       OrderItem ${orderItem.reference} marked COMPLETED (was ${orderItem.status})`);
    }

    doubleDelivered.push({
      ordRef,
      phone,
      orderRef: order.externalReference,
      orderItemRef: orderItem?.externalReference,
      bundlePrice: orderItem?.totalPrice
    });
  }

  // --- Step 2: Handle "safe" pairs (only OrderItem delivered) ---
  console.log(`\n--- Fixing ${SAFE_ONLY_ORDERITEM_DELIVERED.length} safe-but-pending orders ---`);

  for (const { ordRef, phone } of SAFE_ONLY_ORDERITEM_DELIVERED) {
    const order = await prisma.order.findFirst({
      where: { reference: ordRef },
      select: { id: true, reference: true, status: true, externalReference: true }
    });
    if (!order) { console.log(`  ⚠️  Order not found: ${ordRef}`); continue; }

    const orderItem = await prisma.orderItem.findFirst({
      where: { reference: { startsWith: `${ordRef}-` } },
      select: { id: true, reference: true, status: true, externalReference: true }
    });

    // Mark legacy Order as COMPLETED (data was delivered via OrderItem — no double delivery)
    await prisma.order.update({
      where: { id: order.id },
      data: {
        status: 'COMPLETED',
        // Use the OrderItem's externalReference as the delivery ref for traceability
        externalReference: order.externalReference || orderItem?.externalReference || null,
        apiConfirmedAt: new Date()
      }
    });
    console.log(`  ✅ ${ordRef} (${phone}): PENDING Order marked COMPLETED (data delivered by ${orderItem?.reference || 'OrderItem'})`);
  }

  // --- Step 3: Print financial summary ---
  console.log('\n=== FINANCIAL IMPACT SUMMARY ===');
  console.log(`\n⚠️  DOUBLE DELIVERIES (${doubleDelivered.length} orders) — customer received data twice:`);
  console.log('  These are potential financial losses requiring cost reconciliation.\n');
  for (const d of doubleDelivered) {
    console.log(`  ${d.ordRef} | ${d.phone}`);
    console.log(`    Legacy Order ref:  ${d.orderRef}`);
    console.log(`    OrderItem ref:     ${d.orderItemRef}`);
  }

  console.log(`\n✅ SAFE (${SAFE_ONLY_ORDERITEM_DELIVERED.length} orders) — data delivered once, no customer impact.`);
  console.log('\n✅ All legacy Orders cleaned up. The retryPendingOrders loop will no longer re-send them.');

  await prisma.$disconnect();
}

main().catch(e => {
  console.error(e);
  prisma.$disconnect();
  process.exit(1);
});
