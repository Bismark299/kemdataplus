const test = require('node:test');
const assert = require('node:assert/strict');

const { createMcbisTracker } = require('../src/services/mcbis-tracking.service');

function mockModule(relativePath, exports) {
  const id = require.resolve(relativePath);
  require.cache[id] = { id, filename: id, loaded: true, exports };
  return id;
}

async function withActualHandlers(prisma, run, { wallet, idg, settings } = {}) {
  const modulePaths = [
    '../src/lib/prisma',
    '../src/services/wallet.service',
    '../src/services/order-status.service',
    '../src/controllers/settings.controller',
    '../src/services/instantdatagh.service',
    '../src/services/ckgodsway.service',
    '../src/services/datagatekeeper.service',
    '../src/services/financial-order.service',
    '../src/services/profit-payout.service',
    '../src/services/datahub.service',
    '../src/services/order-group.service'
  ];
  const ids = modulePaths.map(path => require.resolve(path));
  const previous = new Map(ids.map(id => [id, require.cache[id]]));
  const originalConsole = {
    log: console.log,
    warn: console.warn,
    error: console.error
  };

  try {
    for (const id of ids) delete require.cache[id];
    mockModule('../src/lib/prisma', prisma);
    mockModule('../src/services/wallet.service', wallet || { creditWallet: async () => ({ success: true }) });
    mockModule('../src/services/order-status.service', {
      getCustomerOrderStatus: statuses => statuses.at(-1) || 'PENDING'
    });
    mockModule('../src/controllers/settings.controller', {
      getSiteSettings: () => settings || {}
    });
    mockModule('../src/services/instantdatagh.service', idg || {
      checkOrderStatus: async () => ({ success: true, status: 'pending' }),
      placeOrder: async () => ({ success: false, error: 'not used in tests' })
    });
    mockModule('../src/services/ckgodsway.service', {
      checkOrderStatus: async () => ({ success: true, status: 'pending' })
    });
    mockModule('../src/services/datagatekeeper.service', {
      checkOrderStatus: async () => ({ success: true, status: 'pending' })
    });
    mockModule('../src/services/financial-order.service', {
      processCompletedStorefrontOrder: async () => ({ credited: false })
    });
    mockModule('../src/services/profit-payout.service', {
      cancelPendingProfit: async () => ({ success: true })
    });

    console.log = () => {};
    console.warn = () => {};
    console.error = () => {};

    const datahub = require('../src/services/datahub.service');
    const orderGroups = require('../src/services/order-group.service');
    await run({ datahub, orderGroups });
  } finally {
    console.log = originalConsole.log;
    console.warn = originalConsole.warn;
    console.error = originalConsole.error;
    for (const [id, cachedModule] of previous) {
      if (cachedModule) require.cache[id] = cachedModule;
      else delete require.cache[id];
    }
  }
}

function basePrisma() {
  return {
    order: {
      findUnique: async () => null,
      findFirst: async () => null,
      findMany: async () => [],
      update: async () => ({}),
      updateMany: async () => ({ count: 1 })
    },
    orderItem: {
      findUnique: async () => null,
      findFirst: async () => null,
      findMany: async () => [],
      update: async () => ({}),
      updateMany: async () => ({ count: 1 })
    },
    orderGroup: {
      findUnique: async () => ({ status: 'PENDING' }),
      findMany: async () => [],
      update: async () => ({})
    },
    storefrontOrder: {
      findUnique: async () => null,
      update: async () => ({}),
      updateMany: async () => ({ count: 1 })
    }
  };
}

test('actual handlers skip stale or rerouted prefetched results', async () => {
  const prisma = basePrisma();
  const order = { id: 'order-1', externalReference: 'REF-NEW', status: 'PROCESSING' };
  const item = { id: 'item-1', externalReference: 'REF-NEW', status: 'PROCESSING' };
  let orderUpdates = 0;
  let itemUpdates = 0;
  prisma.order.findUnique = async () => order;
  prisma.order.updateMany = async () => {
    orderUpdates++;
    return { count: 1 };
  };
  prisma.orderItem.findUnique = async () => item;
  prisma.orderItem.updateMany = async () => {
    itemUpdates++;
    return { count: 1 };
  };

  await withActualHandlers(prisma, async ({ datahub, orderGroups }) => {
    const statusResult = { success: true, status: 'completed' };
    const legacyResult = await datahub.syncOrderStatus('order-1', {
      statusResult,
      externalReference: 'REF-OLD'
    });
    const itemResult = await orderGroups.syncOrderItemStatus('item-1', {
      statusResult,
      externalReference: 'REF-OLD'
    });

    assert.equal(legacyResult.skipped, true);
    assert.equal(itemResult.skipped, true);
    assert.equal(orderUpdates, 0);
    assert.equal(itemUpdates, 0);
  });
});

