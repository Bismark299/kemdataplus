/**
 * TOPUPGH BATCH QUEUE SERVICE
 * ============================
 * Manages the lifecycle of MTN orders routed to TopUpGH:
 *
 *  1. QUEUE   – Mark an OrderItem as waiting for a TopUpGH batch
 *  2. DISPATCH – When ≥ MIN_BATCH_SIZE items queued (or max wait exceeded),
 *               send them to TopUpGH and create a TopUpGHBatch record
 *  3. SYNC    – Poll TopUpGH delivery-status and update each item
 *  4. WEBHOOK – Process delivery updates pushed by TopUpGH
 *
 * Scheduler runs every DISPATCH_INTERVAL_MS (default 5 min).
 * Max wait before forcing a small batch: MAX_WAIT_MINUTES (default 30 min).
 */

const prisma       = require('../lib/prisma');
const topupghSvc   = require('./topupgh.service');

// -------------------------------------------------------
// Configuration
// -------------------------------------------------------
const CONFIG = {
  MIN_BATCH_SIZE       : 5,        // Don't dispatch until we have this many items
  MAX_BATCH_SIZE       : 200,      // Safety cap per dispatch call
  MAX_WAIT_MINUTES     : 30,       // Force-dispatch even if < MIN_BATCH_SIZE after this wait
  DISPATCH_INTERVAL_MS : 5 * 60 * 1000,  // How often the scheduler runs (5 min)
  SYNC_INTERVAL_MS     : 15 * 60 * 1000, // How often to poll delivery status (15 min)
  BATCH_REF_PREFIX     : 'BATCH',
  BATCH_REF_PAD        : 6
};

let dispatchTimer = null;
let syncTimer     = null;

// -------------------------------------------------------
// Helpers
// -------------------------------------------------------

function formatBatchRef(sequenceNum) {
  return `${CONFIG.BATCH_REF_PREFIX}-${String(sequenceNum).padStart(CONFIG.BATCH_REF_PAD, '0')}`;
}

// -------------------------------------------------------
// 1. QUEUE ITEM
// -------------------------------------------------------

/**
 * Mark a single OrderItem as queued for TopUpGH dispatch.
 * Called from order-group.service after an MTN item is created.
 *
 * @param {string} orderItemId
 */
async function queueItem(orderItemId) {
  await prisma.orderItem.update({
    where : { id: orderItemId },
    data  : {
      topupghQueuedAt : new Date(),
      status          : 'PROCESSING'  // Moves away from PENDING so order group shows activity
    }
  });
  console.log(`[TopUpGH Queue] Item ${orderItemId} queued`);
}

// -------------------------------------------------------
// 2. DISPATCH — Check queue and send batches
// -------------------------------------------------------

/**
 * Main dispatch loop.
 * Picks queued MTN items, groups them into batches of up to MAX_BATCH_SIZE,
 * respects MIN_BATCH_SIZE and MAX_WAIT_MINUTES rules, then dispatches.
 */
