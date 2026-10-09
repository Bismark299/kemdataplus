// Explicit, status-only maintenance: no dispatch, wallet or profit changes.
const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');
const { getCustomerOrderStatus } = require('../src/services/order-status.service');

const day = process.argv[2];
if (!/^\d{4}-\d{2}-\d{2}$/.test(day || '')) throw new Error('Supply a UTC date YYYY-MM-DD');
const apply = process.argv.includes('--apply');
const start = new Date(`${day}T00:00:00Z`);
if (Number.isNaN(start.getTime()) || start.toISOString().slice(0, 10) !== day) throw new Error('Invalid date');
const end = new Date(start.getTime() + 86400000);
const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_URL + (process.env.DATABASE_URL.includes('?') ? '&' : '?') + 'sslmode=require' } }
});
const output = path.resolve(__dirname, '../../attached_assets');
const csvCell = value => `"${String(value ?? '').replace(/"/g, '""')}"`;

async function main() {
  const result = await prisma.$transaction(async tx => {
    const where = { status: 'FAILED', createdAt: { gte: start, lt: end } };
    const items = await tx.orderItem.findMany({
      where, orderBy: { createdAt: 'asc' },
      include: { bundle: { select: { name: true } }, orderGroup: true }
    });
    const failedOrders = await tx.order.findMany({ where });
    const references = [...new Set([...failedOrders.map(o => o.reference), ...items.map(i => i.reference.replace(/-\d+$/, ''))])];
    const orders = await tx.order.findMany({ where: { reference: { in: references } } });
    const stores = await tx.storefrontOrder.findMany({
      where: { OR: [{ orderId: { in: orders.map(o => o.id) } }, { id: { in: orders.map(o => o.storefrontOrderId).filter(Boolean) } }] }
    });
    const candidateRows = items.map(i => ({
      reference: i.reference, createdAt: i.createdAt, phone: i.recipientPhone,
      bundle: i.bundle.name, amount: i.totalPrice, previousStatus: i.status,
      failureReason: i.failureReason, externalReference: i.externalReference,
      item: i, order: orders.find(o => o.reference === i.reference.replace(/-\d+$/, ''))
    }));
    for (const o of failedOrders) {
      if (!candidateRows.some(r => r.order?.id === o.id)) {
        const bundle = await tx.bundle.findUnique({ where: { id: o.bundleId }, select: { name: true } });
        candidateRows.push({
          reference: o.reference, createdAt: o.createdAt, phone: o.recipientPhone,
          bundle: bundle?.name, amount: o.totalPrice, previousStatus: o.status,
          failureReason: o.failureReason, externalReference: o.externalReference, order: o
        });
      }
    }
    const refunds = await tx.walletLedger.findMany({
      where: {
        entryType: 'REFUND',
        OR: [
          { orderId: { in: [...orders.map(o => o.id), ...items.map(i => i.orderGroupId)] } },
          ...candidateRows.map(r => ({ reference: { contains: r.reference } })),
          ...references.map(reference => ({ reference: { contains: reference } }))
        ]
      },
      select: { orderId: true, reference: true }
    });
    const rows = candidateRows.map(r => {
      const store = stores.find(s => s.orderId === r.order?.id || s.id === r.order?.storefrontOrderId);
      const refunded = refunds.some(f =>
        (f.orderId && [r.order?.id, r.item?.orderGroupId].includes(f.orderId)) ||
        f.reference.includes(r.reference) || (r.order && f.reference.includes(r.order.reference))
      );
      const skip = refunded ? 'Refund found' :
        r.item?.orderGroup.status === 'DUPLICATE_HOLD' ? 'Duplicate hold' :
        r.order && !['FAILED', 'PENDING', 'PROCESSING'].includes(r.order.status) ? 'Linked order terminal status' :
        store && (!['FAILED', 'PENDING', 'PROCESSING'].includes(store.status) || store.profitCredited || store.paymentStatus !== 'PAID') ? 'Store payment/profit/status requires review' : null;
      return { ...r, store, skip };
    });
    // Save original records BEFORE any database mutation.
    fs.mkdirSync(output, { recursive: true });
    const stamp = Date.now();
    const backup = path.join(output, `failed-orders-${day}-${stamp}-before.json`);
    fs.writeFileSync(backup, JSON.stringify({ dateUTC: day, items, orders, stores, refunds }, null, 2));
    let itemCount = 0, orderCount = 0, storefrontCount = 0;
    const groups = new Set(), updatedOrders = new Set(), updatedStores = new Set();
    if (apply) {
      for (const r of rows.filter(r => !r.skip)) {
        if (r.item) {
          const changed = await tx.orderItem.updateMany({
            where: { id: r.item.id, status: 'FAILED' }, data: { status: 'PROCESSING' }
          });
          if (changed.count !== 1) throw new Error('Item changed concurrently; aborting');
          itemCount++;
          groups.add(r.item.orderGroupId);
        }
        if (r.order && !updatedOrders.has(r.order.id)) {
          const changed = await tx.order.updateMany({
            where: { id: r.order.id, status: r.order.status }, data: { status: 'PROCESSING' }
          });
          if (changed.count !== 1) throw new Error('Order changed concurrently; aborting');
          orderCount++;
          updatedOrders.add(r.order.id);
        }
        if (r.store && !updatedStores.has(r.store.id)) {
          const changed = await tx.storefrontOrder.updateMany({
            where: { id: r.store.id, status: r.store.status, profitCredited: false }, data: { status: 'PROCESSING' }
          });
          if (changed.count !== 1) throw new Error('Store order changed concurrently; aborting');
          storefrontCount++;
          updatedStores.add(r.store.id);
        }
        await tx.auditLog.create({ data: {
          action: 'ADMIN_OVERRIDE', entityType: r.item ? 'OrderItem' : 'Order',
          entityId: r.item?.id || r.order.id,
          oldValues: { status: 'FAILED', failureReason: r.failureReason },
          newValues: { status: 'PROCESSING' },
          metadata: { reason: 'User requested restoration of failed orders for this UTC date', dateUTC: day, reference: r.reference, statusOnly: true }
        } });
      }
      for (const id of groups) {
        const group = await tx.orderGroup.findUnique({ where: { id } });
        const members = await tx.orderItem.findMany({ where: { orderGroupId: id }, select: { status: true } });
        const status = getCustomerOrderStatus(members.map(i => i.status), group.status);
        await tx.orderGroup.update({ where: { id }, data: { status, summaryStatus: status } });
      }
    }
    return {
      rows: rows.map(r => ({
        reference: r.reference, createdAt: r.createdAt.toISOString(), phone: r.phone,
        bundle: r.bundle, amount: r.amount, previousStatus: r.previousStatus,
        result: r.skip || (apply ? 'PROCESSING' : 'Eligible'),
        failureReason: r.failureReason, externalReference: r.externalReference || r.order?.externalReference || ''
      })),
      itemIds: rows.filter(r => !r.skip && r.item).map(r => r.item.id),
      orderIds: [...updatedOrders], storeIds: [...updatedStores],
      counts: { itemCount, orderCount, storefrontCount, groups: groups.size },
      backup
    };
  }, { isolationLevel: 'Serializable', timeout: 30000 });
  const headers = ['reference', 'createdAt', 'phone', 'bundle', 'amount', 'previousStatus', 'result', 'failureReason', 'externalReference'];
  const csv = path.join(output, `failed-orders-${day}-${Date.now()}-${apply ? 'restored' : 'preview'}.csv`);
  fs.writeFileSync(csv, [headers.map(csvCell).join(','), ...result.rows.map(r => headers.map(h => csvCell(r[h])).join(','))].join('\n'));
  if (apply) {
    const [items, orders, stores] = await Promise.all([
      prisma.orderItem.findMany({ where: { id: { in: result.itemIds } }, select: { reference: true, status: true } }),
      prisma.order.findMany({ where: { id: { in: result.orderIds } }, select: { reference: true, status: true } }),
      prisma.storefrontOrder.findMany({ where: { id: { in: result.storeIds } }, select: { id: true, status: true } })
    ]);
    console.log('VERIFIED', JSON.stringify({ items, orders, stores }));
  }
  console.log(JSON.stringify({ applied: apply, counts: result.counts, csv, rows: result.rows }, null, 2));
}
main().catch(() => {
  console.error('Maintenance failed; do not assume status changes succeeded. Check records before retrying.');
  process.exitCode = 1;
}).finally(() => prisma.$disconnect());