test('actual handlers stop propagation and refunds when their compare-and-set update loses', async () => {
  const legacyPrisma = basePrisma();
  let legacyPropagation = 0;
  let legacyRefunds = 0;
  legacyPrisma.order.findUnique = async () => ({
    id: 'order-1',
    externalReference: 'REF-1',
    providerName: 'MCBIS',
    status: 'PENDING',
    reference: 'ORD-1',
    storefrontOrderId: 'storefront-1',
    totalPrice: 10,
    userId: 'user-1',
    recipientPhone: '0240000000',
    bundle: { network: 'telecel' }
  });
  legacyPrisma.order.updateMany = async () => ({ count: 0 });
  legacyPrisma.orderItem.findFirst = async () => {
    legacyPropagation++;
    return null;
  };

  await withActualHandlers(legacyPrisma, async ({ datahub }) => {
    const result = await datahub.syncOrderStatus('order-1', {
      statusResult: { success: true, status: 'cancelled' },
      externalReference: 'REF-1'
    });
    assert.equal(result.skipped, true);
  }, {
    wallet: { creditWallet: async () => { legacyRefunds++; } }
  });
  assert.equal(legacyPropagation, 0);
  assert.equal(legacyRefunds, 0);

  const itemPrisma = basePrisma();
  let itemPropagation = 0;
  let itemRefunds = 0;
  itemPrisma.orderItem.findUnique = async () => ({
    id: 'item-1',
    externalReference: 'REF-1',
    status: 'PENDING',
    reference: 'ORD-1-1',
    orderGroupId: 'group-1',
    orderGroup: { userId: 'user-1' },
    totalPrice: 10,
    recipientPhone: '0240000000'
  });
  itemPrisma.orderItem.updateMany = async () => ({ count: 0 });
  itemPrisma.orderGroup.findUnique = async () => {
    itemPropagation++;
    return { status: 'PENDING' };
  };

  await withActualHandlers(itemPrisma, async ({ orderGroups }) => {
    const result = await orderGroups.syncOrderItemStatus('item-1', {
      statusResult: { success: true, status: 'cancelled' },
      externalReference: 'REF-1'
    });
    assert.equal(result.skipped, true);
  }, {
    wallet: { creditWallet: async () => { itemRefunds++; } }
  });
  assert.equal(itemPropagation, 0);
  assert.equal(itemRefunds, 0);
});

