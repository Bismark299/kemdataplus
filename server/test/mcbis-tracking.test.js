const test = require('node:test');
const assert = require('node:assert/strict');

const { createMcbisTracker } = require('../src/services/mcbis-tracking.service');
const { createStatusQueue } = require('../src/lib/mcbis-status-queue');

const silentLog = { info() {}, warn() {}, error() {} };

function row(id, externalReference, createdAt = new Date(0)) {
  return { id, reference: id, externalReference, createdAt, status: 'PENDING' };
}

function appliedStatus(statusResult) {
  const status = (statusResult.status || '').toLowerCase();
  const newStatus = ['success', 'successful', 'completed', 'delivered'].includes(status)
    ? 'COMPLETED'
    : ['cancelled', 'canceled', 'cancel', 'refunded'].includes(status)
      ? 'CANCELLED'
      : ['failed', 'fail', 'error', 'rejected'].includes(status)
        ? 'FAILED'
        : 'PROCESSING';
  return { success: true, previousStatus: 'PENDING', newStatus, statusChanged: true };
}

function makeTracker({
  orders = [],
  items = [],
  findOrderUnique,
  findItemUnique,
  settings = { mcbisAPI: true, mcbisAutoSync: true },
  syncState = { syncAllRunning: false },
  checkOrderStatus = async () => ({ success: true, status: 'pending' }),
  getCooldown = () => null,
  syncOrderStatus = async (id, options) => appliedStatus(options.statusResult),
  syncOrderItemStatus = async (id, options) => appliedStatus(options.statusResult),
  now = () => 0,
  batchSize = 30,
  checkIntervalMs = 120000
} = {}) {
  const queries = {};
  const prisma = {
    order: {
      findUnique: findOrderUnique || (async ({ where }) => orders.find(order => order.id === where.id) || null),
      findMany: async query => {
        queries.orders = query;
        return orders;
      }
    },
    orderItem: {
      findUnique: findItemUnique || (async ({ where }) => items.find(item => item.id === where.id) || null),
      findMany: async query => {
        queries.items = query;
        return items;
      }
    }
  };
  const datahub = {
    checkOrderStatus,
    getStatusTrackingCooldown: getCooldown,
    syncOrderStatus
  };
  const orderGroups = { syncOrderItemStatus };
  const tracker = createMcbisTracker({
    prisma,
    datahub,
    orderGroups,
    getSettings: () => settings,
    syncState,
    now,
    batchSize,
    checkIntervalMs,
    log: silentLog
  });
  return { tracker, queries };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test('unchanged references rotate fairly through batches larger than batchSize', async () => {
  let now = 0;
  const refs = ['REF-A', 'REF-B', 'REF-C', 'REF-D', 'REF-E'];
  const checked = [];
  const { tracker } = makeTracker({
    orders: refs.map((ref, index) => row(`order-${index}`, ref)),
    batchSize: 2,
    now: () => now,
    checkOrderStatus: async reference => {
      checked.push(reference);
      return { success: true, status: 'pending' };
    }
  });

  await tracker.run();
  now += 120000;
  await tracker.run();
  now += 120000;
  await tracker.run();

  assert.deepEqual(checked, ['REF-A', 'REF-B', 'REF-C', 'REF-D', 'REF-E', 'REF-A']);
});

test('references are not checked again before 120 seconds, and become due at the interval', async () => {
  let now = 500;
  let calls = 0;
  const { tracker } = makeTracker({
    orders: [row('order-1', 'REF-1')],
    now: () => now,
    checkOrderStatus: async () => {
      calls++;
      return { success: true, status: 'pending' };
    }
  });

  assert.equal((await tracker.run()).checked, 1);
  now += 119999;
  assert.equal((await tracker.run()).checked, 0);
  assert.equal(calls, 1);
  now += 1;
  assert.equal((await tracker.run()).checked, 1);
  assert.equal(calls, 2);
});

test('legacy orders and items are unioned and deduplicated, with prefetched status passed legacy-first', async () => {
  const events = [];
  const providerStatus = { success: true, status: 'completed', provider: 'prefetched' };
  const { tracker } = makeTracker({
    orders: [row('legacy-1', 'SHARED'), row('legacy-2', 'SHARED')],
    items: [row('item-1', 'SHARED'), row('item-2', 'SHARED')],
    checkOrderStatus: async reference => {
      events.push(`check:${reference}`);
      return providerStatus;
    },
    syncOrderStatus: async (id, options) => {
      events.push(`legacy:${id}`);
      assert.strictEqual(options.statusResult, providerStatus);
      assert.equal(options.externalReference, 'SHARED');
      return appliedStatus(options.statusResult);
    },
    syncOrderItemStatus: async (id, options) => {
      events.push(`item:${id}`);
      assert.strictEqual(options.statusResult, providerStatus);
      assert.equal(options.externalReference, 'SHARED');
      return appliedStatus(options.statusResult);
    }
  });

  const result = await tracker.run();
  assert.equal(result.checked, 1);
  assert.deepEqual(events, [
    'check:SHARED',
    'legacy:legacy-1',
    'legacy:legacy-2',
    'item:item-1',
    'item:item-2'
  ]);
});

test('candidate queries exclude IDG, DGK, and CK external-reference prefixes', async () => {
  const { tracker, queries } = makeTracker();
  await tracker.run();

  const prefixes = ['IDG-', 'DGK-', 'CK-'];
  for (const query of [queries.orders, queries.items]) {
    assert.ok(query, 'both legacy-order and item candidate queries should run');
    assert.deepEqual(
      query.where.NOT.map(condition => condition.externalReference.startsWith),
      prefixes
    );
  }
});

test('automatic tracking honors initially disabled and mid-batch settings', async () => {
  for (const settings of [
    { mcbisAPI: false, mcbisAutoSync: true },
    { mcbisAPI: true, mcbisAutoSync: false }
  ]) {
    let calls = 0;
    const { tracker } = makeTracker({
      orders: [row('order-1', 'REF-1')],
      settings,
      checkOrderStatus: async () => {
        calls++;
        return { success: true, status: 'pending' };
      }
    });
    assert.equal((await tracker.run()).checked, 0);
    assert.equal(calls, 0);
  }

  const settings = { mcbisAPI: true, mcbisAutoSync: true };
  const checked = [];
  const { tracker } = makeTracker({
    orders: ['REF-A', 'REF-B', 'REF-C'].map((ref, index) => row(`order-${index}`, ref)),
    batchSize: 3,
    settings,
    checkOrderStatus: async reference => {
      checked.push(reference);
      settings.mcbisAutoSync = false;
      return { success: true, status: 'pending' };
    }
  });

  const result = await tracker.run();
  assert.equal(result.checked, 1);
  assert.equal(checked.length, 1, 'the batch should stop after auto-sync is disabled');
});

test('manual catch-up overrides auto-sync and sync-all guards, and waits for an active automatic run', async () => {
  const firstCheck = deferred();
  const started = deferred();
  const checked = [];
  const settings = { mcbisAPI: true, mcbisAutoSync: true };
  const syncState = { syncAllRunning: false };
  const { tracker } = makeTracker({
    orders: [row('order-1', 'REF-A'), row('order-2', 'REF-B')],
    batchSize: 2,
    settings,
    syncState,
    checkOrderStatus: async reference => {
      checked.push(reference);
      if (checked.length === 1) {
        started.resolve();
        await firstCheck.promise;
      }
      return { success: true, status: 'pending' };
    }
  });

  const automaticRun = tracker.run();
  await started.promise;
  settings.mcbisAPI = false;
  settings.mcbisAutoSync = false;
  syncState.syncAllRunning = true;
  const manualRun = tracker.run({ manual: true, catchUp: true });

  assert.deepEqual(checked, ['REF-A'], 'manual work must wait for the in-flight automatic batch');
  firstCheck.resolve();
  await automaticRun;
  const manualResult = await manualRun;

  assert.equal(manualResult.checked, 2);
  assert.deepEqual(checked, ['REF-A', 'REF-B', 'REF-A']);
});

test('cooldown pauses on the first blocked response instead of producing backlog errors', async () => {
  let cooldown = null;
  let calls = 0;
  const { tracker } = makeTracker({
    orders: ['REF-A', 'REF-B', 'REF-C'].map((ref, index) => row(`order-${index}`, ref)),
    getCooldown: () => cooldown,
    checkOrderStatus: async () => {
      calls++;
      cooldown = 'provider rate limit';
      return { success: true, status: 'pending' };
    }
  });

  const result = await tracker.run();
  assert.equal(calls, 1);
  assert.equal(result.checked, 1);
  assert.equal(result.errors, 0);
  assert.equal(result.paused, true);
  assert.equal(result.reason, 'provider rate limit');
});

test('failed provider responses and unknown statuses never invoke status handlers', async () => {
  const cases = [
    { success: false, status: 'completed', error: 'provider failure' },
    { success: true, status: 'not-a-status' }
  ];

  for (const providerResult of cases) {
    let handlerCalls = 0;
    const { tracker } = makeTracker({
      orders: [row('legacy-1', 'REF-1')],
      items: [row('item-1', 'REF-1')],
      checkOrderStatus: async () => providerResult,
      syncOrderStatus: async () => {
        handlerCalls++;
      },
      syncOrderItemStatus: async () => {
        handlerCalls++;
      }
    });

    const result = await tracker.run();
    assert.equal(result.checked, 1);
    assert.equal(result.errors, 1);
    assert.equal(handlerCalls, 0);
  }
});

test('failed status calls still advance scheduling so the batch rotates to another reference', async () => {
  let now = 0;
  const checked = [];
  const { tracker } = makeTracker({
    orders: [row('order-a', 'REF-A'), row('order-b', 'REF-B')],
    batchSize: 1,
    now: () => now,
    checkOrderStatus: async reference => {
      checked.push(reference);
      if (reference === 'REF-A') throw new Error('temporary provider failure');
      return { success: true, status: 'pending' };
    }
  });

  const failed = await tracker.run();
  assert.equal(failed.errors, 1);
  assert.equal(failed.checked, 0);
  now += 120000;
  const rotated = await tracker.run();

  assert.equal(rotated.checked, 1);
  assert.deepEqual(checked, ['REF-A', 'REF-B']);
});

test('run({ reference }) checks only the requested provider reference', async () => {
  const checked = [];
  const { tracker } = makeTracker({
    orders: ['REF-A', 'REF-B', 'REF-C'].map((ref, index) => row(`order-${index}`, ref)),
    checkOrderStatus: async reference => {
      checked.push(reference);
      return { success: true, status: 'pending' };
    }
  });

  const result = await tracker.run({ reference: 'REF-B' });
  assert.equal(result.checked, 1);
  assert.deepEqual(checked, ['REF-B']);
});

test('a failed local handler increments errors and stops linked status applications', async () => {
  const events = [];
  const { tracker } = makeTracker({
    orders: [row('legacy-1', 'REF-1'), row('legacy-2', 'REF-1')],
    items: [row('item-1', 'REF-1'), row('item-2', 'REF-1')],
    syncOrderStatus: async id => {
      events.push(`legacy:${id}`);
      return { success: false, error: 'conditional update lost' };
    },
    syncOrderItemStatus: async id => {
      events.push(`item:${id}`);
      return appliedStatus({ status: 'completed' });
    }
  });

  const result = await tracker.run();
  assert.equal(result.errors, 1);
  assert.equal(result.completed, 0);
  assert.deepEqual(events, ['legacy:legacy-1']);
});

test('a rerouted failed status does not count as failed or cancelled', async () => {
  const { tracker } = makeTracker({
    orders: [row('legacy-1', 'REF-1')],
    checkOrderStatus: async () => ({ success: true, status: 'failed' }),
    syncOrderStatus: async () => ({
      success: true,
      previousStatus: 'PENDING',
      newStatus: 'PROCESSING',
      rerouted: true
    })
  });

  const result = await tracker.run();
  assert.equal(result.failed, 0);
  assert.equal(result.cancelled, 0);
  assert.equal(result.completed, 0);
  assert.equal(result.unchanged, 1);
});

test('a skipped completed handler does not increment completed', async () => {
  const { tracker } = makeTracker({
    orders: [row('legacy-1', 'REF-1')],
    checkOrderStatus: async () => ({ success: true, status: 'completed' }),
    syncOrderStatus: async () => ({
      success: true,
      skipped: true,
      previousStatus: 'COMPLETED',
      newStatus: 'COMPLETED'
    })
  });

  const result = await tracker.run();
  assert.equal(result.completed, 0);
  assert.equal(result.unchanged, 1);
});

test('syncRecord waits for an automatic run and a settled record is not applied twice', async () => {
  const started = deferred();
  const releaseAutomatic = deferred();
  let status = 'PENDING';
  let providerChecks = 0;
  let applications = 0;
  const order = row('legacy-1', 'REF-1');
  const { tracker } = makeTracker({
    orders: [order],
    checkOrderStatus: async () => {
      providerChecks++;
      if (providerChecks === 1) {
        started.resolve();
        await releaseAutomatic.promise;
      }
      return { success: true, status: 'completed' };
    },
    syncOrderStatus: async () => {
      if (status !== 'PENDING') {
        return { success: true, skipped: true, previousStatus: status, newStatus: status };
      }
      applications++;
      status = 'COMPLETED';
      order.status = status;
      return { success: true, previousStatus: 'PENDING', newStatus: 'COMPLETED' };
    }
  });

  const automaticRun = tracker.run();
  await started.promise;
  const manualSync = tracker.syncRecord('order', 'legacy-1', 'REF-1');
  assert.equal(providerChecks, 1, 'manual sync should wait for the active automatic status read');
  releaseAutomatic.resolve();
  await automaticRun;
  const result = await manualSync;

  assert.equal(providerChecks, 1, 'the settled target is re-read before a second provider check');
  assert.equal(applications, 1, 'the settled record is not applied a second time');
  assert.equal(result.success, true);
  assert.equal(result.skipped, true);
});

test('syncRecord returns a terminal target status without calling the provider', async () => {
  let providerCalls = 0;
  let targetReads = 0;
  const { tracker } = makeTracker({
    orders: [row('legacy-1', 'REF-1')],
    findOrderUnique: async () => {
      targetReads++;
      return { id: 'legacy-1', status: 'COMPLETED', externalReference: 'REF-1' };
    },
    checkOrderStatus: async () => {
      providerCalls++;
      return { success: true, status: 'completed' };
    }
  });

  const result = await tracker.syncRecord('order', 'legacy-1', 'REF-1');
  assert.equal(targetReads, 1);
  assert.equal(providerCalls, 0);
  assert.equal(result.success, true);
  assert.equal(result.skipped, true);
  assert.equal(result.previousStatus, 'COMPLETED');
  assert.equal(result.newStatus, 'COMPLETED');
});

test('syncRecord skips a target whose provider reference changed before the check', async () => {
  let providerCalls = 0;
  const { tracker } = makeTracker({
    orders: [row('legacy-1', 'REF-NEW')],
    findOrderUnique: async () => ({
      id: 'legacy-1',
      status: 'PROCESSING',
      externalReference: 'REF-NEW'
    }),
    checkOrderStatus: async () => {
      providerCalls++;
      return { success: true, status: 'completed' };
    }
  });

  const result = await tracker.syncRecord('order', 'legacy-1', 'REF-OLD');
  assert.equal(providerCalls, 0);
  assert.equal(result.success, true);
  assert.equal(result.skipped, true);
  assert.equal(result.previousStatus, 'PROCESSING');
});

test('status queue serializes references, coalesces concurrent same-reference calls without caching, and recovers after rejection', async () => {
  const events = [];
  const first = deferred();
  const firstStarted = deferred();
  const queue = createStatusQueue({ spacingMs: 0, now: () => 0 });

  const firstRequest = queue.run('REF-A', () => {
    events.push('A:start');
    firstStarted.resolve();
    return first.promise;
  });
  const duplicateRequest = queue.run('REF-A', () => {
    events.push('A:duplicate');
  });
  assert.strictEqual(duplicateRequest, firstRequest);

  const secondRequest = queue.run('REF-B', async () => {
    events.push('B:start');
  });
  await firstStarted.promise;
  assert.deepEqual(events, ['A:start'], 'a different reference waits for the current status read');
  first.resolve('A result');
  assert.equal(await firstRequest, 'A result');
  await duplicateRequest;
  await secondRequest;
  assert.deepEqual(events, ['A:start', 'B:start']);

  await queue.run('REF-A', async () => {
    events.push('A:again');
    return 'fresh result';
  });
  assert.deepEqual(events, ['A:start', 'B:start', 'A:again']);

  const rejectedRequest = queue.run('REF-C', async () => {
    events.push('C:reject');
    throw new Error('status read failed');
  });
  const recoveryRequest = queue.run('REF-D', async () => {
    events.push('D:recovered');
    return 'recovered';
  });
  await assert.rejects(rejectedRequest, /status read failed/);
  assert.equal(await recoveryRequest, 'recovered');
  assert.deepEqual(events.slice(-2), ['C:reject', 'D:recovered']);
});