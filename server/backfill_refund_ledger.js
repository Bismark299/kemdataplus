/**
 * backfill_refund_ledger.js
 * 
 * One-time backfill for cancelled orders from 2026-04-23 that had wallet balances
 * correctly incremented but are missing walletLedger REFUND entries.
 * 
 * Also fixes 2 refund transactions that are stuck in PENDING status.
 * 
 * Safe to run multiple times — skips entries that already exist.
 * 
 * Run: node backfill_refund_ledger.js
 */

require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

const prisma = new PrismaClient();

function generateChecksum(data) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(data))
    .digest('hex')
    .substring(0, 16);
}

// Orders that were cancelled today and have a transaction refund but no walletLedger entry
// walletDeducted=true → wallet balance was already incremented by the old code
// walletDeducted=false → storefront/Paystack order, no wallet refund expected → skip
const AFFECTED_ORDERS = [
  {
    displayId: 'ORD-037328',
    // walletDeducted: false — but admin used item-cancel which always refunds
    // Refund transaction already exists: REFUND-ORD-037328-01-1776938800793 (PENDING)
    // Refund was for item ORD-037328-01 (totalPrice=4.2)
    userId: '3bb1becf-1d7b-4e26-b53f-649e32fbcaac',
    refundAmount: 4.2,
    // Stable reference we'll use in walletLedger (matches new code convention)
    ledgerReference: 'REFUND-ORD-037328-01',
    description: 'Refund for cancelled item ORD-037328-01',
    orderGroupId: '3b2fcbb1-07e3-4ce4-9336-0754f8818a5f',
    // Fix this transaction to COMPLETED
    txReferenceToFix: 'REFUND-ORD-037328-01-1776938800793',
  },
  {
    displayId: 'ORD-037644',
    // walletDeducted: true — admin item-cancel, transaction exists but is PENDING
    // Refund transaction: REFUND-ORD-037644-01-1776968102019 (PENDING)
    userId: 'babe130d-07d0-4849-98e1-7ac761eb5859',
    refundAmount: 4.2,
    ledgerReference: 'REFUND-ORD-037644-01',
    description: 'Refund for cancelled item ORD-037644-01',
    orderGroupId: '90bcf16a-50b9-4cc2-9d0a-4a733223497d',
    txReferenceToFix: 'REFUND-ORD-037644-01-1776968102019',
  },
  // ORD-037561 and ORD-037565 were rejected via duplicate-reject route.
  // Their transaction refunds are already COMPLETED.
  // Still need walletLedger entries so reports count them.
  {
    displayId: 'ORD-037561',
    userId: 'af06fbbc-d513-49ad-8f56-4c02dc9c93b4',
    refundAmount: 8.3,
    ledgerReference: 'REFUND-ORD-037561',
    description: 'Duplicate order refund - ORD-037561 (Reason: Duplicate order rejected by admin)',
    orderGroupId: 'e9f69a16-857a-4506-8230-631a438afe19',
    txReferenceToFix: null, // already COMPLETED
  },
  {
    displayId: 'ORD-037565',
    userId: 'cf2d73f4-13d8-4a12-bdb1-778d4d6974c0',
    refundAmount: 4.2,
    ledgerReference: 'REFUND-ORD-037565',
    description: 'Duplicate order refund - ORD-037565 (Reason: Duplicate order rejected by admin)',
    orderGroupId: '43d37341-0530-413f-bca3-baf9a42b2524',
    txReferenceToFix: null, // already COMPLETED
  },
  // ORD-037726: walletDeducted=false, STORE-PAYSTACK order → no wallet refund, skip
];

async function backfill() {
  console.log('=== Refund walletLedger Backfill ===\n');

  for (const order of AFFECTED_ORDERS) {
    console.log(`Processing ${order.displayId}...`);

    // 1. Check if walletLedger entry already exists (idempotent)
    const existingLedger = await prisma.walletLedger.findUnique({
      where: { reference: order.ledgerReference },
    });

    if (existingLedger) {
      console.log(`  ✓ walletLedger entry already exists for ${order.ledgerReference}, skipping.`);
    } else {
      // Get wallet to find walletId and current balance
      const wallet = await prisma.wallet.findUnique({
        where: { userId: order.userId },
        select: { id: true, balance: true },
      });

      if (!wallet) {
        console.error(`  ✗ Wallet not found for user ${order.userId}, skipping.`);
        continue;
      }

      // Create the missing walletLedger REFUND entry.
      // wallet.balance is already correct (was incremented by old code).
      // We set runningBalance = current wallet.balance to reflect the post-refund state.
      await prisma.walletLedger.create({
        data: {
          id: uuidv4(),
          walletId: wallet.id,
          entryType: 'REFUND',
          amount: order.refundAmount,
          runningBalance: wallet.balance,
          orderId: order.orderGroupId,
          description: order.description,
          reference: order.ledgerReference,
          checksum: generateChecksum({
            walletId: wallet.id,
            amount: order.refundAmount,
            reference: order.ledgerReference,
            timestamp: new Date().toISOString(),
          }),
        },
      });

      console.log(`  ✓ Created walletLedger REFUND entry: ${order.ledgerReference} (GHS ${order.refundAmount})`);
    }

    // 2. Fix any PENDING transaction rows → COMPLETED
    if (order.txReferenceToFix) {
      const tx = await prisma.transaction.findUnique({
        where: { reference: order.txReferenceToFix },
        select: { id: true, status: true },
      });

      if (!tx) {
        console.log(`  ⚠ Transaction ${order.txReferenceToFix} not found.`);
      } else if (tx.status === 'COMPLETED') {
        console.log(`  ✓ Transaction ${order.txReferenceToFix} already COMPLETED.`);
      } else {
        await prisma.transaction.update({
          where: { reference: order.txReferenceToFix },
          data: { status: 'COMPLETED' },
        });
        console.log(`  ✓ Fixed transaction ${order.txReferenceToFix}: PENDING → COMPLETED`);
      }
    }

    console.log();
  }

  console.log('=== Backfill Complete ===');
}

backfill()
  .catch((err) => {
    console.error('Backfill failed:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