test('linked-item CAS loss returns a failed application and prevents duplicate refunds', async () => {
  const prisma = basePrisma();
  const order = {
    id: 'legacy-1',
    externalReference: 'REF-1',
    providerName: 'MCBIS',
    status: 'PENDING',
    reference: 'ORD-1',
    totalPrice: 10,
    userId: 'user-1',
    recipientPhone: '0240000000',
    bundle: { network: 'telecel' }
  };
  const item = {
    id: 'item-1',
    externalReference: 'REF-1',
    status: 'PENDING',
    reference: 'ORD-1-1',
    orderGroupId: 'group-1',
    orderGroup: { userId: 'user-1' },
    totalPrice: 10,
    recipientPhone: '0240000000'
  };
  let itemUpdateWhere;
  let linkedItemReads = 0;
  let itemHandlerReads = 0;
  let refunds = 0;
  prisma.order.findMany = async () => [order];
  prisma.order.findUnique = async () => ({ ...order });
  prisma.order.updateMany = async ({ where, data }) => {
    if (where.externalReference !== order.externalReference || where.status !== order.status) {
      return { count: 0 };
    }
    Object.assign(order, data);
    return { count: 1 };
  };
  prisma.orderItem.findMany = async () => [item];
  prisma.orderItem.findFirst = async () => {
    linkedItemReads++;
    return item;
  };
  prisma.orderItem.findUnique = async () => {
    itemHandlerReads++;
    return { ...item, orderGroup: item.orderGroup };
  };
  prisma.orderItem.updateMany = async args => {
    itemUpdateWhere = args.where;
    return { count: 0 };
  };

  await withActualHandlers(prisma, async ({ datahub, orderGroups }) => {
    datahub.checkOrderStatus = async () => ({ success: true, status: 'cancelled' });
    const tracker = createMcbisTracker({
      prisma,
      datahub,
      orderGroups,
      getSettings: () => ({ mcbisAPI: true, mcbisAutoSync: true }),
      syncState: { syncAllRunning: false },
      log: { info() {}, warn() {}, error() {} }
    });

    const result = await tracker.run();
    assert.equal(result.errors, 1);
    assert.equal(result.cancelled, 0);
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0].success, false);
    assert.match(result.results[0].error, /Linked order changed/);
  }, {
    wallet: { creditWallet: async () => { refunds++; } },
    settings: { mtnFailoverEnabled: false }
  });

  assert.deepEqual(itemUpdateWhere.status, { in: ['PENDING', 'PROCESSING'] });
  assert.equal(itemUpdateWhere.externalReference, 'REF-1');
  assert.equal(linkedItemReads, 1, 'the handler re-reads the still-active same-reference item');
  assert.equal(itemHandlerReads, 1, 'only the linked-item CAS reread occurs; the item handler is not called');
  assert.equal(refunds, 0);
});

test('legacy completion does not overwrite a linked IDG item reference', async () => {
  const prisma = basePrisma();
  let orderStatus = 'PENDING';
  const idgItem = {
    id: 'item-idg',
    externalReference: 'IDG-REF-2',
    status: 'PROCESSING',
    orderGroupId: 'group-1'
  };
  let itemUpdates = 0;
  prisma.order.findUnique = async () => ({
    id: 'order-1',
    externalReference: 'MCBIS-REF-1',
    providerName: 'MCBIS',
    status: orderStatus,
    reference: 'ORD-1'
  });
  prisma.order.updateMany = async ({ data }) => {
    orderStatus = data.status;
    return { count: 1 };
  };
  prisma.orderItem.findFirst = async () => idgItem;
  prisma.orderItem.updateMany = async () => {
    itemUpdates++;
    return { count: 1 };
  };

  await withActualHandlers(prisma, async ({ datahub }) => {
    const result = await datahub.syncOrderStatus('order-1', {
      statusResult: { success: true, status: 'completed' },
      externalReference: 'MCBIS-REF-1'
    });
    assert.equal(result.newStatus, 'COMPLETED');
  });
  assert.equal(orderStatus, 'COMPLETED');
  assert.equal(itemUpdates, 0);
  assert.equal(idgItem.externalReference, 'IDG-REF-2');
});

test('item completion does not overwrite a linked legacy order on a different reference', async () => {
  const prisma = basePrisma();
  let itemStatus = 'PENDING';
  let legacyOrderUpdates = 0;
  prisma.orderItem.findUnique = async () => ({
    id: 'item-1',
    externalReference: 'MCBIS-ITEM-REF',
    status: itemStatus,
    reference: 'ORD-1-1',
    orderGroupId: 'group-1',
    orderGroup: { userId: 'user-1' },
    totalPrice: 10,
    recipientPhone: '0240000000'
  });
  prisma.orderItem.updateMany = async ({ data }) => {
    itemStatus = data.status;
    return { count: 1 };
  };
  prisma.orderItem.findMany = async () => [{ status: itemStatus }];
  prisma.order.findFirst = async () => ({
    id: 'legacy-1',
    externalReference: 'MCBIS-LEGACY-OTHER',
    status: 'PROCESSING',
    storefrontOrderId: null
  });
  prisma.order.updateMany = async () => {
    legacyOrderUpdates++;
    return { count: 1 };
  };

  await withActualHandlers(prisma, async ({ orderGroups }) => {
    const result = await orderGroups.syncOrderItemStatus('item-1', {
      statusResult: { success: true, status: 'completed' },
      externalReference: 'MCBIS-ITEM-REF'
    });
    assert.equal(result.newStatus, 'COMPLETED');
  });
  assert.equal(itemStatus, 'COMPLETED');
  assert.equal(legacyOrderUpdates, 0);
});

