/**
 * EasyDataGH API Routes
 * 
 * Endpoints for admin to interact with EasyDataGH API
 */

const express = require('express');
const router = express.Router();
const { authenticate, authorize } = require('../middleware/auth');
const easyDataService = require('../services/easydata.service');

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

module.exports = router;
