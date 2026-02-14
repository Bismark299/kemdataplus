/**
 * Check and manage withdrawal requests in the database
 * 
 * Usage: 
 *   node check_withdrawals.js list    - List all withdrawal requests
 *   node check_withdrawals.js clear   - Clear/cancel all PENDING, RESERVED, PROCESSING requests
 */

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

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

async function main() {
  const command = process.argv[2] || 'list';
  
  try {
    if (command === 'list') {
      await listWithdrawals();
    } else if (command === 'clear') {
      await clearStuckRequests();
    } else {
      console.log('Usage: node check_withdrawals.js [list|clear]');
    }
  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    await prisma.$disconnect();
  }
}

main();
