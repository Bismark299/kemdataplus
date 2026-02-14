const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function check() {
  console.log('=== Testing Admin by-user endpoint logic ===');
  
  // This mirrors exactly what the service does
  const result = await prisma.pendingProfit.groupBy({
    by: ['userId'],
    where: { status: 'PENDING' },
    _sum: { amount: true },
    _count: true
  });

  console.log('GroupBy result count:', result.length);

  if (result.length === 0) {
    console.log('No pending profits found!');
    await prisma.$disconnect();
    return;
  }

  const userIds = result.map(r => r.userId);
  const users = await prisma.user.findMany({
    where: { id: { in: userIds } },
    select: { id: true, name: true, email: true, phone: true }
  });

  const userMap = Object.fromEntries(users.map(u => [u.id, u]));
  
  const finalResult = result.map(r => ({
    user: userMap[r.userId],
    totalAmount: r._sum.amount || 0,
    profitCount: r._count || 0,
    meetsMinimum: (r._sum.amount || 0) >= 5
  })).sort((a, b) => b.totalAmount - a.totalAmount);

  console.log('Final API response would be:');
  console.log(JSON.stringify(finalResult, null, 2));

  await prisma.$disconnect();
}

check().catch(console.error);
