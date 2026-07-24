const express = require('express');
const router = express.Router();
const { authenticate, authorize } = require('../middleware/auth');
const instantDataGHService = require('../services/instantdatagh.service');

router.get('/balance', authenticate, authorize('ADMIN'), async (req, res) => {
  try {
    const result = await instantDataGHService.getWalletBalance();
    res.json({ success: true, balance: result.balance, currency: result.currency || 'GHS' });
  } catch (error) {
    console.error('[InstantDataGH] Balance error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/test', authenticate, authorize('ADMIN'), async (req, res) => {
  try {
    const result = await instantDataGHService.testConnection();
    if (result.success) {
      const balanceResult = await instantDataGHService.getWalletBalance();
      res.json({ success: true, message: result.message, balance: balanceResult.balance || 0 });
    } else {
      res.status(400).json({ success: false, error: result.message || 'Connection test failed' });
    }
  } catch (error) {
    console.error('[InstantDataGH] Test connection error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/order-status/:reference', authenticate, authorize('ADMIN'), async (req, res) => {
  try {
    const result = await instantDataGHService.checkOrderStatus(req.params.reference);
    res.json(result);
  } catch (error) {
    console.error('[InstantDataGH] Order status error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
