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
const prisma = require('../lib/prisma');

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

/**
 * GET /api/profit-payouts/admin/agent-profits
 * Get all agents' profit summary with date filtering
 * Query params: startDate, endDate
 */
router.get('/admin/agent-profits', authenticate, authorize('ADMIN'), async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const result = await profitPayoutService.getAgentProfitsSummary({ startDate, endDate });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/profit-payouts/admin/agent-stats/:userId
 * Get an agent's profit stats (same view as agent sees)
 */
router.get('/admin/agent-stats/:userId', authenticate, authorize('ADMIN'), async (req, res) => {
  try {
    const stats = await profitPayoutService.getUserProfitStats(req.params.userId);
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/profit-payouts/admin/agent-adjustment
 * Create an admin profit adjustment (positive or negative) for an agent
 */
router.post('/admin/agent-adjustment', authenticate, authorize('ADMIN'), async (req, res) => {
  try {
    const { userId, amount, note } = req.body;
    if (!userId || amount === undefined || amount === null) {
      return res.status(400).json({ error: 'userId and amount are required' });
    }
    const numAmount = parseFloat(amount);
    if (isNaN(numAmount) || numAmount === 0) {
      return res.status(400).json({ error: 'amount must be a non-zero number' });
    }
    // Verify user exists
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
    if (!user) return res.status(404).json({ error: 'User not found' });

    const adjustment = await prisma.adminProfitAdjustment.create({
      data: {
        userId,
        amount: numAmount,
        note: note || null,
        createdBy: req.user.name || req.user.email || req.user.id
      }
    });

    res.json({ success: true, adjustment });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/profit-payouts/admin/agent-adjustments/:userId
 * Get all profit adjustments for a specific agent
 */
router.get('/admin/agent-adjustments/:userId', authenticate, authorize('ADMIN'), async (req, res) => {
  try {
    const adjustments = await prisma.adminProfitAdjustment.findMany({
      where: { userId: req.params.userId },
      orderBy: { createdAt: 'desc' }
    });
    res.json({ adjustments });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/profit-payouts/admin/agent-statement/:userId
 * Bank-statement style view of an agent's storefront profit and withdrawal history.
 * Each row is either a PROFIT (from completed storefront order) or WITHDRAWAL (agent payout).
 * Query params: startDate, endDate, page (default 1), limit (default 50)
 */
router.get('/admin/agent-statement/:userId', authenticate, authorize('ADMIN'), async (req, res) => {
  try {
    const { userId } = req.params;
    const page = Math.max(1, Math.min(parseInt(req.query.page) || 1, 10000));
    const limit = Math.max(1, Math.min(parseInt(req.query.limit) || 50, 200));
    const skip = (page - 1) * limit;

    // Validate user exists
    const agent = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, name: true, phone: true, email: true, role: true }
    });
    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    // Build date filter
    let dateFilter = {};
    if (req.query.startDate) {
      dateFilter.gte = new Date(req.query.startDate + 'T00:00:00.000Z');
    }
    if (req.query.endDate) {
      dateFilter.lte = new Date(req.query.endDate + 'T23:59:59.999Z');
    }
    const hasDateFilter = Object.keys(dateFilter).length > 0;

    // Get agent's storefronts
    const agentStorefronts = await prisma.storefront.findMany({
      where: { ownerId: userId },
      select: { id: true, name: true }
    });
    const storefrontIds = agentStorefronts.map(s => s.id);
    const storefrontMap = Object.fromEntries(agentStorefronts.map(s => [s.id, s.name]));

    // 1. Fetch completed storefront orders (profit entries)
    const profitWhere = {
      storefrontId: { in: storefrontIds },
      status: { in: ['COMPLETED', 'PROCESSING'] },
      ...(hasDateFilter && { createdAt: dateFilter })
    };

    const storefrontOrders = storefrontIds.length > 0
      ? await prisma.storefrontOrder.findMany({
          where: profitWhere,
          select: {
            id: true,
            storefrontId: true,
            customerPhone: true,
            customerName: true,
            amount: true,
            ownerCost: true,
            ownerProfit: true,
            status: true,
            paymentMethod: true,
            createdAt: true,
            bundle: { select: { name: true, network: true, dataAmount: true } }
          },
          orderBy: { createdAt: 'asc' }
        })
      : [];

    // 2. Fetch agent payouts (withdrawal entries)
    const payoutWhere = {
      userId,
      status: { in: ['PENDING', 'RESERVED', 'PROCESSING', 'COMPLETED', 'FAILED', 'REJECTED'] },
      ...(hasDateFilter && { createdAt: dateFilter })
    };

    const payouts = await prisma.agentPayout.findMany({
      where: payoutWhere,
      select: {
        id: true,
        amount: true,
        fee: true,
        netAmount: true,
        status: true,
        reference: true,
        accountNumber: true,
        accountName: true,
        manualPayment: true,
        manualPaymentMethod: true,
        reason: true,
        createdAt: true,
        processedAt: true
      },
      orderBy: { createdAt: 'asc' }
    });

    // 3. Merge into unified statement entries sorted by date
    const entries = [];

    for (const order of storefrontOrders) {
      entries.push({
        type: 'PROFIT',
        date: order.createdAt,
        description: `${order.bundle?.network || ''} ${order.bundle?.name || order.bundle?.dataAmount || 'Bundle'} → ${order.customerPhone}`,
        storeName: storefrontMap[order.storefrontId] || 'Store',
        customerName: order.customerName || null,
        credit: order.ownerProfit,
        debit: 0,
        saleAmount: order.amount,
        costPrice: order.ownerCost,
        paymentMethod: order.paymentMethod || '-',
        status: order.status,
        refId: order.id
      });
    }

    for (const payout of payouts) {
      entries.push({
        type: 'WITHDRAWAL',
        date: payout.createdAt,
        description: `Withdrawal → ${payout.accountNumber} (${payout.accountName})`,
        storeName: null,
        customerName: null,
        credit: 0,
        debit: payout.amount,
        fee: payout.fee,
        netAmount: payout.netAmount,
        paymentMethod: payout.manualPayment ? (payout.manualPaymentMethod || 'Manual') : 'Paystack',
        status: payout.status,
        reference: payout.reference,
        reason: payout.reason || null,
        refId: payout.id
      });
    }

    // Sort all entries by date ascending
    entries.sort((a, b) => new Date(a.date) - new Date(b.date));

    // Calculate running balance
    // FAILED/REJECTED withdrawals should NOT affect balance (money was never sent)
    let runningBalance = 0;
    for (const entry of entries) {
      if (entry.type === 'WITHDRAWAL' && ['FAILED', 'REJECTED'].includes(entry.status)) {
        // Show the entry but with zero impact on balance
        entry.debit = 0;
      }
      runningBalance += entry.credit - entry.debit;
      entry.balance = runningBalance;
    }

    // Totals
    const totalProfit = entries.reduce((sum, e) => sum + e.credit, 0);
    const totalWithdrawn = entries.filter(e => e.type === 'WITHDRAWAL' && e.status === 'COMPLETED').reduce((sum, e) => sum + e.debit, 0);
    const totalPending = entries.filter(e => e.type === 'WITHDRAWAL' && ['PENDING', 'RESERVED', 'PROCESSING'].includes(e.status)).reduce((sum, e) => sum + e.debit, 0);
    const totalEntries = entries.length;

    // Get admin adjustments total for this agent
    const adjSum = await prisma.adminProfitAdjustment.aggregate({
      where: { userId },
      _sum: { amount: true }
    });
    const adminAdjustment = adjSum._sum.amount || 0;

    // Paginate (after calculating running balance so balances stay correct)
    // Reverse so newest is first for display
    const reversed = [...entries].reverse();
    const paginated = reversed.slice(skip, skip + limit);

    // netBalance derived: totalProfit - withdrawn - pending + adjustment = available for withdrawal
    const netBalance = totalProfit - totalWithdrawn - totalPending + adminAdjustment;

    res.json({
      agent,
      statement: paginated,
      summary: {
        totalProfit,
        totalWithdrawn,
        pendingWithdrawals: totalPending,
        adminAdjustment,
        netBalance: Math.max(0, netBalance),
        totalEntries
      },
      pagination: {
        page,
        limit,
        total: totalEntries,
        pages: Math.ceil(totalEntries / limit)
      }
    });
  } catch (err) {
    console.error('[AgentStatement] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
