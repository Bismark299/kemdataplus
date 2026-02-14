/**
 * PROFIT PAYOUT ROUTES (SIMPLIFIED)
 * ==================================
 * 
 * User endpoints:
 * - GET  /my/stats - Get earnings stats
 * - GET  /my/pending - Get uncredited profits
 * - GET  /my/history - Get profit history
 * - POST /withdraw - Request withdrawal (provide MoMo details)
 * - GET  /my/withdrawals - Get withdrawal history
 * - POST /my/withdrawals/:id/cancel - Cancel pending withdrawal
 * 
 * Admin endpoints:
 * - GET  /admin/stats - Overview stats
 * - GET  /admin/withdrawals - All withdrawal requests
 * - GET  /admin/withdrawals/pending - Pending requests only
 * - POST /admin/bulk-approve - Bulk approve all pending (Friday)
 * - POST /admin/withdrawals/:id/approve - Approve single
 * - POST /admin/withdrawals/:id/reject - Reject single
 */

const express = require('express');
const router = express.Router();
const { authenticate, authorize } = require('../middleware/auth');
const profitPayoutService = require('../services/profit-payout.service');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// ============================================================
// USER ROUTES
// ============================================================

/**
 * GET /api/profit-payouts/settings
 */
router.get('/settings', (req, res) => {
  const settings = profitPayoutService.getSettings();
  res.json(settings);
});

/**
 * POST /api/profit-payouts/resolve-account
 * Verify MoMo account before withdrawal
 */
