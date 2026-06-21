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

module.exports = router;
