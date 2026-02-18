const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function checkOverWithdrawals() {
  // Find ALL non-completed withdrawals
  const pendingPayouts = await prisma.agentPayout.findMany({
    where: { status: { in: ['PENDING', 'RESERVED', 'PROCESSING'] } },
    include: { user: { select: { id: true, name: true, phone: true, email: true } } },
    orderBy: { createdAt: 'desc' }
  });
  
  console.log('Checking', pendingPayouts.length, 'active withdrawals...\n');
  
  // Also show users with 28.56 available
  const usersWithProfit = await prisma.pendingProfit.groupBy({
    by: ['userId'],
    where: { status: 'PENDING' },
    _sum: { amount: true }
  });
  
  console.log('Users with pending profits:\n');
  for (const u of usersWithProfit) {
    const user = await prisma.user.findUnique({
      where: { id: u.userId },
      select: { name: true, phone: true }
    });
    const amt = u._sum.amount || 0;
    console.log(`  ${user?.name || 'Unknown'} (${user?.phone}): GH₵${amt.toFixed(2)}`);
  }
  console.log('');
  
  const issues = [];
  
  for (const payout of pendingPayouts) {
    const available = await prisma.pendingProfit.aggregate({
      where: { userId: payout.userId, status: 'PENDING' },
      _sum: { amount: true }
    });
    
    const availableAmount = available._sum.amount || 0;
    
    console.log(`${payout.user.name} (${payout.user.phone}):`);
    console.log(`   Requested: GH₵${payout.amount.toFixed(2)}`);
    console.log(`   Available: GH₵${availableAmount.toFixed(2)}`);
    
    if (payout.amount > availableAmount) {
      console.log(`   ⚠️  OVER-WITHDRAWAL by GH₵${(payout.amount - availableAmount).toFixed(2)}`);
      issues.push({
        payout,
        availableAmount,
        excess: payout.amount - availableAmount
      });
    } else {
      console.log(`   ✅ OK`);
    }
    console.log(`   Reference: ${payout.reference}`);
    console.log('');
  }
  
  if (issues.length > 0) {
    console.log('\n========================================');
    console.log('SUMMARY: Found', issues.length, 'over-withdrawal(s)');
    console.log('========================================\n');
    
    for (const issue of issues) {
      console.log(`To adjust withdrawal ${issue.payout.reference} to available amount:`);
      console.log(`  New amount should be: GH₵${issue.availableAmount.toFixed(2)}`);
    }
  }
  
  await prisma.$disconnect();
}

checkOverWithdrawals().catch(console.error);