async function runDispatch() {
  console.log('[TopUpGH Dispatch] Running dispatch check...');

  try {
    // Find all items sitting in the queue (topupghQueuedAt set, no batch yet)
    const queuedItems = await prisma.orderItem.findMany({
      where : {
        topupghQueuedAt : { not: null },
        topupghBatchId  : null,
        status          : 'PROCESSING'
      },
      include : {
        bundle : { select: { network: true, dataAmount: true } }
      },
      orderBy : { topupghQueuedAt: 'asc' }
    });

    if (queuedItems.length === 0) {
      console.log('[TopUpGH Dispatch] Nothing queued');
      return;
    }

    console.log(`[TopUpGH Dispatch] ${queuedItems.length} item(s) in queue`);

    // Determine whether to dispatch now
    const oldest       = queuedItems[0];
    const ageMinutes   = (Date.now() - new Date(oldest.topupghQueuedAt).getTime()) / 60000;
    const shouldForce  = ageMinutes >= CONFIG.MAX_WAIT_MINUTES;
    const hasMinimum   = queuedItems.length >= CONFIG.MIN_BATCH_SIZE;

    if (!hasMinimum && !shouldForce) {
      console.log(
        `[TopUpGH Dispatch] Only ${queuedItems.length}/${CONFIG.MIN_BATCH_SIZE} items. ` +
        `Oldest is ${ageMinutes.toFixed(1)} min old (max wait: ${CONFIG.MAX_WAIT_MINUTES} min). Holding.`
      );
      return;
    }

    if (shouldForce && !hasMinimum) {
      // Max wait reached but still not enough items for Etopup's minimum-5 requirement.
      // Dispatching would just fail. Mark items as FAILED so admin can review and retry
      // them manually (e.g. route through a different provider or wait for more orders).
      console.warn(
        `[TopUpGH Dispatch] MAX_WAIT_MINUTES reached with only ${queuedItems.length} item(s) — ` +
        `not enough to meet Etopup minimum of ${CONFIG.MIN_BATCH_SIZE}. Marking as FAILED.`
      );
      await prisma.orderItem.updateMany({
        where: { id: { in: queuedItems.map(i => i.id) } },
        data: {
          status        : 'FAILED',
          failureReason : `Etopup queue timeout: waited ${Math.round(ageMinutes)} min but only ${queuedItems.length} item(s) queued (min ${CONFIG.MIN_BATCH_SIZE} required). Admin review needed.`
        }
      });
      return;
    }

    if (shouldForce) {
      console.log(`[TopUpGH Dispatch] Force-dispatching: oldest item is ${ageMinutes.toFixed(1)} min old`);
    }

    // Split into batches of MAX_BATCH_SIZE
    for (let offset = 0; offset < queuedItems.length; offset += CONFIG.MAX_BATCH_SIZE) {
      const batchItems = queuedItems.slice(offset, offset + CONFIG.MAX_BATCH_SIZE);
      await _dispatchBatch(batchItems);
    }

  } catch (err) {
    console.error('[TopUpGH Dispatch] Error during dispatch loop:', err);
  }
}

/**
 * Build and send one batch to TopUpGH.
 * Creates a TopUpGHBatch record and links items to it.
 * @param {Array} items - OrderItem records (with bundle relation)
 */
async function _dispatchBatch(items) {
  console.log(`[TopUpGH Dispatch] Dispatching ${items.length} item(s) to TopUpGH`);

  // Build the payload
  const payload = items.map(item => ({
    phone      : item.recipientPhone,
    network    : 'mtn',
    dataSizeGb : topupghSvc.parseDataSizeGb(item.bundle?.dataAmount) || 1
  }));

  // Create the batch record (pending sentAt, no topupghOrderId yet)
  const batch = await prisma.topUpGHBatch.create({
    data: {
      itemCount : items.length,
      status    : 'SUBMITTED',
      sentAt    : new Date()
    }
  });

  // Set the human-readable batchRef from the auto-incremented sequenceNum
  const batchRef = formatBatchRef(batch.sequenceNum);
  await prisma.topUpGHBatch.update({
    where : { id: batch.id },
    data  : { batchRef }
  });

  // Link items to this batch immediately (so they don't get picked again on next tick)
  await prisma.orderItem.updateMany({
    where : { id: { in: items.map(i => i.id) } },
    data  : { topupghBatchId: batch.id }
  });

  try {
    // Call TopUpGH API
    const response = await topupghSvc.createBulkOrder(payload);

    console.log(`[TopUpGH Dispatch] Batch ${batchRef} sent. TopUpGH order_id: ${response.order_id}`);

    // Update batch with response data
    await prisma.topUpGHBatch.update({
      where : { id: batch.id },
      data  : {
        topupghOrderId  : response.order_id,
        itemsAdded      : response.items_added    || items.length,
        itemsSkipped    : response.items_skipped  || 0,
        totalAmount     : response.total_amount   || 0,
        previousBalance : response.previous_balance || 0,
        walletDeducted  : response.wallet_deducted  || 0,
        newBalance      : response.new_balance      || 0,
        rawResponse     : response,
        status          : 'SUBMITTED'
      }
    });

    // Schedule an initial delivery check after 10 minutes
    setTimeout(() => syncBatchDelivery(batch.id), 10 * 60 * 1000);

  } catch (err) {
    console.error(`[TopUpGH Dispatch] Batch ${batchRef} FAILED:`, err.message);

    // Mark batch as failed
    await prisma.topUpGHBatch.update({
      where : { id: batch.id },
      data  : {
        status      : 'FAILED',
        rawResponse : { error: err.message, responseData: err.responseData || null }
      }
    });

    // Differentiate failure type:
    //  - HTTP error (err.statusCode set): Etopup explicitly rejected → safe to auto-retry
    //  - Network error (no statusCode):   Request may have reached Etopup → DO NOT auto-retry
    //    to avoid duplicate dispatch. Admin must manually re-queue after verifying.
    const isCleanRejection = !!err.statusCode;

    if (isCleanRejection) {
      // Etopup said "no" — items never processed, safe to put back in queue
      await prisma.orderItem.updateMany({
        where : { topupghBatchId: batch.id },
        data  : {
          topupghBatchId : null,
          status         : 'PROCESSING',
          failureReason  : `Etopup batch ${batchRef} rejected (HTTP ${err.statusCode}): ${err.message} — will retry`
        }
      });
      console.log(`[TopUpGH Dispatch] Batch ${batchRef} cleanly rejected by Etopup — items returned to queue for auto-retry`);
    } else {
      // Network-level failure — we don't know if Etopup received the request.
      // Keep items as FAILED to prevent duplicate dispatch. Admin must verify
      // via Etopup dashboard before manually re-queuing.
      await prisma.orderItem.updateMany({
        where : { topupghBatchId: batch.id },
        data  : {
          topupghBatchId : null,
          status         : 'FAILED',
          failureReason  : `Etopup batch ${batchRef} network error: ${err.message} — verify on Etopup dashboard before re-queuing`
        }
      });
      console.warn(`[TopUpGH Dispatch] Batch ${batchRef} network error — items held as FAILED to prevent duplicate dispatch`);
    }
  }
}

