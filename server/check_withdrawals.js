/**
 * Check and manage withdrawal requests in the database
 * 
 * Usage: 
 *   node check_withdrawals.js list                - List all withdrawal requests
 *   node check_withdrawals.js clear               - Clear/cancel all PENDING, RESERVED, PROCESSING requests
 *   node check_withdrawals.js verify <reference>  - Check Paystack status and complete if successful
 *   node check_withdrawals.js verify-all          - Check all PROCESSING withdrawals
 */

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const paystackService = require('./src/services/paystack.service');

async function listWithdrawals() {
  console.log('\n📋 All AgentPayout Records:\n');
  
  const payouts = await prisma.agentPayout.findMany({
    include: {
      user: { select: { id: true, name: true, email: true } }
    },
    orderBy: { createdAt: 'desc' }
  });
  
  if (payouts.length === 0) {
    console.log('  No withdrawal requests found.\n');
    return;
  }
  
  payouts.forEach((p, i) => {
    console.log(`  ${i + 1}. ID: ${p.id}`);
    console.log(`     User: ${p.user?.name} (${p.user?.email})`);
    console.log(`     Amount: GH₵${p.amount?.toFixed(2)} | Net: GH₵${p.netAmount?.toFixed(2)} | Fee: GH₵${p.fee?.toFixed(2)}`);
    console.log(`     Status: ${p.status}`);
    console.log(`     Account: ${p.accountName} - ${p.accountNumber} (${p.bankCode})`);
    console.log(`     Reference: ${p.reference}`);
    console.log(`     Created: ${p.createdAt}`);
    if (p.failureReason) console.log(`     Failure: ${p.failureReason}`);
    console.log('');
  });
  
  // Summary
  const summary = await prisma.agentPayout.groupBy({
    by: ['status'],
    _count: true,
    _sum: { amount: true }
  });
  
  console.log('\n📊 Summary:');
  summary.forEach(s => {
    console.log(`  ${s.status}: ${s._count} requests, GH₵${s._sum.amount?.toFixed(2) || '0.00'}`);
  });
}

async function clearStuckRequests() {
  console.log('\n🧹 Clearing stuck withdrawal requests...\n');
  
  // Find stuck requests
  const stuckRequests = await prisma.agentPayout.findMany({
    where: {
      status: { in: ['PENDING', 'RESERVED', 'PROCESSING'] }
    }
  });
  
  if (stuckRequests.length === 0) {
    console.log('  No stuck requests found.\n');
    return;
  }
  
  console.log(`  Found ${stuckRequests.length} stuck requests:`);
  stuckRequests.forEach(r => {
    console.log(`    - ${r.reference}: ${r.status} - GH₵${r.amount?.toFixed(2)}`);
  });
  
  // Update them to REJECTED
  const result = await prisma.agentPayout.updateMany({
    where: {
      status: { in: ['PENDING', 'RESERVED', 'PROCESSING'] }
    },
    data: {
      status: 'REJECTED',
      failureReason: 'System cleanup - please resubmit withdrawal request',
      reviewNotes: 'Auto-cleared by admin script'
    }
  });
  
  console.log(`\n  ✅ Cleared ${result.count} requests (set to REJECTED).\n`);
  console.log('  Users can now submit new withdrawal requests.\n');
}

