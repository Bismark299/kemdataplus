const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
    const orders = await prisma.order.findMany({ orderBy: { createdAt: 'desc' } });
    
    const todayUTC = new Date().toISOString().split('T')[0];
    console.log('Current UTC Time:', new Date().toISOString());
    console.log('Today (UTC):', todayUTC);
    console.log('---');
    console.log('All Orders:');
    orders.forEach(o => {
        const orderDate = o.createdAt.toISOString().split('T')[0];
        const isToday = orderDate === todayUTC;
        console.log(`  Date: ${o.createdAt.toISOString()} | Status: ${o.status} | Is Today: ${isToday}`);
    });
    
    const todayOrders = orders.filter(o => o.createdAt.toISOString().split('T')[0] === todayUTC);
    console.log('---');
    console.log('Orders from TODAY:', todayOrders.length);
    
    await prisma.$disconnect();
}

main();
