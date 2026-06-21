/**
 * Data Gatekeeper API Routes
 *
 * Admin-only endpoints to test connection, check balance, and query order status.
 */

const express = require('express');
const router = express.Router();
const { authenticate, authorize } = require('../middleware/auth');
const dataGatekeeperService = require('../services/datagatekeeper.service');

/**
 * GET /api/datagatekeeper/balance
 * Get wallet balance
 */
router.get('/balance', authenticate, authorize('ADMIN'), async (req, res) => {
  try {
    const result = await dataGatekeeperService.getWalletBalance();
    res.json({
      success: result.success,
      balance: result.balance,
      currency: result.currency || 'GHS',
      error: result.error || undefined
    });
  } catch (error) {
    console.error('[DataGatekeeper] Balance route error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/datagatekeeper/test
 * Test connection and credentials
 */
router.get('/test', authenticate, authorize('ADMIN'), async (req, res) => {
  try {
    const result = await dataGatekeeperService.testConnection();
    if (result.success) {
      res.json({ success: true, message: result.message });
    } else {
      res.status(400).json({ success: false, message: result.message });
    }
  } catch (error) {
    console.error('[DataGatekeeper] Test route error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/datagatekeeper/order-status/:reference
 * Check order status by reference (DGK-{id})
 */
router.get('/order-status/:reference', authenticate, authorize('ADMIN'), async (req, res) => {
  try {
    const result = await dataGatekeeperService.checkOrderStatus(req.params.reference);
    res.json(result);
  } catch (error) {
    console.error('[DataGatekeeper] Order status route error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/datagatekeeper/diagnose
 * Live diagnostics — shows exactly why orders are or aren't going to DataGatekeeper.
 * Runs the real provider-selection logic and returns a plain-English report.
 */
router.get('/diagnose', authenticate, authorize('ADMIN'), async (req, res) => {
  try {
    const settingsController = require('../controllers/settings.controller');
    const prisma = require('../lib/prisma');
    const siteSettings = settingsController.getSiteSettings();

    const isTruthy = (val) => val === true || val === 'true' || val === 1;

    const apiKeySet      = dataGatekeeperService.isConfigured();
    const dgkEnabled     = isTruthy(siteSettings.datagatekeeperAPI);
    const dgkMtnEnabled  = siteSettings.datagatekeeper_mtnAPI !== false;
    const ckgEnabled     = isTruthy(siteSettings.ckgodswayAPI);
    const ckgMtnEnabled  = siteSettings.ckgodsway_mtnAPI !== false;
    const mcbisEnabled   = isTruthy(siteSettings.mcbisAPI);
    const mcbisMtnEnabled = siteSettings.mcbis_mtnAPI !== false;

    // Determine which provider would actually be selected for MTN right now
    let mtnProvider = null;
    const providerChecks = [];

    if (dgkEnabled) {
      if (!apiKeySet) {
        providerChecks.push({ provider: 'DATAGATEKEEPER', selected: false, reason: 'SKIPPED — DATAGATEKEEPER_API_KEY not set on server' });
      } else if (!dgkMtnEnabled) {
        providerChecks.push({ provider: 'DATAGATEKEEPER', selected: false, reason: 'SKIPPED — MTN toggle is OFF' });
      } else {
        providerChecks.push({ provider: 'DATAGATEKEEPER', selected: true, reason: 'SELECTED ✓' });
        mtnProvider = 'DATAGATEKEEPER';
      }
    } else {
      providerChecks.push({ provider: 'DATAGATEKEEPER', selected: false, reason: 'SKIPPED — DataGatekeeper API toggle is OFF' });
    }

    if (!mtnProvider) {
      if (ckgEnabled && ckgMtnEnabled) {
        providerChecks.push({ provider: 'CKGODSWAY', selected: true, reason: 'SELECTED (fallback) ✓' });
        mtnProvider = 'CKGODSWAY';
      } else if (mcbisEnabled && mcbisMtnEnabled) {
        providerChecks.push({ provider: 'MCBIS', selected: true, reason: 'SELECTED (fallback) ✓' });
        mtnProvider = 'MCBIS';
      } else {
        providerChecks.push({ provider: 'NONE', selected: false, reason: 'NO PROVIDER — MTN orders will stay PENDING' });
      }
    }

    // Count stuck pending orders
    const pendingCount = await prisma.orderItem.count({
      where: { status: 'PENDING', externalReference: null, apiSentAt: null }
    });
    const processingDGK = await prisma.orderItem.count({
      where: { status: 'PROCESSING', externalReference: { startsWith: 'DGK-' } }
    });
    const failedDGK = await prisma.orderItem.count({
      where: { status: 'FAILED', failureReason: { contains: 'Gatekeeper' } }
    });

    // Also check for orders stuck with apiSentAt set (claimed but never released)
    const stuck = await prisma.orderItem.count({
      where: {
        status: 'PENDING',
        apiSentAt: { not: null },
        externalReference: null
      }
    });

    const report = {
      apiKeyConfigured: apiKeySet,
      settings: {
        datagatekeeperAPI: siteSettings.datagatekeeperAPI,
        datagatekeeper_mtnAPI: siteSettings.datagatekeeper_mtnAPI,
        ckgodswayAPI: siteSettings.ckgodswayAPI,
        mcbisAPI: siteSettings.mcbisAPI
      },
      mtnRouting: providerChecks,
      mtnProvider,
      orders: {
        pendingUnprocessed: pendingCount,
        stuckClaimed: stuck,
        processingAtDGK: processingDGK,
        failedDGKRelated: failedDGK
      },
      verdict: mtnProvider === 'DATAGATEKEEPER'
        ? '✅ DataGatekeeper IS selected for MTN. If orders are still pending, check DGK balance and API connectivity.'
        : `❌ DataGatekeeper is NOT selected for MTN. Currently routing to: ${mtnProvider || 'NOBODY'}. Fix the issue above.`
    };

    console.log('[DataGatekeeper] Diagnose:', JSON.stringify(report, null, 2));
    res.json(report);
  } catch (error) {
    console.error('[DataGatekeeper] Diagnose error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/datagatekeeper/dispatch-pending
 * Force-dispatch all PENDING MTN orders to DataGatekeeper right now.
 * Bypasses the 15-second age filter.
 */
router.post('/dispatch-pending', authenticate, authorize('ADMIN'), async (req, res) => {
  try {
    const prisma = require('../lib/prisma');
    const orderGroupService = require('../services/order-group.service');

    // Find all pending order groups with unprocessed items
    const stuckGroups = await prisma.orderGroup.findMany({
      where: {
        status: 'PENDING',
        items: { some: { status: 'PENDING', externalReference: null, apiSentAt: null } }
      },
      select: { id: true, displayId: true },
      take: 50
    });

    if (stuckGroups.length === 0) {
      return res.json({ success: true, message: 'No pending orders found to dispatch', dispatched: 0 });
    }

    console.log(`[DataGatekeeper] Force-dispatching ${stuckGroups.length} order groups`);
    let dispatched = 0;
    const results = [];

    for (const group of stuckGroups) {
      try {
        const result = await orderGroupService.processOrderItems(group.id);
        dispatched += result.processed || 0;
        results.push({ groupId: group.displayId, processed: result.processed, skipped: result.skipped });
      } catch (err) {
        results.push({ groupId: group.displayId, error: err.message });
      }
    }

    res.json({ success: true, dispatched, groupsProcessed: stuckGroups.length, results });
  } catch (error) {
    console.error('[DataGatekeeper] Dispatch pending error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
