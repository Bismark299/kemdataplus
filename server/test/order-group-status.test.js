const test = require('node:test');
const assert = require('node:assert/strict');

const { getCustomerOrderStatus } = require('../src/services/order-status.service');
const prisma = require('../src/lib/prisma');
const orderGroupService = require('../src/services/order-group.service');

test('a mixed-item group keeps the same processing status customers see', () => {
  assert.equal(
    getCustomerOrderStatus(['COMPLETED', 'PENDING'], 'PENDING'),
    'PROCESSING'
  );
});

test('a group becomes completed when every item completes after creation', () => {
  assert.equal(
    getCustomerOrderStatus(['COMPLETED', 'COMPLETED'], 'PENDING'),
    'COMPLETED'
  );
});

test('every selectable customer status has a consistent group result', () => {
  const cases = [
    [['COMPLETED'], 'PENDING', 'COMPLETED'],
    [['PROCESSING'], 'PENDING', 'PROCESSING'],
    [['PENDING'], 'PENDING', 'PENDING'],
    [['FAILED'], 'PENDING', 'FAILED'],
    [['CANCELLED'], 'PENDING', 'CANCELLED'],
    [['PENDING'], 'DUPLICATE_HOLD', 'DUPLICATE_HOLD']
  ];

  for (const [itemStatuses, groupStatus, expected] of cases) {
    assert.equal(getCustomerOrderStatus(itemStatuses, groupStatus), expected);
  }
});

test('customer status filters return matching new and legacy orders', async () => {
  const now = new Date('2026-08-21T12:00:00.000Z');
  const bundle = { name: '1GB', network: 'MTN', dataAmount: '1GB' };
  const makeGroup = (displayId, status, itemStatuses) => ({
    displayId,
    status,
    itemCount: itemStatuses.length,
    totalAmount: 10,
    createdAt: now,
    updatedAt: now,
    items: itemStatuses.map((itemStatus, index) => ({
      id: `${displayId}-${index}`,
      reference: `${displayId}-${index + 1}`,
      recipientPhone: '0240000000',
      unitPrice: 10,
      totalPrice: 10,
      status: itemStatus,
      bundle,
      updatedAt: now
    }))
  });
  const statuses = ['COMPLETED', 'PROCESSING', 'PENDING', 'FAILED', 'CANCELLED', 'DUPLICATE_HOLD'];
  const groups = [
    makeGroup('ORD-GROUP-COMPLETED', 'PENDING', ['COMPLETED']),
    makeGroup('ORD-GROUP-PROCESSING', 'PENDING', ['COMPLETED', 'PENDING']),
    makeGroup('ORD-GROUP-PENDING', 'PENDING', ['PENDING']),
    makeGroup('ORD-GROUP-FAILED', 'PENDING', ['FAILED']),
    makeGroup('ORD-GROUP-CANCELLED', 'PENDING', ['CANCELLED']),
    makeGroup('ORD-GROUP-HELD', 'DUPLICATE_HOLD', ['PENDING'])
  ];
  const legacyOrders = statuses.map(status => ({
    id: `legacy-${status}`,
    reference: `LEGACY-${status}`,
    status,
    recipientPhone: '0240000001',
    unitPrice: 10,
    totalPrice: 10,
    failureReason: null,
    createdAt: now,
    updatedAt: now,
    bundle
  }));

  const originalGroupFindMany = prisma.orderGroup.findMany;
  const originalOrderFindMany = prisma.order.findMany;
  let groupWhere;
  let legacyWhere;

  prisma.orderGroup.findMany = async ({ where }) => {
    groupWhere = where;
    return groups;
  };
  prisma.order.findMany = async ({ where }) => {
    legacyWhere = where;
    return legacyOrders;
  };

  try {
    for (const status of statuses) {
      const result = await orderGroupService.getOrdersForClient('customer-1', { status, limit: 100 });
      assert.deepEqual(
        result.orders.map(order => order.status).sort(),
        [status, status],
        `${status} should include one OrderGroup and one legacy Order`
      );
    }

    assert.equal(groupWhere.status, undefined, 'OrderGroup filtering must use the displayed item-derived status');
    assert.equal(legacyWhere.status, undefined, 'legacy and group records must be filtered by the same final status');
  } finally {
    prisma.orderGroup.findMany = originalGroupFindMany;
    prisma.order.findMany = originalOrderFindMany;
  }
});

test('recalculating a group updates both stored status fields', async () => {
  const originalGroupFindUnique = prisma.orderGroup.findUnique;
  const originalItemFindMany = prisma.orderItem.findMany;
  const originalGroupUpdate = prisma.orderGroup.update;
  let updateData;

  prisma.orderGroup.findUnique = async () => ({ status: 'PENDING' });
  prisma.orderItem.findMany = async () => [{ status: 'COMPLETED' }];
  prisma.orderGroup.update = async ({ data }) => {
    updateData = data;
  };

  try {
    const status = await orderGroupService.recalculateGroupStatus('group-1');
    assert.equal(status, 'COMPLETED');
    assert.deepEqual(updateData, { status: 'COMPLETED', summaryStatus: 'COMPLETED' });
  } finally {
    prisma.orderGroup.findUnique = originalGroupFindUnique;
    prisma.orderItem.findMany = originalItemFindMany;
    prisma.orderGroup.update = originalGroupUpdate;
  }
});