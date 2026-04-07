/**
 * CK-Godsway API Routes
 * 
 * Endpoints for admin to interact with CK-Godsway API
 */

const express = require('express');
const router = express.Router();
const { authenticate, authorize } = require('../middleware/auth');
const ckgodswayService = require('../services/ckgodsway.service');

/**
 * GET /api/ckgodsway/balance
 * Get CK-Godsway wallet balance
 */
router.get('/balance', authenticate, authorize('ADMIN'), async (req, res) => {
  try {
    const result = await ckgodswayService.getWalletBalance();
    res.json({
      success: true,
      balance: result.balance,
      currency: result.currency,
      note: result.note || ''
    });
  } catch (error) {
    console.error('[CKGodsway] Balance error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/ckgodsway/test
 * Test CK-Godsway API connection
 */
router.post('/test', authenticate, authorize('ADMIN'), async (req, res) => {
  try {
    const result = await ckgodswayService.testConnection();

    if (result.success) {
      const balanceResult = await ckgodswayService.getWalletBalance();
      res.json({
        success: true,
        message: result.message,
        balance: balanceResult.balance || 0,
        note: balanceResult.note || ''
      });
    } else {
      res.status(400).json({
        success: false,
        error: result.message || 'Connection test failed'
      });
    }
  } catch (error) {
    console.error('[CKGodsway] Test connection error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/ckgodsway/order-status/:reference
 * Check order status
 */
router.get('/order-status/:reference', authenticate, authorize('ADMIN'), async (req, res) => {
  try {
    const { reference } = req.params;
    const result = await ckgodswayService.checkOrderStatus(reference);
    res.json(result);
  } catch (error) {
    console.error('[CKGodsway] Order status error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;