// -------------------------------------------------------
// 3. DELIVERY STATUS SYNC
// -------------------------------------------------------

/**
 * Poll TopUpGH delivery status for a specific batch and update item records.
 * @param {string} batchId - Internal TopUpGHBatch.id
 */
async function syncBatchDelivery(batchId) {
  const batch = await prisma.topUpGHBatch.findUnique({
    where   : { id: batchId },
    include : { items: true }
  });

  if (!batch) {
    console.log(`[TopUpGH Sync] Batch ${batchId} not found`);
    return;
  }

  if (!batch.topupghOrderId) {
    console.log(`[TopUpGH Sync] Batch ${batch.batchRef} has no topupghOrderId yet`);
    return;
  }

  if (batch.status === 'DELIVERED' || batch.status === 'FAILED') {
    console.log(`[TopUpGH Sync] Batch ${batch.batchRef} already in terminal state (${batch.status})`);
    return;
  }

  try {
    console.log(`[TopUpGH Sync] Checking delivery for batch ${batch.batchRef} (TopUpGH order: ${batch.topupghOrderId})`);
    const response = await topupghSvc.getDeliveryStatus(batch.topupghOrderId);

    // Log the full raw response so we can verify the structure
    console.log(`[TopUpGH Sync] Raw delivery response for ${batch.batchRef}:`, JSON.stringify(response));

    // Support multiple response shapes from the Etopup API
    const apiItems =
      response.delivery_status?.items ||   // { delivery_status: { items: [...] } }
      response.items                  ||   // { items: [...] }
      response.data?.items            ||   // { data: { items: [...] } }
      response.orders                 ||   // { orders: [...] }
      [];

    if (!apiItems.length) {
      console.log(`[TopUpGH Sync] No delivery items in response for batch ${batch.batchRef}. Full response keys: ${Object.keys(response).join(', ')}`);
    }

    await _applyDeliveryStatus(batch, apiItems);

    await prisma.topUpGHBatch.update({
      where : { id: batchId },
      data  : { deliveryCheckedAt: new Date() }
    });
  } catch (err) {
    console.error(`[TopUpGH Sync] Error syncing batch ${batch.batchRef}:`, err.message);
  }
}

