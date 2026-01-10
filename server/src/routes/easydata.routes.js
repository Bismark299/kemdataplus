/**
 * EasyDataGH API Routes
 * 
 * Endpoints for admin to interact with EasyDataGH API
 */

const express = require('express');
const router = express.Router();
const { authenticate, authorize } = require('../middleware/auth');
const easyDataService = require('../services/easydata.service');
const orderGroupService = require('../services/order-group.service');

/**
 * GET /api/easydata/balance
 * Get EasyDataGH wallet balance
 */
router.get('/balance', authenticate, authorize('ADMIN'), async (req, res) => {
  try {
    const result = await easyDataService.getWalletBalance();
    
    if (result.success) {
      res.json({
        success: true,
        balance: result.balance,
        currency: result.currency
      });
    } else {
      res.status(400).json({
        success: false,
        error: result.error || 'Failed to get balance'
      });
    }
  } catch (error) {
    console.error('[EasyData] Balance error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/easydata/test
 * Test EasyDataGH API connection
 */
router.post('/test', authenticate, authorize('ADMIN'), async (req, res) => {
  try {
    const result = await easyDataService.testConnection();
    
    if (result.success) {
      // Also get balance to show
      const balanceResult = await easyDataService.getWalletBalance();
      
      res.json({
        success: true,
        message: result.message,
        balance: balanceResult.balance || 0
      });
    } else {
      res.status(400).json({
        success: false,
        error: result.message || 'Connection test failed'
      });
    }
  } catch (error) {
    console.error('[EasyData] Test connection error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/easydata/order-status/:reference
 * Check order status
 */
router.get('/order-status/:reference', authenticate, authorize('ADMIN'), async (req, res) => {
  try {
    const { reference } = req.params;
    const result = await easyDataService.checkOrderStatus(reference);
    
    res.json(result);
  } catch (error) {
    console.error('[EasyData] Order status error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/easydata/sync-all
 * Sync all processing/pending OrderItems from external APIs
 */
router.post('/sync-all', authenticate, authorize('ADMIN'), async (req, res) => {
  try {
    const result = await orderGroupService.syncAllProcessingItems();
    
    res.json({
      success: true,
      total: result.total,
      completed: result.completed,
      failed: result.failed,
      unchanged: result.unchanged,
      message: `Synced ${result.total} orders: ${result.completed} completed, ${result.failed} failed, ${result.unchanged} unchanged`
    });
  } catch (error) {
    console.error('[EasyData] Sync all error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/easydata/sync-item/:itemId
 * Sync a specific OrderItem status
 */
router.post('/sync-item/:itemId', authenticate, authorize('ADMIN'), async (req, res) => {
  try {
    const { itemId } = req.params;
    const result = await orderGroupService.syncOrderItemStatus(itemId);
    
    res.json(result);
  } catch (error) {
    console.error('[EasyData] Sync item error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;
