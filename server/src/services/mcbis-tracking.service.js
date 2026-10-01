/**
 * MCBIS status tracking only. No dispatch/balance/financial logic lives here.
 * Reuse the existing status handlers to preserve their business rules.
 * Scheduling metadata is process-local and never overwrites order.updatedAt.
 */
function createMcbisTracker({ prisma, datahub, orderGroups, getSettings, syncState,
  now = Date.now, log = console, batchSize = 30, checkIntervalMs = 120000,
  notFoundRecheckMs = 60 * 60 * 1000 } = {}) {
  const schedule = new Map();
  let running = null;
  let timer = null;
  let stopped = false;
  let pausedUntil = 0;
  let pauseReason = null;

  const enabled = () => {
    const settings = getSettings();
    return !!(settings.mcbisAPI && settings.mcbisAutoSync);
  };

  async function candidates() {
    const where = { status: { in: ['PENDING', 'PROCESSING'] }, externalReference: { not: null } };
    const select = { id: true, reference: true, externalReference: true, createdAt: true };
    const [orders, items] = await Promise.all([
      prisma.order.findMany({
        where: { ...where, OR: [{ providerName: 'MCBIS' }, { providerName: null }],
          NOT: ['IDG-', 'DGK-', 'CK-'].map(prefix => ({ externalReference: { startsWith: prefix } })) },
        select
      }),
      prisma.orderItem.findMany({
        where: { ...where, NOT: ['IDG-', 'DGK-', 'CK-'].map(prefix => ({ externalReference: { startsWith: prefix } })) },
        select
      })
    ]);
    const references = new Map();
    for (const [kind, rows] of [['order', orders], ['item', items]]) {
      for (const row of rows) {
        let entry = references.get(row.externalReference);
        if (!entry) {
          entry = { reference: row.externalReference, createdAt: +new Date(row.createdAt), orders: [], items: [] };
          references.set(row.externalReference, entry);
        }
        entry.createdAt = Math.min(entry.createdAt, +new Date(row.createdAt));
        entry[kind === 'order' ? 'orders' : 'items'].push(row);
      }
    }
    for (const reference of schedule.keys()) {
      if (!references.has(reference)) schedule.delete(reference);
    }
    return [...references.values()].sort((a, b) =>
      (schedule.get(a.reference)?.lastCheckedAt ?? -Infinity) - (schedule.get(b.reference)?.lastCheckedAt ?? -Infinity) ||
      a.createdAt - b.createdAt || a.reference.localeCompare(b.reference));
  }

  async function track({ catchUp = false, manual = false, reference, targetKind, targetId } = {}) {
    const result = { checked: 0, completed: 0, cancelled: 0, failed: 0, unchanged: 0, errors: 0, notFound: 0, results: [] };
    if ((!manual && (!enabled() || syncState.syncAllRunning)) || stopped) return result;
    if (targetId) {
      const model = targetKind === 'order' ? prisma.order : prisma.orderItem;
      const target = await model.findUnique({
        where: { id: targetId },
        select: { id: true, status: true, externalReference: true }
      });
      const key = targetKind === 'order' ? 'orderId' : 'itemId';
      if (!target) return { ...result, errors: 1, results: [{ [key]: targetId, success: false, error: 'Order not found' }] };
      if (!['PENDING', 'PROCESSING'].includes(target.status) || target.externalReference !== reference) {
        return { ...result, results: [{ [key]: targetId, success: true, skipped: true,
          previousStatus: target.status, newStatus: target.status, statusChanged: false, message: 'Status preserved' }] };
      }
    }
    if (now() < pausedUntil) {
      return { ...result, paused: true, reason: pauseReason };
    }
    const cooldown = datahub.getStatusTrackingCooldown();
    if (cooldown) {
      log.warn(`[MCBIS Tracking] Paused: ${cooldown}`);
      return { ...result, paused: true, reason: cooldown };
    }
    const candidatesList = await candidates();
    const all = reference ? candidatesList.filter(entry => entry.reference === reference) : candidatesList;
    // A specific manual check can retry immediately. Broad catch-up passes
    // respect missing-reference backoff so Sync All cannot replay the backlog.
    const eligible = all.filter(entry => reference || (schedule.get(entry.reference)?.notFoundUntil ?? 0) <= now());
    const due = catchUp ? eligible : eligible.filter(entry => (schedule.get(entry.reference)?.nextCheckAt ?? 0) <= now()).slice(0, batchSize);
    let consecutiveErrors = 0;
    for (const entry of due) {
      // Settings are re-read during long batches, not just once on startup.
      if (stopped || (!manual && (!enabled() || syncState.syncAllRunning))) break;
      const block = datahub.getStatusTrackingCooldown();
      if (block) {
        result.paused = true;
        result.reason = block;
        break;
      }
      let providerResult;
      let missingReference = false;
      try {
        providerResult = await datahub.checkOrderStatus(entry.reference);
        result.checked++;
        // Empty/unknown provider responses must not trigger financial effects.
        const knownStatus = /^(pending|processing|initiated|queued|awaiting_delivery|success|successful|completed|delivered|failed|fail|error|rejected|cancelled|canceled|cancel|refunded)$/i;
        if (!providerResult.success && providerResult.httpStatus === 404) {
          // A missing order is a reference-specific problem, not an outage.
          // Preserve all local status/financial records and keep checking others.
          missingReference = true;
          result.errors++;
          result.notFound++;
          consecutiveErrors = 0;
          log.warn(`[MCBIS Tracking] Reference not found: ${entry.reference}; recheck in ${Math.ceil(Math.max(checkIntervalMs, notFoundRecheckMs) / 1000)}s; continuing with other orders`);
        } else if (!providerResult.success || !knownStatus.test(providerResult.status || '')) {
          result.errors++;
          consecutiveErrors++;
          log.warn(`[MCBIS Tracking] Status unavailable for ${entry.reference}: ${providerResult.error || 'unrecognized status'}`);
        } else {
          consecutiveErrors = 0;
          const options = { statusResult: providerResult, externalReference: entry.reference };
          const applied = [];
          let applicationFailed = false;
          // Legacy handler first: preserves its MTN failover and related-record
          // propagation. Item handler re-reads and skips settled/rerouted items.
          for (const order of entry.orders) {
            const row = { orderId: order.id, ...await datahub.syncOrderStatus(order.id, options) };
            applied.push(row);
            result.results.push(row);
            if (!row.success) { applicationFailed = true; break; }
          }
          if (!applicationFailed) for (const item of entry.items) {
            const row = { itemId: item.id, ...await orderGroups.syncOrderItemStatus(item.id, options) };
            applied.push(row);
            result.results.push(row);
            if (!row.success) { applicationFailed = true; break; }
          }
          if (applicationFailed) {
            result.errors++;
            consecutiveErrors++;
            log.error(`[MCBIS Tracking] Local status application failed for ${entry.reference}`);
          } else {
            // Count per distinct provider reference using actual transitions,
            // not the response: MTN failover can keep an order PROCESSING.
            const transition = applied.find(row => !row.skipped && row.newStatus && row.newStatus !== row.previousStatus);
            if (transition?.newStatus === 'COMPLETED') result.completed++;
            else if (transition?.newStatus === 'CANCELLED') result.cancelled++;
            else if (transition?.newStatus === 'FAILED') result.failed++;
            else result.unchanged++;
          }
        }
      } catch (error) {
        result.errors++;
        consecutiveErrors++;
        log.error(`[MCBIS Tracking] Check/apply failed for ${entry.reference}: ${error.message}`);
      } finally {
        const checkedAt = now();
        const nextCheckAt = checkedAt + (missingReference ? Math.max(checkIntervalMs, notFoundRecheckMs) : checkIntervalMs);
        schedule.set(entry.reference, { lastCheckedAt: checkedAt, nextCheckAt,
          notFoundUntil: missingReference ? nextCheckAt : 0 });
      }
      // Stop the batch on access blocks/rate limits, rather than cycling over
      // every remaining order and producing duplicate errors.
      if (datahub.getStatusTrackingCooldown() || [401, 403, 429].includes(providerResult?.httpStatus)) {
        result.paused = true;
        result.reason = datahub.getStatusTrackingCooldown() || `HTTP ${providerResult.httpStatus}`;
        // Status-only pause for responses that the existing provider-wide
        // cooldown does not cover. Do not change wallet/dispatch behavior.
        pausedUntil = now() + ([401, 429].includes(providerResult?.httpStatus) ? 300000 : 60000);
        pauseReason = result.reason;
        break;
      }
      if (consecutiveErrors >= 3) {
        pausedUntil = now() + 60000;
        pauseReason = 'Three consecutive status-check errors; pausing tracking for 60 seconds';
        result.paused = true;
        result.reason = pauseReason;
        break;
      }
    }
    log.info(`[MCBIS Tracking] backlog=${all.length} checked=${result.checked} completed=${result.completed} cancelled=${result.cancelled} failed=${result.failed} errors=${result.errors} notFound=${result.notFound}${result.paused ? ' paused' : ''}`);
    return result;
  }

  function run(options = {}) {
    if (running) {
      // Manual catch-up waits for the automatic batch; automatic ticks never overlap.
      if (options.manual || options.catchUp) {
        return running.then(() => run(options));
      }
      return running;
    }
    running = track(options).finally(() => { running = null; });
    return running;
  }

  function start() {
    if (timer) return;
    stopped = false;
    const tick = () => run().catch(error => log.error(`[MCBIS Tracking] Worker error: ${error.message}`));
    timer = setInterval(tick, 15000);
    tick();
  }

  function stop() {
    stopped = true;
    clearInterval(timer);
    timer = null;
  }

  async function syncRecord(kind, id, reference) {
    const result = await run({ manual: true, catchUp: true, reference, targetKind: kind, targetId: id });
    const key = kind === 'order' ? 'orderId' : 'itemId';
    const applied = result.results.find(row => row[key] === id);
    if (applied) return applied;
    if (result.paused || result.errors) {
      return { success: false, error: result.reason || 'MCBIS status check or local update failed; try again later' };
    }
    return { success: true, skipped: true, statusChanged: false, message: 'No active order remains for this provider reference' };
  }

  return { run, start, stop, syncRecord };
}

let tracker;
function getTracker() {
  if (!tracker) {
    tracker = createMcbisTracker({
      prisma: require('../lib/prisma'),
      datahub: require('./datahub.service'),
      orderGroups: require('./order-group.service'),
      getSettings: () => require('../controllers/settings.controller').getSiteSettings(),
      syncState: require('../lib/sync-state')
    });
  }
  return tracker;
}

module.exports = {
  createMcbisTracker,
  run: options => getTracker().run(options),
  syncRecord: (kind, id, reference) => getTracker().syncRecord(kind, id, reference),
  start: () => getTracker().start(),
  stop: () => getTracker().stop()
};