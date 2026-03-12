const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function check() {
  // Find the test partner user
  const user = await prisma.user.findFirst({ where: { name: { contains: 'Test Partner' } }, select: { id: true, name: true, phone: true } });
  if (!user) { console.log('No Test Partner found'); return; }
  console.log('=== USER ===');
  console.log(JSON.stringify(user, null, 2));

  // Wallet
  const wallet = await prisma.wallet.findUnique({ where: { userId: user.id }, select: { balance: true } });
  console.log('\n=== WALLET ===');
  console.log('Balance:', wallet ? wallet.balance : 'N/A');

  // Pending Profits - by status
  const profitsByStatus = await prisma.pendingProfit.groupBy({
    by: ['status'],
    where: { userId: user.id },
    _sum: { amount: true },
    _count: true
  });
  console.log('\n=== PENDING PROFITS BY STATUS ===');
  profitsByStatus.forEach(function(g) { console.log(g.status + ': count=' + g._count + ', sum=' + g._sum.amount); });

  // All pending profit records
  const allProfits = await prisma.pendingProfit.findMany({
    where: { userId: user.id },
    select: { id: true, amount: true, status: true, createdAt: true, paidAt: true },
    orderBy: { createdAt: 'asc' }
  });
  console.log('\n=== ALL PENDING PROFIT RECORDS ===');
  allProfits.forEach(function(p) {
    console.log('id=' + p.id + ' amt=' + p.amount + ' status=' + p.status + ' created=' + p.createdAt.toISOString().slice(0, 10) + ' paid=' + (p.paidAt ? p.paidAt.toISOString().slice(0, 10) : 'null'));
  });

  // Agent Payouts
  const payouts = await prisma.agentPayout.findMany({
    where: { userId: user.id },
    select: { id: true, amount: true, status: true, createdAt: true },
    orderBy: { createdAt: 'asc' }
  });
  console.log('\n=== AGENT PAYOUTS ===');
  payouts.forEach(function(p) {
    console.log('id=' + p.id + ' amt=' + p.amount + ' status=' + p.status + ' created=' + p.createdAt.toISOString().slice(0, 10));
  });

  // Storefront Orders - owner profit
  const storeOrders = await prisma.storefrontOrder.findMany({
    where: { storefront: { ownerId: user.id } },
    select: { id: true, ownerProfit: true, status: true, createdAt: true },
    orderBy: { createdAt: 'asc' }
  });
  console.log('\n=== STOREFRONT ORDERS ===');
  var totalOwnerProfit = 0;
  storeOrders.forEach(function(o) {
    totalOwnerProfit += (o.ownerProfit || 0);
    console.log('id=' + o.id + ' ownerProfit=' + o.ownerProfit + ' status=' + o.status + ' created=' + o.createdAt.toISOString().slice(0, 10));
  });
  console.log('TOTAL ownerProfit from storefrontOrders: ' + totalOwnerProfit);

  // Admin Profit Adjustments
  const adjustments = await prisma.adminProfitAdjustment.findMany({
    where: { userId: user.id },
    select: { id: true, amount: true, reason: true, createdAt: true },
    orderBy: { createdAt: 'asc' }
  });
  console.log('\n=== ADMIN PROFIT ADJUSTMENTS ===');
  var totalAdj = 0;
  adjustments.forEach(function(a) { totalAdj += a.amount; console.log('id=' + a.id + ' amt=' + a.amount + ' reason=' + a.reason); });
  console.log('TOTAL adjustments: ' + totalAdj);

  // Summary calculations
  var pendingProfitsSum = 0;
  var paidProfitsSum = 0;
  profitsByStatus.forEach(function(g) {
    if (g.status === 'PENDING') pendingProfitsSum = g._sum.amount || 0;
    if (g.status === 'PAID') paidProfitsSum = g._sum.amount || 0;
  });

  var completedPayouts = 0;
  var pendingPayouts = 0;
  payouts.forEach(function(p) {
    if (p.status === 'COMPLETED') completedPayouts += p.amount;
    if (['PENDING', 'RESERVED', 'PROCESSING'].indexOf(p.status) >= 0) pendingPayouts += p.amount;
  });

  console.log('\n========== SUMMARY ==========');
  console.log('Total PENDING profits: GH$ ' + pendingProfitsSum);
  console.log('Total PAID profits: GH$ ' + paidProfitsSum);
  console.log('Total all pendingProfit records: GH$ ' + (pendingProfitsSum + paidProfitsSum));
  console.log('Total ownerProfit from storefrontOrders: GH$ ' + totalOwnerProfit);
  console.log('Total COMPLETED payouts: GH$ ' + completedPayouts);
  console.log('Total PENDING/RESERVED/PROCESSING payouts: GH$ ' + pendingPayouts);
  console.log('Total admin adjustments: GH$ ' + totalAdj);
  console.log('');
  console.log('--- CLIENT VIEW (getUserProfitStats) ---');
  console.log('Available for withdrawal = PENDING profits - pending payouts');
  console.log('  = ' + pendingProfitsSum + ' - ' + pendingPayouts + ' = ' + (pendingProfitsSum - pendingPayouts));
  console.log('');
  console.log('--- ADMIN PROFITS VIEW (getAgentProfitsSummary) ---');
  var allTime = pendingProfitsSum + paidProfitsSum;
  console.log('All-time profit (PENDING + PAID) = ' + allTime);
  console.log('Total withdrawn (COMPLETED payouts) = ' + completedPayouts);
  console.log('Reserved for withdrawal (pending payouts) = ' + pendingPayouts);
  console.log('Available = allTime - withdrawn - reserved + adj');
  console.log('  = ' + allTime + ' - ' + completedPayouts + ' - ' + pendingPayouts + ' + ' + totalAdj + ' = ' + (allTime - completedPayouts - pendingPayouts + totalAdj));
  console.log('');
  console.log('--- ADMIN STATEMENT VIEW (route formula) ---');
  console.log('totalProfit (from storefrontOrders) = ' + totalOwnerProfit);
  console.log('Net Balance = totalOwnerProfit - completedPayouts - pendingPayouts + adj');
  console.log('  = ' + totalOwnerProfit + ' - ' + completedPayouts + ' - ' + pendingPayouts + ' + ' + totalAdj + ' = ' + (totalOwnerProfit - completedPayouts - pendingPayouts + totalAdj));
  console.log('');
  console.log('--- CONSISTENCY CHECK ---');
  var diff = totalOwnerProfit - (pendingProfitsSum + paidProfitsSum);
  if (Math.abs(diff) < 0.01) {
    console.log('OK: storefrontOrder.ownerProfit total matches pendingProfit total');
  } else {
    console.log('MISMATCH: storefrontOrder.ownerProfit (' + totalOwnerProfit + ') vs pendingProfit total (' + (pendingProfitsSum + paidProfitsSum) + ') diff=' + diff);
    console.log('  This means some storefront orders did NOT create pendingProfit records, or amounts differ');
  }

  if (Math.abs(paidProfitsSum - completedPayouts) < 0.01) {
    console.log('OK: PAID profits matches COMPLETED payouts');
  } else {
    console.log('MISMATCH: PAID profits (' + paidProfitsSum + ') vs COMPLETED payouts (' + completedPayouts + ') diff=' + (paidProfitsSum - completedPayouts));
    console.log('  PAID profits should equal COMPLETED payouts (this is what the repair script fixes)');
  }

  await prisma.$disconnect();
}

check().catch(function(e) { console.error(e); process.exit(1); });
