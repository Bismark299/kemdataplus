/**
 * Audit: check for suspicious or wrong profit credits
 */
const prisma = require('./src/lib/prisma');

async function main() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // 1. Duplicate profit credits (same reference credited more than once)
  const dupeProfits = await prisma.$queryRaw`
    SELECT reference, COUNT(*) as count, SUM(amount) as total
    FROM wallet_ledger
    WHERE "entryType" = 'PROFIT_CREDIT'
    GROUP BY reference
    HAVING COUNT(*) > 1
    ORDER BY count DESC
    LIMIT 20
  `;
  console.log('\n=== DUPLICATE PROFIT CREDITS (same reference credited multiple times) ===');
  console.log(dupeProfits.length === 0 ? 'NONE found ✅' : JSON.stringify(dupeProfits, null, 2));

  // 2. Storefront orders marked profitCredited=true but order was CANCELLED
  const wrongCredited = await prisma.storefrontOrder.findMany({
    where: { profitCredited: true, status: 'CANCELLED' },
    select: { id: true, status: true, profitCredited: true, profitCreditedAt: true, amount: true, ownerProfit: true, customerPhone: true, createdAt: true }
  });
  console.log('\n=== PROFIT CREDITED ON CANCELLED STOREFRONT ORDERS ===');
  console.log(wrongCredited.length === 0 ? 'NONE found ✅' : JSON.stringify(wrongCredited, null, 2));

  // 3. Large single profit credits (potential over-credit)
  const largeProfits = await prisma.walletLedger.findMany({
    where: { entryType: 'PROFIT_CREDIT', amount: { gt: 50 } },
    select: { id: true, amount: true, reference: true, createdAt: true, walletId: true },
    orderBy: { amount: 'desc' },
    take: 20
  });
  console.log('\n=== LARGE PROFIT CREDITS (> GHS 50 in a single entry) ===');
  console.log(largeProfits.length === 0 ? 'NONE found ✅' : JSON.stringify(largeProfits, null, 2));

  // 4. Total all-time profit credits vs storefrontOrders marked credited
  const allTimeProfits = await prisma.walletLedger.aggregate({
    where: { entryType: 'PROFIT_CREDIT' },
    _sum: { amount: true },
    _count: true
  });
  const allTimeCreditedSO = await prisma.storefrontOrder.count({ where: { profitCredited: true } });
  console.log('\n=== ALL-TIME PROFIT SUMMARY ===');
  console.log(`Total profit credit ledger entries: ${allTimeProfits._count}`);
  console.log(`Total amount credited: GHS ${(allTimeProfits._sum.amount || 0).toFixed(2)}`);
  console.log(`StorefrontOrders flagged profitCredited=true: ${allTimeCreditedSO}`);
  if (Math.abs(allTimeProfits._count - allTimeCreditedSO) > 5) {
    console.log('⚠️  COUNT MISMATCH - investigate');
  } else {
    console.log('✅ Counts consistent');
  }

  // 5. Today's profit summary
  const todayProfits = await prisma.walletLedger.aggregate({
    where: { entryType: 'PROFIT_CREDIT', createdAt: { gte: today } },
    _sum: { amount: true },
    _count: true
  });
  const todayCompletedSO = await prisma.storefrontOrder.count({
    where: { status: 'COMPLETED', profitCredited: true, profitCreditedAt: { gte: today } }
  });
  console.log('\n=== TODAY\'s PROFIT SUMMARY ===');
  console.log(`Profit credit entries today: ${todayProfits._count}`);
  console.log(`Total profit credited today: GHS ${(todayProfits._sum.amount || 0).toFixed(2)}`);
  console.log(`StorefrontOrders marked profitCredited today: ${todayCompletedSO}`);

  // 6. Refunds credited more than once (duplicate REFUND entries for same order)
  const dupeRefunds = await prisma.$queryRaw`
    SELECT reference, COUNT(*) as count, SUM(amount) as total
    FROM wallet_ledger
    WHERE "entryType" = 'REFUND'
    GROUP BY reference
    HAVING COUNT(*) > 1
    ORDER BY count DESC
    LIMIT 20
  `;
  console.log('\n=== DUPLICATE REFUND CREDITS (same reference refunded multiple times) ===');
  console.log(dupeRefunds.length === 0 ? 'NONE found ✅' : JSON.stringify(dupeRefunds, null, 2));

  // 7. Wallet balances that don't match ledger sum (top 10 discrepancies)
  const mismatches = await prisma.$queryRaw`
    SELECT w.id, w.balance as stored_balance,
           COALESCE(SUM(wl.amount), 0) as ledger_sum,
           w.balance - COALESCE(SUM(wl.amount), 0) as discrepancy
    FROM wallets w
    LEFT JOIN wallet_ledger wl ON wl."walletId" = w.id
    GROUP BY w.id, w.balance
    HAVING ABS(w.balance - COALESCE(SUM(wl.amount), 0)) > 0.01
    ORDER BY ABS(w.balance - COALESCE(SUM(wl.amount), 0)) DESC
    LIMIT 10
  `;
  console.log('\n=== WALLET BALANCE vs LEDGER MISMATCHES (> GHS 0.01) ===');
  console.log(mismatches.length === 0 ? 'NONE found ✅' : JSON.stringify(mismatches, null, 2));
}

main().catch(console.error).finally(() => prisma.$disconnect());