/**
 * Run delivery sync for all non-terminal batches.
 * Called on the sync scheduler interval.
 */
async function runSyncAll() {
  console.log('[TopUpGH Sync] Running sync for all active batches...');

  const activeBatches = await prisma.topUpGHBatch.findMany({
    where : {
      status        : { in: ['SUBMITTED', 'PARTIAL'] },
      topupghOrderId: { not: null }
    },
    select : { id: true, batchRef: true }
  });

  console.log(`[TopUpGH Sync] ${activeBatches.length} active batch(es) to sync`);

  for (const b of activeBatches) {
    await syncBatchDelivery(b.id);
  }
}

/**
 * Apply delivery status items from TopUpGH API to our OrderItems.
 * Matches by beneficiary_number (phone).
 *
 * @param {object} batch  - TopUpGHBatch record with items[]
 * @param {Array}  apiItems - Items array from TopUpGH delivery-status response
 */
async function _applyDeliveryStatus(batch, apiItems) {
  if (!apiItems || apiItems.length === 0) return;

  let deliveredCount = 0;
  let pendingCount   = 0;

  for (const apiItem of apiItems) {
    const phone          = apiItem.beneficiary_number;
    const deliveryStatus = apiItem.delivery_status;
    const topupghItemId  = apiItem.item_id;
    const deliveryDate   = apiItem.delivery_date && apiItem.delivery_time
      ? new Date(`${apiItem.delivery_date}T${apiItem.delivery_time}`)
      : null;

    // Find matching internal item by phone number within this batch
    const internalItem = batch.items.find(i => i.recipientPhone === phone);

    if (!internalItem) {
      console.log(`[TopUpGH Sync] No internal item found for phone ${phone} in batch ${batch.batchRef}`);
      continue;
    }

    const isDelivered = (deliveryStatus || '').toLowerCase().includes('deliver');
    const isFailed    = (deliveryStatus || '').toLowerCase().includes('fail');

    await prisma.orderItem.update({
      where : { id: internalItem.id },
      data  : {
        topupghItemId         : topupghItemId,
        topupghDeliveryStatus : deliveryStatus,
        topupghDeliveryDate   : deliveryDate,
        status                : isDelivered ? 'COMPLETED' : isFailed ? 'FAILED' : 'PROCESSING',
        processedAt           : isDelivered ? (deliveryDate || new Date()) : undefined,
        failureReason         : isFailed ? `TopUpGH: ${deliveryStatus}` : undefined
      }
    });

    if (isDelivered) deliveredCount++;
    else pendingCount++;
  }

  // Recalculate batch-level status
  const updatedItems = await prisma.orderItem.findMany({
    where  : { topupghBatchId: batch.id },
    select : { status: true }
  });

  const allDone     = updatedItems.every(i => i.status === 'COMPLETED' || i.status === 'FAILED');
  const anyDelivered= updatedItems.some(i => i.status === 'COMPLETED');
  const batchStatus = allDone
    ? (anyDelivered ? 'DELIVERED' : 'FAILED')
    : (anyDelivered ? 'PARTIAL' : 'SUBMITTED');

  await prisma.topUpGHBatch.update({
    where : { id: batch.id },
    data  : { status: batchStatus }
  });

  console.log(
    `[TopUpGH Sync] Batch ${batch.batchRef}: ${deliveredCount} delivered, ` +
    `${pendingCount} pending → batch status: ${batchStatus}`
  );
}

// -------------------------------------------------------
// 4. WEBHOOK HANDLER
// -------------------------------------------------------

/**
 * Process a webhook payload pushed by TopUpGH.
 * Called from topupgh.routes.js on POST /api/topupgh/webhook
 *
 * @param {object} payload - Raw webhook body
 */
