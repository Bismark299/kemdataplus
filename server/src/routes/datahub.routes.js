/**
 * DATAHUB API ROUTES
 * ==================
 * Admin endpoints for managing McbisSolution API integration.
 */

const express = require('express');
const router = express.Router();
const { authenticate, authorize } = require('../middleware/auth');
const datahubService = require('../services/datahub.service');
const orderGroupService = require('../services/order-group.service');

/**
 * GET /api/datahub/balance
 * Get API wallet balance (Admin only)
 */
router.get('/balance', authenticate, authorize('ADMIN'), async (req, res, next) => {
  try {
    const result = await datahubService.getWalletBalance();
    res.json(result);
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/datahub/products
 * Get all available products from API (Admin only)
 */
router.get('/products', authenticate, authorize('ADMIN'), async (req, res, next) => {
  try {
    const result = await datahubService.getProducts();
    res.json(result);
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/datahub/status/:reference
 * Check order status by reference (Admin only)
 */
router.get('/status/:reference', authenticate, authorize('ADMIN'), async (req, res, next) => {
  try {
    const { reference } = req.params;
    const result = await datahubService.checkOrderStatus(reference);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/datahub/process/:orderId
 * Process a specific order through API (Admin only)
 * Uses per-network routing to select the correct provider
 */
router.post('/process/:orderId', authenticate, authorize('ADMIN'), async (req, res, next) => {
  try {
    const { orderId } = req.params;
    const settingsController = require('../controllers/settings.controller');
    const ckgodswayService = require('../services/ckgodsway.service');
    const prisma = require('../lib/prisma');
    
    // Fetch order with bundle to get network
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: { bundle: true }
    });
    if (!order) return res.status(404).json({ success: false, error: 'Order not found' });
    if (order.externalReference) return res.status(400).json({ success: false, error: 'Order already sent to API' });
    if (order.status === 'COMPLETED') return res.status(400).json({ success: false, error: 'Order already completed' });
    
    const network = order.bundle?.network || 'MTN';
    const siteSettings = settingsController.getSiteSettings();
    const isTruthy = (val) => val === true || val === 'true' || val === 1;
    const getNetworkToggleKey = (prefix, net) => {
      const n = (net || '').toLowerCase().replace(/\s+/g, '');
      if (n === 'mtn') return `${prefix}_mtnAPI`;
      if (n === 'telecel' || n === 'vodafone') return `${prefix}_telecelAPI`;
      if (n === 'airteltigo' || n === 'at') return `${prefix}_airteltigoAPI`;
      if (n === 'at-bigtime' || n === 'atbigtime' || n === 'at-big time' || n.includes('big time') || n.includes('bigtime')) return `${prefix}_bigtimeAPI`;
      return null;
    };
    const PROVIDERS = [
      { key: 'ckgodswayAPI', name: 'CKGODSWAY', prefix: 'ckgodsway', service: ckgodswayService },
      { key: 'mcbisAPI', name: 'MCBIS', prefix: 'mcbis', service: datahubService }
    ];
    
    let provider = null;
    for (const p of PROVIDERS) {
      if (!isTruthy(siteSettings[p.key])) continue;
      const toggleKey = getNetworkToggleKey(p.prefix, network);
      if (toggleKey && siteSettings[toggleKey] === false) continue;
      provider = p;
      break;
    }
    
    if (!provider) return res.status(400).json({ success: false, error: `No API provider enabled for ${network}` });
    
    let dataAmount = 1;
    if (order.bundle?.dataAmount) {
      const match = order.bundle.dataAmount.match(/(\d+)/);
      if (match) dataAmount = parseInt(match[1]);
    }
    
    // Atomic lock
    const claim = await prisma.order.updateMany({
      where: { id: orderId, apiSentAt: null, externalReference: null },
      data: { apiSentAt: new Date() }
    });
    if (claim.count === 0) return res.status(400).json({ success: false, error: 'Order already being processed' });
    
    const result = await provider.service.placeOrder({
      network, phone: order.recipientPhone, amount: dataAmount, orderId
    });
    
    await prisma.order.update({
      where: { id: orderId },
      data: { status: result.success ? 'PROCESSING' : 'PENDING', externalReference: result.reference || null }
    });
    if (!result.success) {
      await prisma.order.update({ where: { id: orderId }, data: { apiSentAt: null } });
    }
    
    res.json({ ...result, provider: provider.name });
  } catch (error) {
    if (error.message.includes('not found') || error.message.includes('already')) {
      return res.status(400).json({ success: false, error: error.message });
    }
    next(error);
  }
});

/**
 * POST /api/datahub/sync/:orderId
 * Sync a specific order's status from API (Admin only)
 * Works with LEGACY Order table
 */
router.post('/sync/:orderId', authenticate, authorize('ADMIN'), async (req, res, next) => {
  try {
    const { orderId } = req.params;
    const result = await datahubService.syncOrderStatus(orderId);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/datahub/sync-item/:itemId
 * Sync a specific OrderItem's status from external API (Admin only)
 * Works with NEW OrderItem table
 */
router.post('/sync-item/:itemId', authenticate, authorize('ADMIN'), async (req, res, next) => {
  try {
    const { itemId } = req.params;
    const result = await orderGroupService.syncOrderItemStatus(itemId);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/datahub/sync-all
 * Sync all pending orders (Admin only)
 * Now syncs BOTH legacy Order table AND new OrderItem table
 */
const syncState = require('../lib/sync-state');

router.post('/sync-all', authenticate, authorize('ADMIN'), async (req, res) => {
  if (syncState.syncAllRunning) {
    return res.json({ success: true, running: true, message: 'Sync already in progress — check back in a moment.' });
  }

  // Respond immediately so the browser never times out
  res.json({ success: true, background: true, message: 'Sync started.' });

  syncState.syncAllRunning = true;
  syncState.lastSyncResult = null;

  setImmediate(async () => {
    try {
      const settingsController = require('../controllers/settings.controller');
      const siteSettings = settingsController.getSiteSettings();
      const ckgodswayEnabled = !!(siteSettings.ckgodswayAutoSync && siteSettings.ckgodswayAPI);

      console.log('[SyncAll] Admin-triggered full catch-up sync started');

      const legacyResult = await datahubService.syncAllPendingOrders({ catchUp: true });
      const itemResult   = await orderGroupService.syncAllProcessingItems({ mcbisEnabled: true, ckgodswayEnabled, catchUp: true });
      const retryResult  = await orderGroupService.retryStuckPendingOrders();

      syncState.lastSyncResult = {
        completedAt: new Date().toISOString(),
        checked:    (legacyResult.synced || 0) + (itemResult.total || 0),
        completed:  (legacyResult.results || []).filter(r => r.newStatus === 'COMPLETED').length + (itemResult.completed || 0),
        cancelled:  (legacyResult.results || []).filter(r => r.newStatus === 'CANCELLED').length + (itemResult.results || []).filter(r => r.newStatus === 'CANCELLED').length,
        failed:     (legacyResult.results || []).filter(r => r.newStatus === 'FAILED').length    + (itemResult.failed || 0),
        unchanged:  itemResult.unchanged || 0,
        retried:    retryResult?.retried || 0
      };

      console.log(`[SyncAll] Done — checked: ${syncState.lastSyncResult.checked}, completed: ${syncState.lastSyncResult.completed}, cancelled: ${syncState.lastSyncResult.cancelled}, failed: ${syncState.lastSyncResult.failed}, unchanged: ${syncState.lastSyncResult.unchanged}`);
    } catch (err) {
      console.error('[SyncAll] Error during catch-up sync:', err.message);
      syncState.lastSyncResult = { error: err.message, completedAt: new Date().toISOString() };
    } finally {
      syncState.syncAllRunning = false;
    }
  });
});

/**
 * GET /api/datahub/sync-status
 * Returns whether a sync-all is running and the result of the last one.
 */
router.get('/sync-status', authenticate, authorize('ADMIN'), (req, res) => {
  res.json({
    running: syncState.syncAllRunning,
    lastResult: syncState.lastSyncResult
  });
});

/**
 * POST /api/datahub/test
 * Test API connection with detailed debugging (Admin only)
 */
router.post('/test', authenticate, authorize('ADMIN'), async (req, res, next) => {
  try {
    // Use the detailed test connection method
    const testResult = await datahubService.testConnection();
    
    if (testResult.success) {
      res.json({
        success: true,
        connection: 'OK',
        balance: testResult.balance,
        message: `Connected! Balance: GHS ${testResult.balance}`
      });
    } else {
      res.json({
        success: false,
        connection: 'FAILED',
        error: testResult.error,
        hint: testResult.hint,
        responsePreview: testResult.responsePreview
      });
    }
  } catch (error) {
    res.json({
      success: false,
      connection: 'FAILED',
      error: error.message
    });
  }
});

module.exports = router;
