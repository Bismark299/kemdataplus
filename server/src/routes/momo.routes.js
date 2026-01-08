/**
 * MOMO TRANSACTION ROUTES
 * =======================
 * Admin-only MoMo Send & Claim API endpoints.
 * 
 * This implements the two-phase wallet funding system:
 * 1. Admin initiates transaction (locks pending balance)
 * 2. Admin physically sends MoMo money
 * 3. Admin marks as sent
 * 4. User claims with reference (funds credited)
 */

const express = require('express');
const router = express.Router();
const { authenticate, authorize } = require('../middleware/auth');
const momoService = require('../services/momo.service');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// ============================================
// ADMIN-ONLY ENDPOINTS
// ============================================

/**
 * GET /api/momo/transactions
 * Get all MoMo transactions (admin only)
 */
router.get('/transactions', authenticate, authorize('ADMIN'), async (req, res, next) => {
  try {
    const { status, userId, phone } = req.query;
    
    const where = {};
    if (status) where.status = status;
    if (userId) where.userId = userId;
    if (phone) where.phone = { contains: phone };

    const transactions = await prisma.momoTransaction.findMany({
      where,
      include: {
        user: {
          select: { id: true, username: true, email: true, phone: true }
        },
        initiatedByUser: {
          select: { id: true, username: true }
        },
        claimedByUser: {
          select: { id: true, username: true }
        }
      },
      orderBy: { createdAt: 'desc' },
      take: 100
    });

    res.json(transactions);
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/momo/transactions/:id
 * Get specific MoMo transaction
 */
router.get('/transactions/:id', authenticate, authorize('ADMIN'), async (req, res, next) => {
  try {
    const transaction = await prisma.momoTransaction.findUnique({
      where: { id: req.params.id },
      include: {
        user: {
          select: { id: true, username: true, email: true, phone: true }
        },
        initiatedByUser: {
          select: { id: true, username: true }
        },
        claimedByUser: {
          select: { id: true, username: true }
        },
        wallet: true,
        ledgerEntry: true
      }
    });

    if (!transaction) {
      return res.status(404).json({ error: 'Transaction not found' });
    }

    res.json(transaction);
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/momo/initiate
 * PHASE 1: Initiate a MoMo send transaction
 * Creates pending balance lock and generates reference
 */
router.post('/initiate', authenticate, authorize('ADMIN'), async (req, res, next) => {
  try {
    const { userId, amount, phone, notes } = req.body;

    if (!userId || !amount || !phone) {
      return res.status(400).json({
        error: 'userId, amount, and phone are required'
      });
    }

    if (amount <= 0) {
      return res.status(400).json({
        error: 'Amount must be positive'
      });
    }

    const transaction = await momoService.initiateSend(
      req.user.id, // admin user
      userId,      // target user
      amount,
      phone,
      notes
    );

    res.status(201).json({
      message: 'MoMo transaction initiated',
      transaction,
      instructions: {
        step1: 'Send physical MoMo transfer to user',
        step2: 'Call /api/momo/send/:id after MoMo is sent',
        step3: 'User will claim with reference code',
        reference: transaction.reference,
        expiresAt: transaction.expiresAt
      }
    });
  } catch (error) {
    if (error.message.includes('not found')) {
      return res.status(404).json({ error: error.message });
    }
    next(error);
  }
});

/**
 * POST /api/momo/send/:id
 * PHASE 2: Mark transaction as physically sent
 * Admin confirms they've sent MoMo money
 */
router.post('/send/:id', authenticate, authorize('ADMIN'), async (req, res, next) => {
  try {
    const { momoReference, notes } = req.body;

    const transaction = await momoService.markAsSent(
      req.params.id,
      req.user.id,
      momoReference,
      notes
    );

    res.json({
      message: 'Transaction marked as sent',
      transaction,
      instructions: {
        step: 'Wait for user to claim with reference',
        reference: transaction.reference,
        expiresAt: transaction.expiresAt
      }
    });
  } catch (error) {
    if (error.message.includes('not found') || error.message.includes('Invalid')) {
      return res.status(400).json({ error: error.message });
    }
    next(error);
  }
});

/**
 * POST /api/momo/claim
 * PHASE 3: User claims the MoMo transaction
 * Validates reference and credits wallet
 */
router.post('/claim', authenticate, async (req, res, next) => {
  try {
    const { reference } = req.body;

    if (!reference) {
      return res.status(400).json({ error: 'Reference is required' });
    }

    const result = await momoService.processClaim(
      reference,
      req.user.id
    );

    res.json({
      message: 'Funds successfully claimed',
      amount: result.transaction.amount,
      newBalance: result.wallet.balance,
      transaction: {
        id: result.transaction.id,
        reference: result.transaction.reference,
        amount: result.transaction.amount,
        claimedAt: result.transaction.claimedAt
      }
    });
  } catch (error) {
    if (error.message.includes('Invalid') || 
        error.message.includes('expired') ||
        error.message.includes('claimed') ||
        error.message.includes('not') ||
        error.message.includes('does not match')) {
      return res.status(400).json({ error: error.message });
    }
    next(error);
  }
});

/**
 * POST /api/momo/cancel/:id
 * Cancel an initiated transaction (before claim)
 */
router.post('/cancel/:id', authenticate, authorize('ADMIN'), async (req, res, next) => {
  try {
    const { reason } = req.body;

    if (!reason) {
      return res.status(400).json({ error: 'Reason is required' });
    }

    const transaction = await momoService.cancelTransaction(
      req.params.id,
      req.user.id,
      reason
    );

    res.json({
      message: 'Transaction cancelled',
      transaction
    });
  } catch (error) {
    if (error.message.includes('Cannot cancel')) {
      return res.status(400).json({ error: error.message });
    }
    next(error);
  }
});

/**
 * POST /api/momo/expire-check
 * Check and expire old transactions (can be called periodically)
 */
router.post('/expire-check', authenticate, authorize('ADMIN'), async (req, res, next) => {
  try {
    // Find all expired pending transactions
    const expired = await prisma.momoTransaction.findMany({
      where: {
        status: { in: ['INITIATED', 'PENDING_CLAIM'] },
        expiresAt: { lt: new Date() }
      }
    });

    const results = [];
    for (const tx of expired) {
      try {
        const result = await momoService.expireTransaction(tx.id);
        results.push({ id: tx.id, status: 'expired' });
      } catch (e) {
        results.push({ id: tx.id, status: 'error', message: e.message });
      }
    }

    res.json({
      message: `Processed ${expired.length} expired transactions`,
      results
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/momo/pending/:userId
 * Get pending MoMo transactions for a user
 */
router.get('/pending/:userId', authenticate, authorize('ADMIN'), async (req, res, next) => {
  try {
    const transactions = await prisma.momoTransaction.findMany({
      where: {
        userId: req.params.userId,
        status: { in: ['INITIATED', 'PENDING_CLAIM'] }
      },
      orderBy: { createdAt: 'desc' }
    });

    res.json(transactions);
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/momo/stats
 * Get MoMo transaction statistics
 */
router.get('/stats', authenticate, authorize('ADMIN'), async (req, res, next) => {
  try {
    const [
      totalTransactions,
      pendingTransactions,
      claimedTransactions,
      expiredTransactions,
      cancelledTransactions,
      totalAmountClaimed,
      totalAmountPending
    ] = await Promise.all([
      prisma.momoTransaction.count(),
      prisma.momoTransaction.count({
        where: { status: { in: ['INITIATED', 'PENDING_CLAIM'] } }
      }),
      prisma.momoTransaction.count({
        where: { status: 'CLAIMED' }
      }),
      prisma.momoTransaction.count({
        where: { status: 'EXPIRED' }
      }),
      prisma.momoTransaction.count({
        where: { status: 'CANCELLED' }
      }),
      prisma.momoTransaction.aggregate({
        where: { status: 'CLAIMED' },
        _sum: { amount: true }
      }),
      prisma.momoTransaction.aggregate({
        where: { status: { in: ['INITIATED', 'PENDING_CLAIM'] } },
        _sum: { amount: true }
      })
    ]);

    res.json({
      total: totalTransactions,
      pending: pendingTransactions,
      claimed: claimedTransactions,
      expired: expiredTransactions,
      cancelled: cancelledTransactions,
      totalAmountClaimed: totalAmountClaimed._sum.amount || 0,
      totalAmountPending: totalAmountPending._sum.amount || 0
    });
  } catch (error) {
    next(error);
  }
});

// ============================================
// USER ENDPOINTS (for checking own claims)
// ============================================

/**
 * GET /api/momo/my-claims
 * Get user's own MoMo claim history
 */
router.get('/my-claims', authenticate, async (req, res, next) => {
  try {
    const transactions = await prisma.momoTransaction.findMany({
      where: { userId: req.user.id },
      select: {
        id: true,
        reference: true,
        amount: true,
        status: true,
        createdAt: true,
        claimedAt: true
      },
      orderBy: { createdAt: 'desc' },
      take: 50
    });

    res.json(transactions);
  } catch (error) {
    next(error);
  }
});

module.exports = router;
