/**
 * TOPUPGH ROUTES
 * ===============
 * Webhook endpoint (public) + Admin API endpoints for batch management.
 *
 * Routes:
 *   POST /api/topupgh/webhook              – TopUpGH delivery status push (no auth)
 *   GET  /api/topupgh/balance              – Live TopUpGH wallet balance (Admin)
 *   GET  /api/topupgh/queue                – Current queue stats (Admin)
 *   POST /api/topupgh/queue/dispatch       – Force dispatch queued items (Admin)
 *   GET  /api/topupgh/batches              – Paginated batch list (Admin)
 *   GET  /api/topupgh/batches/:batchRef    – Single batch detail with items (Admin)
 *   POST /api/topupgh/batches/:batchRef/sync – Manually re-check delivery status (Admin)
 *   GET  /api/topupgh/test                 – Test API connection (Admin)
 */

const express     = require('express');
const router      = express.Router();
const prisma      = require('../lib/prisma');
const { authenticate, authorize } = require('../middleware/auth');
const topupghSvc  = require('../services/topupgh.service');
const batchSvc    = require('../services/topupgh-batch.service');

// ============================================================
// WEBHOOK  (no auth — called by TopUpGH servers)
// ============================================================

/**
 * POST /api/topupgh/webhook
 * TopUpGH pushes delivery_status_updated events here.
 */
router.post('/webhook', async (req, res) => {
  try {
    const payload = req.body;

    if (!payload || typeof payload !== 'object') {
      return res.status(400).json({ error: 'Invalid payload' });
    }

    // Respond immediately (TopUpGH expects 200 quickly)
    res.status(200).send('OK');

    // Process asynchronously so we don't time out their webhook delivery
    setImmediate(() => {
      batchSvc.handleWebhook(payload).catch(err =>
        console.error('[TopUpGH Webhook] Handler error:', err)
      );
    });

  } catch (err) {
    console.error('[TopUpGH Webhook] Unexpected error:', err);
    res.status(200).send('OK'); // Still return 200 to prevent TopUpGH retries
  }
});

// ============================================================
// ADMIN ROUTES — all require ADMIN role
// ============================================================

/**
 * GET /api/topupgh/test
 * Verify API credentials are working.
 */