async function verifyWithdrawal(reference) {
  console.log(`\n🔍 Verifying withdrawal: ${reference}\n`);
  
  // Find the withdrawal
  const payout = await prisma.agentPayout.findFirst({
    where: {
      OR: [
        { reference: reference },
        { transferCode: reference }
      ]
    },
    include: {
      user: { select: { id: true, name: true, email: true } }
    }
  });
  
  if (!payout) {
    console.log(`  ❌ No withdrawal found with reference: ${reference}`);
    return;
  }
  
  console.log(`  Found: ${payout.reference}`);
  console.log(`  User: ${payout.user?.name} (${payout.user?.email})`);
  console.log(`  Amount: GH₵${payout.amount?.toFixed(2)} | Net: GH₵${payout.netAmount?.toFixed(2)}`);
  console.log(`  Current Status: ${payout.status}`);
  console.log(`  Transfer Code: ${payout.transferCode || 'Not set'}`);
  
  if (payout.status === 'COMPLETED') {
    console.log(`\n  ✅ Already completed - no action needed.`);
    return;
  }
  
  // Check Paystack status
  const transferCode = payout.transferCode || reference;
  console.log(`\n  Checking Paystack status for: ${transferCode}...`);
  
  const result = await paystackService.getTransferStatus(transferCode);
  
  if (!result.success) {
    console.log(`  ❌ Could not get transfer status: ${result.error}`);
    
    // Try verify by reference
    console.log(`  Trying to verify by reference: ${payout.reference}...`);
    const verifyResult = await paystackService.verifyTransfer(payout.reference);
    
    if (!verifyResult.success) {
      console.log(`  ❌ Could not verify transfer: ${verifyResult.error}`);
      return;
    }
    
    console.log(`  Paystack status: ${verifyResult.status}`);
    
    if (verifyResult.status === 'success') {
      await completeWithdrawal(payout);
    } else if (verifyResult.status === 'failed' || verifyResult.status === 'reversed') {
      await failWithdrawal(payout, `Paystack status: ${verifyResult.status}`);
    } else {
      console.log(`  ⏳ Transfer still pending on Paystack.`);
    }
    return;
  }
  
  console.log(`  Paystack status: ${result.status}`);
  console.log(`  Paystack reference: ${result.reference}`);
  console.log(`  Paystack amount: GH₵${result.amount?.toFixed(2)}`);
  
  if (result.status === 'success') {
    await completeWithdrawal(payout, result.transferCode);
  } else if (result.status === 'failed' || result.status === 'reversed') {
    await failWithdrawal(payout, `Paystack status: ${result.status}`);
  } else {
    console.log(`\n  ⏳ Transfer still pending on Paystack (${result.status}).`);
  }
}

async function completeWithdrawal(payout, transferCode) {
  console.log(`\n  ✅ Marking withdrawal as COMPLETED...`);
  
  await prisma.agentPayout.update({
    where: { id: payout.id },
    data: {
      status: 'COMPLETED',
      completedAt: new Date(),
      transferCode: transferCode || payout.transferCode,
      reviewNotes: (payout.reviewNotes || '') + '\nManually verified via check_withdrawals script'
    }
  });
  
  console.log(`  ✅ Withdrawal ${payout.reference} marked as COMPLETED!`);
}

async function failWithdrawal(payout, reason) {
  console.log(`\n  ❌ Marking withdrawal as FAILED...`);
  
  // Refund the amount as pending profit
  await prisma.$transaction(async (tx) => {
    await tx.agentPayout.update({
      where: { id: payout.id },
      data: {
        status: 'FAILED',
        failureReason: reason,
        reviewNotes: (payout.reviewNotes || '') + '\nManually verified via check_withdrawals script'
      }
    });
    
    // Refund as new pending profit
    await tx.pendingProfit.create({
      data: {
        userId: payout.userId,
        amount: payout.amount,
        description: `Refund: Failed withdrawal ${payout.reference}`,
        status: 'PENDING'
      }
    });
    
    console.log(`  ✅ Withdrawal ${payout.reference} marked as FAILED.`);
    console.log(`  ✅ Refunded GH₵${payout.amount?.toFixed(2)} as pending profit.`);
  });
}

async function verifyAllProcessing() {
  console.log('\n🔍 Checking all PROCESSING withdrawals...\n');
  
  const processing = await prisma.agentPayout.findMany({
    where: { status: 'PROCESSING' },
    include: {
      user: { select: { id: true, name: true, email: true } }
    }
  });
  
  if (processing.length === 0) {
    console.log('  No PROCESSING withdrawals found.\n');
    return;
  }
  
  console.log(`  Found ${processing.length} PROCESSING withdrawal(s):\n`);
  
  for (const payout of processing) {
    console.log(`  --- ${payout.reference} ---`);
    await verifyWithdrawal(payout.transferCode || payout.reference);
    console.log('');
  }
}

async function main() {
  const command = process.argv[2] || 'list';
  const arg = process.argv[3];
  
  try {
    if (command === 'list') {
      await listWithdrawals();
    } else if (command === 'clear') {
      await clearStuckRequests();
    } else if (command === 'verify' && arg) {
      await verifyWithdrawal(arg);
    } else if (command === 'verify-all') {
      await verifyAllProcessing();
    } else {
      console.log('Usage:');
      console.log('  node check_withdrawals.js list                - List all withdrawals');
      console.log('  node check_withdrawals.js clear               - Clear stuck requests');
      console.log('  node check_withdrawals.js verify <reference>  - Verify single withdrawal');
      console.log('  node check_withdrawals.js verify-all          - Verify all PROCESSING');
    }
  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    await prisma.$disconnect();
  }
}

main();
