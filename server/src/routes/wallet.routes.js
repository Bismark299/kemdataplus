const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const fs = require('fs');
const path = require('path');
const walletController = require('../controllers/wallet.controller');
const { authenticate, authorize } = require('../middleware/auth');
const { depositValidation, transferValidation, paginationValidation } = require('../middleware/validators');

// Helper to check if MoMo Claim is enabled
function isMomoClaimEnabled() {
  try {
    const settingsPath = path.join(__dirname, '../../settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    return settings.siteSettings?.momoClaimEnabled !== false;
  } catch (e) {
    return true; // Default to enabled if settings can't be read
  }
}

// Rate limiter for sensitive wallet operations (deposits, transfers, funds)
const walletOperationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // 10 operations per 15 min
  message: { error: 'Too many wallet operations. Please wait before trying again.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.id || req.ip // Rate limit per user when authenticated
});

// GET /api/wallet - Get current user's wallet
router.get('/', authenticate, walletController.getWallet);

// GET /api/wallet/all - Get all wallets (admin only)
router.get('/all', authenticate, authorize('ADMIN'), walletController.getAllWallets);

// GET /api/wallet/balance - Get wallet balance
router.get('/balance', authenticate, walletController.getBalance);

// GET /api/wallet/transactions - Get transaction history
router.get('/transactions', authenticate, paginationValidation, walletController.getTransactions);

// GET /api/wallet/claims - Get user's own pending claims
router.get('/claims', authenticate, walletController.getUserClaims);

// GET /api/wallet/deposits - Get all deposits (admin)
router.get('/deposits', authenticate, authorize('ADMIN'), walletController.getAllDeposits);

// GET /api/wallet/transactions/all - Get all transactions (admin)
router.get('/transactions/all', authenticate, authorize('ADMIN'), walletController.getAllTransactions);

// POST /api/wallet/deposit - Request deposit (client submits claim)
router.post('/deposit', authenticate, walletOperationLimiter, depositValidation, (req, res, next) => {
  // Check if MoMo Claim is enabled
  if (!isMomoClaimEnabled()) {
    return res.status(403).json({ error: 'MoMo claims are currently disabled' });
  }
  walletController.requestDeposit(req, res, next);
});

// POST /api/wallet/deposit/:id/confirm - Confirm deposit with verification (admin)
router.post('/deposit/:id/confirm', authenticate, authorize('ADMIN'), walletController.confirmDeposit);

// POST /api/wallet/deposit/:id/reject - Reject deposit (admin)
router.post('/deposit/:id/reject', authenticate, authorize('ADMIN'), walletController.rejectDeposit);

// POST /api/wallet/fund - Fund user wallet (admin)
router.post('/fund', authenticate, authorize('ADMIN'), walletOperationLimiter, walletController.fundUserWallet);

// POST /api/wallet/deduct - Deduct from user wallet (admin)
router.post('/deduct', authenticate, authorize('ADMIN'), walletOperationLimiter, walletController.deductUserWallet);

// POST /api/wallet/transfer - Transfer to another user
router.post('/transfer', authenticate, walletOperationLimiter, transferValidation, walletController.transfer);

module.exports = router;