async function handleWebhook(payload) {
  if (payload.event !== 'delivery_status_updated') {
    console.log('[TopUpGH Webhook] Ignoring event:', payload.event);
    return;
  }

  const order       = payload.order;
  const topupghOId  = order?.order_id;
  const apiItems    = order?.items || [];

  if (!topupghOId) {
    console.log('[TopUpGH Webhook] Missing order_id in payload');
    return;
  }

  console.log(`[TopUpGH Webhook] Delivery update for TopUpGH order ${topupghOId}, ${apiItems.length} item(s)`);

  const batch = await prisma.topUpGHBatch.findFirst({
    where   : { topupghOrderId: topupghOId },
    include : { items: true }
  });

  if (!batch) {
    console.log(`[TopUpGH Webhook] No batch found for TopUpGH order ${topupghOId}`);
    return;
  }

  await _applyDeliveryStatus(batch, apiItems);

  await prisma.topUpGHBatch.update({
    where : { id: batch.id },
    data  : { deliveryCheckedAt: new Date() }
  });
}

// -------------------------------------------------------
// 5. ADMIN — Queue info & manual force-dispatch
// -------------------------------------------------------

/**
 * Return current queue stats for the admin page.
 */
async function getQueueStats() {
  const queued = await prisma.orderItem.findMany({
    where : {
      topupghQueuedAt : { not: null },
      topupghBatchId  : null,
      status          : 'PROCESSING'
    },
    orderBy : { topupghQueuedAt: 'asc' },
    select  : { id: true, topupghQueuedAt: true, recipientPhone: true }
  });

  const oldest = queued[0]?.topupghQueuedAt || null;
  const ageMinutes = oldest
    ? Math.floor((Date.now() - new Date(oldest).getTime()) / 60000)
    : 0;

  return {
    queuedCount : queued.length,
    oldestQueuedAt : oldest,
    ageMinutes,
    readyToDispatch : queued.length >= CONFIG.MIN_BATCH_SIZE || ageMinutes >= CONFIG.MAX_WAIT_MINUTES,
    minBatchSize    : CONFIG.MIN_BATCH_SIZE,
    maxWaitMinutes  : CONFIG.MAX_WAIT_MINUTES
  };
}

/**
 * Manually trigger dispatch (admin "Force Dispatch" button).
 * Bypasses the minimum batch size check.
 */
async function forceDispatch() {
  const queuedItems = await prisma.orderItem.findMany({
    where : {
      topupghQueuedAt : { not: null },
      topupghBatchId  : null,
      status          : 'PROCESSING'
    },
    include : { bundle : { select: { network: true, dataAmount: true } } },
    orderBy : { topupghQueuedAt: 'asc' }
  });

  if (queuedItems.length === 0) {
    return { dispatched: false, message: 'Queue is empty' };
  }

  for (let offset = 0; offset < queuedItems.length; offset += CONFIG.MAX_BATCH_SIZE) {
    await _dispatchBatch(queuedItems.slice(offset, offset + CONFIG.MAX_BATCH_SIZE));
  }

  return { dispatched: true, itemCount: queuedItems.length };
}

// -------------------------------------------------------
// 6. SCHEDULER
// -------------------------------------------------------

/**
 * Start background timers for dispatch + delivery sync.
 * Call once from server startup (index.js).
 */
function startScheduler() {
  if (dispatchTimer || syncTimer) {
    console.log('[TopUpGH Scheduler] Already running');
    return;
  }

  console.log(
    `[TopUpGH Scheduler] Starting — dispatch every ${CONFIG.DISPATCH_INTERVAL_MS / 60000} min, ` +
    `sync every ${CONFIG.SYNC_INTERVAL_MS / 60000} min`
  );

  dispatchTimer = setInterval(runDispatch, CONFIG.DISPATCH_INTERVAL_MS);
  syncTimer     = setInterval(runSyncAll,  CONFIG.SYNC_INTERVAL_MS);

  // Run once at startup (after a short delay to let DB connect)
  setTimeout(runDispatch, 30 * 1000);
  setTimeout(runSyncAll,  60 * 1000);
}

function stopScheduler() {
  if (dispatchTimer) { clearInterval(dispatchTimer); dispatchTimer = null; }
  if (syncTimer)     { clearInterval(syncTimer);     syncTimer     = null; }
  console.log('[TopUpGH Scheduler] Stopped');
}

module.exports = {
  queueItem,
  runDispatch,
  syncBatchDelivery,
  runSyncAll,
  handleWebhook,
  getQueueStats,
  forceDispatch,
  startScheduler,
  stopScheduler
};