test('active linked-item transition uses a PENDING-or-PROCESSING CAS filter', async () => {
  const prisma = basePrisma();
  const item = {
    id: 'item-1',
    externalReference: 'REF-1',
    status: 'PENDING',
    reference: 'ORD-1-1',
    orderGroupId: 'group-1'
  };
  let linkedItemStatusFilter;
  prisma.order.findUnique = async () => ({
    id: 'legacy-1',
    externalReference: 'REF-1',
    providerName: 'MCBIS',
    status: 'PENDING',
    reference: 'ORD-1'
  });
  prisma.order.updateMany = async () => ({ count: 1 });
  prisma.orderItem.findFirst = async () => item;
  prisma.orderItem.updateMany = async ({ where, data }) => {
    linkedItemStatusFilter = where.status;
    Object.assign(item, data);
    return { count: 1 };
  };
  prisma.orderItem.findMany = async () => [item];

  await withActualHandlers(prisma, async ({ datahub }) => {
    const result = await datahub.syncOrderStatus('legacy-1', {
      statusResult: { success: true, status: 'processing' },
      externalReference: 'REF-1'
    });
    assert.equal(result.newStatus, 'PROCESSING');
  });
  assert.deepEqual(linkedItemStatusFilter, { in: ['PENDING', 'PROCESSING'] });
  assert.equal(item.status, 'PROCESSING');
});

test('accepted-backup and awaiting-funds failover do not overwrite an IDG-completed linked item', async () => {
  const cases = [
    {
      name: 'accepted backup',
      placeOrder: async () => ({ success: true, reference: 'IDG-NEW-REF' }),
      expectedOrderStatus: 'PROCESSING'
    },
    {
      name: 'backup awaiting funds',
      placeOrder: async () => ({ success: false, error: 'insufficient funds' }),
      expectedOrderStatus: 'PENDING'
    }
  ];

  for (const scenario of cases) {
    const prisma = basePrisma();
    const order = {
      id: 'legacy-1',
      externalReference: 'MCBIS-REF-1',
      providerName: 'MCBIS',
      status: 'PENDING',
      reference: 'ORD-1',
      bundle: { network: 'mtn', dataAmount: '1GB' },
      recipientPhone: '0240000000'
    };
    const idgItem = {
      id: 'item-idg',
      externalReference: 'IDG-EXISTING-REF',
      status: 'COMPLETED',
      reference: 'ORD-1-1',
      orderGroupId: 'group-1'
    };
    let itemUpdates = 0;
    let refunds = 0;
    prisma.order.findUnique = async () => ({ ...order });
    prisma.order.updateMany = async ({ where, data }) => {
      if (where.externalReference !== order.externalReference || where.status !== order.status) {
        return { count: 0 };
      }
      Object.assign(order, data);
      return { count: 1 };
    };
    prisma.order.update = async ({ data }) => {
      Object.assign(order, data);
      return order;
    };
    prisma.orderItem.findFirst = async () => idgItem;
    prisma.orderItem.updateMany = async () => {
      itemUpdates++;
      return { count: 1 };
    };

    await withActualHandlers(prisma, async ({ datahub }) => {
      datahub.checkOrderStatus = async () => ({ success: true, status: 'cancelled' });
      const result = await datahub.syncOrderStatus('legacy-1', {
        statusResult: { success: true, status: 'cancelled' },
        externalReference: 'MCBIS-REF-1'
      });
      assert.equal(result.newStatus, scenario.expectedOrderStatus);
    }, {
      wallet: { creditWallet: async () => { refunds++; } },
      settings: {
        mtnFailoverEnabled: true,
        mtnPrimaryProvider: 'MCBIS',
        mtnBackupProvider: 'IDG'
      },
      idg: {
        checkOrderStatus: async () => ({ success: true, status: 'cancelled' }),
        placeOrder: scenario.placeOrder
      }
    });

    assert.equal(order.status, scenario.expectedOrderStatus, scenario.name);
    assert.equal(idgItem.status, 'COMPLETED', scenario.name);
    assert.equal(idgItem.externalReference, 'IDG-EXISTING-REF', scenario.name);
    assert.equal(itemUpdates, 0, scenario.name);
    assert.equal(refunds, 0, scenario.name);
  }
});

