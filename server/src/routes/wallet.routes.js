const express = require('express');
const router = express.Router();
const walletController = require('../controllers/wallet.controller');
const { authenticate, authorize } = require('../middleware/auth');
const { depositValidation, paginationValidation } = require('../middleware/validators');

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

// POST /api/wallet/deposit - Request deposit (client submits claim)
router.post('/deposit', authenticate, depositValidation, walletController.requestDeposit);

// POST /api/wallet/deposit/:id/confirm - Confirm deposit with verification (admin)
router.post('/deposit/:id/confirm', authenticate, authorize('ADMIN'), walletController.confirmDeposit);

// POST /api/wallet/deposit/:id/reject - Reject deposit (admin)
router.post('/deposit/:id/reject', authenticate, authorize('ADMIN'), walletController.rejectDeposit);

// POST /api/wallet/fund - Fund user wallet (admin)
router.post('/fund', authenticate, authorize('ADMIN'), walletController.fundUserWallet);

// POST /api/wallet/deduct - Deduct from user wallet (admin)
router.post('/deduct', authenticate, authorize('ADMIN'), walletController.deductUserWallet);

// POST /api/wallet/transfer - Transfer to another user
router.post('/transfer', authenticate, walletController.transfer);

module.exports = router;