router.get('/test', authenticate, authorize('ADMIN'), async (req, res, next) => {
  try {
    const result = await topupghSvc.testConnection();
    res.json(result);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/topupgh/balance
 * Live TopUpGH wallet balance.
 */
router.get('/balance', authenticate, authorize('ADMIN'), async (req, res, next) => {
  try {
    const result = await topupghSvc.getWalletBalance();
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ============================================================
// QUEUE MANAGEMENT
// ============================================================

/**
 * GET /api/topupgh/queue
 * Returns current queue size, oldest item age, dispatch readiness.
 */
router.get('/queue', authenticate, authorize('ADMIN'), async (req, res, next) => {
  try {
    const stats = await batchSvc.getQueueStats();
    res.json({ success: true, ...stats });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/topupgh/queue/dispatch
 * Admin manually forces dispatch of all queued items (bypasses minimum).
 */
router.post('/queue/dispatch', authenticate, authorize('ADMIN'), async (req, res, next) => {
  try {
    const result = await batchSvc.forceDispatch();
    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
});

// ============================================================
// BATCH LIST & DETAIL
// ============================================================

/**
 * GET /api/topupgh/batches
 * Paginated list of all TopUpGH batches.
 * Query: page, per_page, status
 */
router.get('/batches', authenticate, authorize('ADMIN'), async (req, res, next) => {
  try {
    const page     = Math.max(1, parseInt(req.query.page)     || 1);
    const perPage  = Math.min(100, parseInt(req.query.per_page) || 20);
    const skip     = (page - 1) * perPage;

    const where = {};

    // Status filter
    if (req.query.status) where.status = req.query.status;

    // Date range filter (on sentAt)
    if (req.query.date_from || req.query.date_to) {
      where.sentAt = {};
      if (req.query.date_from) where.sentAt.gte = new Date(req.query.date_from);
      if (req.query.date_to) {
        const to = new Date(req.query.date_to);
        to.setHours(23, 59, 59, 999);
        where.sentAt.lte = to;
      }
    }

    // Batch ref filter (partial match)
    if (req.query.batch_ref) {
      where.batchRef = { contains: req.query.batch_ref.trim(), mode: 'insensitive' };
    }

    // Phone filter — match batches that contain at least one item with this phone
    if (req.query.phone) {
      where.items = {
        some: { recipientPhone: { contains: req.query.phone.trim() } }
      };
    }

    const [batches, total] = await Promise.all([
      prisma.topUpGHBatch.findMany({
        where,
        orderBy : { createdAt: 'desc' },
        skip,
        take    : perPage,
        select  : {
          id              : true,
          batchRef        : true,
          sequenceNum     : true,
          topupghOrderId  : true,
          status          : true,
          itemCount       : true,
          itemsAdded      : true,
          itemsSkipped    : true,
          totalAmount     : true,
          previousBalance : true,
          walletDeducted  : true,
          newBalance      : true,
          sentAt          : true,
          deliveryCheckedAt: true,
          createdAt       : true,
          // Count items by status
          items           : {
            select : { status: true, topupghDeliveryStatus: true }
          }
        }
      }),
      prisma.topUpGHBatch.count({ where })
    ]);

    // Attach per-batch item status summary
    const batchesWithSummary = batches.map(b => {
      const delivered = b.items.filter(i => i.status === 'COMPLETED').length;
      const failed    = b.items.filter(i => i.status === 'FAILED').length;
      const pending   = b.items.filter(i => i.status !== 'COMPLETED' && i.status !== 'FAILED').length;
      const { items: _items, ...rest } = b;
      return { ...rest, deliveredCount: delivered, failedCount: failed, pendingCount: pending };
    });

    res.json({
      success    : true,
      batches    : batchesWithSummary,
      pagination : {
        total,
        per_page     : perPage,
        current_page : page,
        total_pages  : Math.ceil(total / perPage)
      }
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/topupgh/batches/:batchRef
 * Full detail of a single batch including all item delivery statuses.
 * Accepts both batchRef ("BATCH-000001") and internal id.
 */
router.get('/batches/:batchRef', authenticate, authorize('ADMIN'), async (req, res, next) => {
  try {
    const ref = req.params.batchRef;

    const batch = await prisma.topUpGHBatch.findFirst({
      where : {
        OR : [
          { batchRef : ref },
          { id       : ref }
        ]
      },
      include : {
        items : {
          include : {
            bundle     : { select: { name: true, network: true, dataAmount: true } },
            orderGroup : {
              select : {
                displayId : true,
                userId    : true,
                user      : { select: { name: true, email: true, agentCode: true } }
              }
            }
          },
          orderBy : { itemIndex: 'asc' }
        }
      }
    });

    if (!batch) {
      return res.status(404).json({ success: false, message: 'Batch not found' });
    }

    // Format items for the admin page
    const formattedItems = batch.items.map(item => ({
      id                    : item.id,
      reference             : item.reference,
      itemIndex             : item.itemIndex,
      recipientPhone        : item.recipientPhone,
      network               : item.bundle?.network   || 'MTN',
      bundleName            : item.bundle?.name      || '-',
      dataAmount            : item.bundle?.dataAmount || '-',
      unitPrice             : item.unitPrice,
      status                : item.status,
      topupghItemId         : item.topupghItemId,
      topupghDeliveryStatus : item.topupghDeliveryStatus,
      topupghDeliveryDate   : item.topupghDeliveryDate,
      processedAt           : item.processedAt,
      failureReason         : item.failureReason,
      orderRef              : item.orderGroup?.displayId,
      customerName          : item.orderGroup?.user?.name,
      customerEmail         : item.orderGroup?.user?.email,
      agentCode             : item.orderGroup?.user?.agentCode
    }));

    const { items: _items, ...batchData } = batch;

    res.json({
      success : true,
      batch   : {
        ...batchData,
        items : formattedItems
      }
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/topupgh/batches/:batchRef/sync
 * Admin manually triggers delivery status refresh for a batch.
 */
router.post('/batches/:batchRef/sync', authenticate, authorize('ADMIN'), async (req, res, next) => {
  try {
    const ref = req.params.batchRef;

    const batch = await prisma.topUpGHBatch.findFirst({
      where : { OR: [{ batchRef: ref }, { id: ref }] },
      select : { id: true, batchRef: true, status: true, topupghOrderId: true }
    });

    if (!batch) {
      return res.status(404).json({ success: false, message: 'Batch not found' });
    }

    if (!batch.topupghOrderId) {
      return res.status(400).json({ success: false, message: 'Batch has no TopUpGH order ID yet' });
    }

    await batchSvc.syncBatchDelivery(batch.id);

    // Return updated batch
    const updated = await prisma.topUpGHBatch.findUnique({
      where  : { id: batch.id },
      select : {
        status : true,
        deliveryCheckedAt : true,
        items  : { select: { status: true } }
      }
    });

    res.json({
      success           : true,
      message           : `Sync complete for batch ${batch.batchRef}`,
      status            : updated.status,
      deliveryCheckedAt : updated.deliveryCheckedAt,
      itemStatuses      : updated.items.reduce((acc, i) => {
        acc[i.status] = (acc[i.status] || 0) + 1;
        return acc;
      }, {})
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/topupgh/phone-status
 * Look up Etopup delivery status for one or more phone numbers.
 * Auto-syncs the relevant batches with Etopup before returning results.
 * Query: phones=0241234567&phones=0551234567  (repeatable)
 */
router.get('/phone-status', authenticate, authorize('ADMIN'), async (req, res, next) => {
  try {
    let phones = req.query.phones;
    if (!phones) return res.status(400).json({ success: false, message: 'phones query param required' });
    if (!Array.isArray(phones)) phones = [phones];
    phones = phones.map(p => p.trim()).filter(Boolean);
    if (!phones.length) return res.status(400).json({ success: false, message: 'No valid phone numbers provided' });

    // Find which batches these phones belong to
    const itemsForSync = await prisma.orderItem.findMany({
      where: {
        topupghBatchId: { not: null },
        recipientPhone: { in: phones }
      },
      select: {
        topupghBatch: { select: { id: true, batchRef: true, status: true, topupghOrderId: true } }
      }
    });

    // Sync each unique non-terminal batch with Etopup (live API call from Render)
    const batchesSynced = [];
    const seenBatchIds = new Set();
    for (const item of itemsForSync) {
      const b = item.topupghBatch;
      if (!b || seenBatchIds.has(b.id)) continue;
      seenBatchIds.add(b.id);
      if (b.status !== 'DELIVERED' && b.status !== 'FAILED' && b.topupghOrderId) {
        try {
          await batchSvc.syncBatchDelivery(b.id);
          batchesSynced.push(b.batchRef);
        } catch (syncErr) {
          console.warn(`[phone-status] Sync failed for batch ${b.batchRef}:`, syncErr.message);
        }
      }
    }

    if (batchesSynced.length) {
      console.log(`[phone-status] Auto-synced batches: ${batchesSynced.join(', ')}`);
    }

    // Now return fresh data from DB
    const items = await prisma.orderItem.findMany({
      where: {
        topupghBatchId: { not: null },
        recipientPhone: { in: phones }
      },
      include: {
        topupghBatch: { select: { batchRef: true, sentAt: true } },
        bundle: { select: { name: true, dataAmount: true } },
        orderGroup: { select: { displayId: true } }
      },
      orderBy: { topupghQueuedAt: 'desc' }
    });

    const formatted = items.map(item => ({
      recipientPhone        : item.recipientPhone,
      bundleName            : item.bundle?.name      || null,
      dataAmount            : item.bundle?.dataAmount || null,
      batchRef              : item.topupghBatch?.batchRef || null,
      sentAt                : item.topupghBatch?.sentAt   || null,
      topupghDeliveryStatus : item.topupghDeliveryStatus,
      topupghDeliveryDate   : item.topupghDeliveryDate,
      orderRef              : item.orderGroup?.displayId  || null
    }));

    res.json({ success: true, items: formatted, count: formatted.length, synced: batchesSynced });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/topupgh/order-status/:orderId
 * Query Etopup directly for the current status of a specific order.
 */
router.get('/order-status/:orderId', authenticate, authorize('ADMIN'), async (req, res, next) => {
  try {
    const orderId = parseInt(req.params.orderId);
    if (!orderId || isNaN(orderId)) {
      return res.status(400).json({ success: false, message: 'Invalid order ID' });
    }
    const result = await topupghSvc.getOrderStatus(orderId);
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/topupgh/batches/:batchRef/requeue
 * Admin manually re-queues items from a FAILED batch back into the dispatch queue.
 * Items are reset to PROCESSING with topupghBatchId cleared so the scheduler
 * picks them up on the next tick.
 */
router.post('/batches/:batchRef/requeue', authenticate, authorize('ADMIN'), async (req, res, next) => {
  try {
    const ref = req.params.batchRef;

    const batch = await prisma.topUpGHBatch.findFirst({
      where  : { OR: [{ batchRef: ref }, { id: ref }] },
      include: { items: { select: { id: true, status: true } } }
    });

    if (!batch) {
      return res.status(404).json({ success: false, message: 'Batch not found' });
    }

    if (batch.status !== 'FAILED') {
      return res.status(400).json({ success: false, message: `Batch is ${batch.status} — only FAILED batches can be re-queued` });
    }

    const itemIds = batch.items.map(i => i.id);
    if (!itemIds.length) {
      return res.status(400).json({ success: false, message: 'Batch has no items' });
    }

    // Reset items: unlink from failed batch, back to PROCESSING in the queue
    await prisma.orderItem.updateMany({
      where : { id: { in: itemIds } },
      data  : {
        topupghBatchId : null,
        status         : 'PROCESSING',
        failureReason  : null
      }
    });

    // Mark batch as SUBMITTED_RETRY so it stays visible but is clearly superseded
    await prisma.topUpGHBatch.update({
      where : { id: batch.id },
      data  : { status: 'FAILED' } // stays FAILED — items are just re-queued
    });

    console.log(`[TopUpGH Requeue] ${itemIds.length} items from batch ${ref} returned to dispatch queue by admin`);

    res.json({
      success   : true,
      message   : `${itemIds.length} item(s) re-queued for dispatch`,
      itemCount : itemIds.length
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