test('canonical legacy-first cancellation makes the linked item skip a duplicate refund', async () => {
  const prisma = basePrisma();
  const order = {
    id: 'legacy-1',
    externalReference: 'REF-1',
    providerName: 'MCBIS',
    status: 'PENDING',
    reference: 'ORD-1',
    totalPrice: 10,
    userId: 'user-1',
    recipientPhone: '0240000000',
    bundle: { network: 'telecel' }
  };
  const item = {
    id: 'item-1',
    externalReference: 'REF-1',
    status: 'PENDING',
    reference: 'ORD-1-1',
    orderGroupId: 'group-1',
    orderGroup: { userId: 'user-1' },
    totalPrice: 10,
    recipientPhone: '0240000000'
  };
  let refunds = 0;
  prisma.order.findMany = async () => order.status === 'PENDING' ? [order] : [];
  prisma.order.findUnique = async () => ({ ...order });
  prisma.order.updateMany = async ({ where, data }) => {
    if (where.externalReference !== order.externalReference || where.status !== order.status) {
      return { count: 0 };
    }
    Object.assign(order, data);
    return { count: 1 };
  };
  prisma.orderItem.findMany = async () => [item];
  prisma.orderItem.findFirst = async () => item;
  prisma.orderItem.findUnique = async () => ({ ...item, orderGroup: item.orderGroup });
  prisma.orderItem.updateMany = async ({ where, data }) => {
    const statusMatches = Array.isArray(where.status?.in)
      ? where.status.in.includes(item.status)
      : where.status === item.status;
    if (where.externalReference !== item.externalReference || !statusMatches) {
      return { count: 0 };
    }
    Object.assign(item, data);
    return { count: 1 };
  };
  prisma.orderGroup.findUnique = async () => ({ status: 'PENDING' });
  prisma.orderGroup.update = async () => ({});

  await withActualHandlers(prisma, async ({ datahub, orderGroups }) => {
    const tracker = createMcbisTracker({
      prisma,
      datahub: {
        ...datahub,
        getStatusTrackingCooldown: () => null,
        checkOrderStatus: async () => ({ success: true, status: 'cancelled' })
      },
      orderGroups,
      getSettings: () => ({ mcbisAPI: true, mcbisAutoSync: true }),
      syncState: { syncAllRunning: false },
      log: { info() {}, warn() {}, error() {} }
    });

    const result = await tracker.run();
    assert.equal(result.cancelled, 1);
    assert.equal(result.errors, 0);
    assert.equal(result.results.length, 2);
    assert.equal(result.results[0].newStatus, 'CANCELLED');
    assert.equal(result.results[1].skipped, true);
  }, {
    wallet: {
      creditWallet: async () => {
        refunds++;
        return { success: true };
      }
    },
    settings: { mtnFailoverEnabled: false }
  });
  assert.equal(order.status, 'CANCELLED');
  assert.equal(item.status, 'CANCELLED');
  assert.equal(refunds, 1);
});

test('direct IDG legacy and item status checks still route to the IDG provider', async () => {
  const prisma = basePrisma();
  const idgCalls = [];
  prisma.order.findUnique = async () => ({
    id: 'legacy-idg',
    externalReference: 'IDG-ORDER-1',
    providerName: 'IDG',
    status: 'PENDING',
    reference: null
  });
  prisma.order.update = async () => ({});
  prisma.orderItem.findUnique = async () => ({
    id: 'item-idg',
    externalReference: 'IDG-ITEM-1',
    status: 'PENDING',
    reference: 'ORD-1-1',
    orderGroupId: 'group-1',
    orderGroup: { userId: 'user-1' },
    totalPrice: 10,
    recipientPhone: '0240000000'
  });
  prisma.orderItem.update = async () => ({});

  await withActualHandlers(prisma, async ({ datahub, orderGroups }) => {
    await datahub.syncOrderStatus('legacy-idg');
    await orderGroups.syncOrderItemStatus('item-idg');
    assert.deepEqual(idgCalls, ['IDG-ORDER-1', 'IDG-ITEM-1']);
  }, {
    idg: {
      checkOrderStatus: async reference => {
        idgCalls.push(reference);
        return { success: true, status: 'pending' };
      },
      placeOrder: async () => ({ success: false })
    }
  });
});