router.post('/resolve-account', authenticate, async (req, res) => {
  try {
    const { accountNumber, bankCode } = req.body;
    
    if (!accountNumber || !bankCode) {
      return res.status(400).json({ success: false, message: 'Account number and bank code are required' });
    }
    
    const result = await profitPayoutService.resolveAccount(accountNumber, bankCode);
    res.json(result);
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

/**
 * GET /api/profit-payouts/my/stats
 */
router.get('/my/stats', authenticate, async (req, res) => {
  try {
    const stats = await profitPayoutService.getUserProfitStats(req.user.id);
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/profit-payouts/my/pending
 */
router.get('/my/pending', authenticate, async (req, res) => {
  try {
    const result = await profitPayoutService.getUserPendingProfits(req.user.id);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/profit-payouts/my/history
 */
router.get('/my/history', authenticate, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const result = await profitPayoutService.getUserProfitHistory(req.user.id, { page, limit });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/profit-payouts/momo-details
 * Get user's saved MoMo details
 */
router.get('/momo-details', authenticate, async (req, res) => {
  try {
    console.log('[MoMo] Fetching momo details for user:', req.user.id);
    
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { momoName: true, momoNumber: true, momoNetwork: true }
    });
    
    console.log('[MoMo] User data:', user);
    
    res.json({
      hasSavedDetails: !!(user?.momoName && user?.momoNumber && user?.momoNetwork),
      momoName: user?.momoName || '',
      momoNumber: user?.momoNumber || '',
      momoNetwork: user?.momoNetwork || ''
    });
  } catch (err) {
    console.error('[MoMo] Error fetching momo details:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/profit-payouts/momo-details
 * Save/update user's MoMo details
 */
router.post('/momo-details', authenticate, async (req, res) => {
  try {
    const { momoName, momoNumber, momoNetwork } = req.body;
    
    if (!momoName || !momoNumber || !momoNetwork) {
      return res.status(400).json({ error: 'All MoMo details are required' });
    }
    
    const validNetworks = ['MTN', 'VOD', 'ATL'];
    if (!validNetworks.includes(momoNetwork.toUpperCase())) {
      return res.status(400).json({ error: 'Invalid network. Use MTN, VOD, or ATL' });
    }
    
    await prisma.user.update({
      where: { id: req.user.id },
      data: {
        momoName: momoName.trim(),
        momoNumber: momoNumber.trim(),
        momoNetwork: momoNetwork.toUpperCase()
      }
    });
    
    res.json({ success: true, message: 'MoMo details saved successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/profit-payouts/withdraw
 * Request withdrawal - uses saved MoMo details or provided ones
 */
router.post('/withdraw', authenticate, async (req, res) => {
  try {
    let { amount, accountName, accountNumber, network } = req.body;
    
    console.log('[Withdraw] Request body:', { amount, accountName, accountNumber, network, userId: req.user?.id });
    
    if (!amount) {
      return res.status(400).json({ error: 'Amount is required' });
    }
    
    // If MoMo details not provided, fetch saved details
    if (!accountName || !accountNumber || !network) {
      const user = await prisma.user.findUnique({
        where: { id: req.user.id },
        select: { momoName: true, momoNumber: true, momoNetwork: true }
      });
      
      if (!user?.momoName || !user?.momoNumber || !user?.momoNetwork) {
        return res.status(400).json({ 
          error: 'No saved MoMo details. Please provide account name, account number, and network.',
          needsMomoDetails: true
        });
      }
      
      accountName = user.momoName;
      accountNumber = user.momoNumber;
      network = user.momoNetwork;
      console.log('[Withdraw] Using saved MoMo details:', { accountName, accountNumber, network });
    }
    
    const result = await profitPayoutService.requestWithdrawal({
      userId: req.user.id,
      amount: parseFloat(amount),
      accountName,
      accountNumber,
      network,
      saveMomoDetails: true // Tell service to save details
    });
    
    console.log('[Withdraw] Success:', result);
    res.json(result);
  } catch (err) {
    console.log('[Withdraw] Error:', err.message);
    res.status(400).json({ error: err.message });
  }
});

/**
 * GET /api/profit-payouts/my/withdrawals
 */
router.get('/my/withdrawals', authenticate, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const result = await profitPayoutService.getUserWithdrawals(req.user.id, { page, limit });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/profit-payouts/my/withdrawals/:id/cancel
 */
router.post('/my/withdrawals/:id/cancel', authenticate, async (req, res) => {
  try {
    const result = await profitPayoutService.cancelWithdrawal(req.user.id, req.params.id);
    res.json({ success: true, message: 'Withdrawal cancelled' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ============================================================
// ADMIN ROUTES
// ============================================================

/**
 * GET /api/profit-payouts/admin/stats
 */
router.get('/admin/stats', authenticate, authorize('ADMIN'), async (req, res) => {
  try {
    const stats = await profitPayoutService.getAdminStats();
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/profit-payouts/admin/withdrawal-stats
 * Get withdrawal stats grouped by status
 */
router.get('/admin/withdrawal-stats', authenticate, authorize('ADMIN'), async (req, res) => {
  try {
    const stats = await profitPayoutService.getWithdrawalStats();
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/profit-payouts/admin/by-user
 * Get uncredited profits grouped by user
 */
router.get('/admin/by-user', authenticate, authorize('ADMIN'), async (req, res) => {
  try {
    const result = await profitPayoutService.getProfitsByUser();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/profit-payouts/admin/withdrawals
 * Supports filters: status, startDate, endDate
 */
router.get('/admin/withdrawals', authenticate, authorize('ADMIN'), async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const status = req.query.status || null;
    const startDate = req.query.startDate || null;
    const endDate = req.query.endDate || null;
    const result = await profitPayoutService.getAllWithdrawals({ page, limit, status, startDate, endDate });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/profit-payouts/admin/withdrawals/pending
 */
router.get('/admin/withdrawals/pending', authenticate, authorize('ADMIN'), async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const result = await profitPayoutService.getPendingWithdrawals({ page, limit });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/profit-payouts/admin/bulk-approve
 * BULK APPROVE all pending withdrawal requests - used on Fridays
 */
router.post('/admin/bulk-approve', authenticate, authorize('ADMIN'), async (req, res) => {
  try {
    const result = await profitPayoutService.bulkApproveWithdrawals(req.user.id);
    
    let message = `Bulk approval complete: ${result.processed} paid`;
    if (result.failed > 0) message += `, ${result.failed} failed`;
    message += ` | Total: GH₵${result.totalAmount?.toFixed(2) || 0}`;
    
    res.json({ success: true, message, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/profit-payouts/admin/process-withdrawal/:id
 * Process single withdrawal with optional OTP
 */
router.post('/admin/process-withdrawal/:id', authenticate, authorize('ADMIN'), async (req, res) => {
  try {
    const { otp } = req.body;
    const result = await profitPayoutService.approveSingleWithdrawal(req.params.id, req.user.id, otp);
    res.json({ success: true, message: 'Withdrawal processed successfully', ...result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * POST /api/profit-payouts/admin/process-batch
 * Process batch payout - credit all pending profits to users' wallets
 */
router.post('/admin/process-batch', authenticate, authorize('ADMIN'), async (req, res) => {
  try {
    const result = await profitPayoutService.processBatchPayout(req.user.id);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/profit-payouts/admin/withdrawals/:id/approve
 */
router.post('/admin/withdrawals/:id/approve', authenticate, authorize('ADMIN'), async (req, res) => {
  try {
    const result = await profitPayoutService.approveSingleWithdrawal(req.params.id, req.user.id);
    res.json({ success: true, message: 'Withdrawal approved and processed', ...result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * POST /api/profit-payouts/admin/withdrawals/:id/reject
 */
router.post('/admin/withdrawals/:id/reject', authenticate, authorize('ADMIN'), async (req, res) => {
  try {
    const { reason } = req.body;
    const result = await profitPayoutService.rejectWithdrawal(req.params.id, req.user.id, reason);
    res.json({ success: true, message: 'Withdrawal rejected' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * POST /api/profit-payouts/admin/withdrawals/:id/force-complete
 * Admin force complete a stuck PROCESSING request (e.g., webhook didn't arrive)
 */
router.post('/admin/withdrawals/:id/force-complete', authenticate, authorize('ADMIN'), async (req, res) => {
  try {
    const result = await profitPayoutService.forceCompleteWithdrawal(req.params.id, req.user.id);
    res.json({ success: true, message: 'Withdrawal marked as completed', ...result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * POST /api/profit-payouts/admin/withdrawals/:id/force-cancel
 * Admin force cancel a stuck PROCESSING request
 */
router.post('/admin/withdrawals/:id/force-cancel', authenticate, authorize('ADMIN'), async (req, res) => {
  try {
    const { reason } = req.body;
    const result = await profitPayoutService.forceCancelWithdrawal(req.params.id, req.user.id, reason || 'Admin cancelled - stuck in processing');
    res.json({ success: true, message: 'Withdrawal cancelled and earnings restored', ...result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * GET /api/profit-payouts/admin/batches
 */
router.get('/admin/batches', authenticate, authorize('ADMIN'), async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const result = await profitPayoutService.getBatchHistory({ page, limit });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
