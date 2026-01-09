/**
 * DATAHUB API ROUTES
 * ==================
 * Admin endpoints for managing McbisSolution API integration.
 */

const express = require('express');
const router = express.Router();
const { authenticate, authorize } = require('../middleware/auth');
const datahubService = require('../services/datahub.service');

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
 */
router.post('/process/:orderId', authenticate, authorize('ADMIN'), async (req, res, next) => {
  try {
    const { orderId } = req.params;
    const result = await datahubService.processOrder(orderId);
    res.json(result);
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
 * POST /api/datahub/sync-all
 * Sync all pending orders (Admin only)
 */
router.post('/sync-all', authenticate, authorize('ADMIN'), async (req, res, next) => {
  try {
    const result = await datahubService.syncAllPendingOrders();
    res.json(result);
  } catch (error) {
    next(error);
  }
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
