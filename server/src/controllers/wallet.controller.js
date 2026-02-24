const { v4: uuidv4 } = require('uuid');
const { Prisma } = require('@prisma/client');

const prisma = require('../lib/prisma');

const walletController = {
  // Get user's wallet (admin can fetch any user's wallet via ?userId=)
  async getWallet(req, res, next) {
    try {
      // Allow admin to fetch any user's wallet
      let targetUserId = req.user.id;
      if (req.query.userId && req.user.role === 'ADMIN') {
        targetUserId = req.query.userId;
      }
      
      const wallet = await prisma.wallet.findUnique({
        where: { userId: targetUserId },
        include: {
          transactions: {
            take: 10,
            orderBy: { createdAt: 'desc' }
          }
        }
      });

      if (!wallet) {
        return res.status(404).json({ error: 'Wallet not found' });
      }

      res.json(wallet);
    } catch (error) {
      next(error);
    }
  },

  // Get wallet balance
  async getBalance(req, res, next) {
    try {
      const wallet = await prisma.wallet.findUnique({
        where: { userId: req.user.id },
        select: { balance: true }
      });

      res.json({ balance: wallet?.balance || 0 });
    } catch (error) {
      next(error);
    }
  },

  // Get transaction history
  async getTransactions(req, res, next) {
    try {
      // Validate and sanitize pagination parameters
      const page = Math.max(1, Math.min(parseInt(req.query.page) || 1, 10000));
      const limit = Math.max(1, Math.min(parseInt(req.query.limit) || 20, 100));
      const skip = (page - 1) * limit;

      const wallet = await prisma.wallet.findUnique({
        where: { userId: req.user.id }
      });

      if (!wallet) {
        return res.status(404).json({ error: 'Wallet not found' });
      }

      const [transactions, total] = await Promise.all([
        prisma.transaction.findMany({
          where: { walletId: wallet.id },
          skip,
          take: limit,
          orderBy: { createdAt: 'desc' }
        }),
        prisma.transaction.count({
          where: { walletId: wallet.id }
        })
      ]);

      res.json({
        transactions,
        pagination: {
          page,
          limit,
          total,
          pages: Math.ceil(total / limit)
        }
      });
    } catch (error) {
      next(error);
    }
  },

  // Get user's own claims (pending deposits)
  async getUserClaims(req, res, next) {
    try {
      const wallet = await prisma.wallet.findUnique({
        where: { userId: req.user.id }
      });

      if (!wallet) {
        return res.json({ claims: [] });
      }

      const claims = await prisma.transaction.findMany({
        where: {
          walletId: wallet.id,
          type: 'DEPOSIT',
          status: { in: ['PENDING', 'FAILED'] }
        },
        orderBy: { createdAt: 'desc' },
        take: 20
      });

      res.json({
        claims: claims.map(c => ({
          id: c.id,
          amount: c.amount,
          status: c.status,
          transactionId: c.reference,
          reference: c.reference,
          description: c.description,
          createdAt: c.createdAt
        }))
      });
    } catch (error) {
      next(error);
    }
  },
  // Request deposit (client submits claim with transactionId and amount)
  async requestDeposit(req, res, next) {
    try {
      const { amount, paymentMethod, reference, senderPhone } = req.body;

      if (!reference || reference.trim() === '') {
        return res.status(400).json({ error: 'Transaction ID is required' });
      }

      if (!amount || amount <= 0) {
        return res.status(400).json({ error: 'Valid amount is required' });
      }

      // FINANCIAL SAFETY: Cap maximum deposit claim amount
      const MAX_DEPOSIT_CLAIM = 50000; // GHS 50,000 max
      if (amount > MAX_DEPOSIT_CLAIM) {
        return res.status(400).json({ error: `Maximum deposit claim is GHS ${MAX_DEPOSIT_CLAIM}` });
      }

      // Sanitize amount to 2 decimal places
      const sanitizedAmount = Math.round(parseFloat(amount) * 100) / 100;
      if (isNaN(sanitizedAmount) || sanitizedAmount <= 0) {
        return res.status(400).json({ error: 'Invalid amount format' });
      }

      const wallet = await prisma.wallet.findUnique({
        where: { userId: req.user.id }
      });

      if (!wallet) {
        return res.status(404).json({ error: 'Wallet not found' });
      }

      // Check if this transaction ID has already been claimed
      const existingClaim = await prisma.transaction.findFirst({
        where: {
          reference: reference.trim(),
          type: 'DEPOSIT'
        }
      });

      if (existingClaim) {
        return res.status(400).json({ error: 'This transaction ID has already been submitted' });
      }

      const transaction = await prisma.transaction.create({
        data: {
          walletId: wallet.id,
          type: 'DEPOSIT',
          amount: sanitizedAmount,
          status: 'PENDING',
          reference: reference.trim(),
          description: `Deposit via ${paymentMethod}${senderPhone ? ` (${senderPhone})` : ''}`
        }
      });

      res.status(201).json({
        message: 'Claim submitted! Admin will verify your payment.',
        transaction
      });
    } catch (error) {
      next(error);
    }
  },

  // Confirm deposit (admin must enter matching transactionId and amount)
  async confirmDeposit(req, res, next) {
    try {
      const { id } = req.params;
      const { transactionId, amount } = req.body;

      // Admin must provide transactionId and amount for verification
      if (!transactionId || transactionId.trim() === '') {
        return res.status(400).json({ error: 'Transaction ID is required for verification' });
      }

      if (!amount || amount <= 0) {
        return res.status(400).json({ error: 'Amount is required for verification' });
      }

      const transaction = await prisma.transaction.findUnique({
        where: { id },
        include: { wallet: true }
      });

      if (!transaction) {
        return res.status(404).json({ error: 'Claim not found' });
      }

      if (transaction.status !== 'PENDING') {
        return res.status(400).json({ error: 'This claim has already been processed' });
      }

      // Verify that admin's input matches client's submission
      const clientTransactionId = transaction.reference;
      const clientAmount = parseFloat(transaction.amount);
      const adminTransactionId = transactionId.trim();
      const adminAmount = parseFloat(amount);

      // Check if transaction ID matches
      if (clientTransactionId !== adminTransactionId) {
        return res.status(400).json({ 
          error: 'Transaction ID does not match',
          message: 'The transaction ID you entered does not match the client\'s submission. Please verify and try again.'
        });
      }

      // Check if amount matches (with small tolerance for floating point)
      if (Math.abs(clientAmount - adminAmount) > 0.01) {
        return res.status(400).json({ 
          error: 'Amount does not match',
          message: 'The amount you entered does not match the client\'s submission. Please verify and try again.'
        });
      }

      // Both match - approve the claim
      // HARDENED: Serializable transaction with status re-check to prevent double-credit
      const updatedTransaction = await prisma.$transaction(async (tx) => {
        // Re-check status INSIDE transaction atomically
        const freshTx = await tx.transaction.findUnique({ where: { id } });
        if (!freshTx || freshTx.status !== 'PENDING') {
          throw new Error('ALREADY_PROCESSED');
        }

        await tx.transaction.update({
          where: { id },
          data: { status: 'COMPLETED' }
        });

        await tx.wallet.update({
          where: { id: transaction.walletId },
          data: {
            balance: { increment: transaction.amount }
          }
        });

        // Audit log
        await tx.auditLog.create({
          data: {
            userId: req.user.id,
            action: 'CONFIRM_DEPOSIT',
            entityType: 'Transaction',
            entityId: id,
            newValues: {
              amount: transaction.amount,
              reference: transaction.reference,
              walletId: transaction.walletId
            }
          }
        });

        return freshTx;
      }, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        timeout: 10000
      });

      res.json({
        message: 'Claim verified and approved! Funds have been credited.',
        transaction: updatedTransaction
      });
    } catch (error) {
      if (error.message === 'ALREADY_PROCESSED') {
        return res.status(400).json({ error: 'This claim has already been processed' });
      }
      next(error);
    }
  },

  // Reject deposit (admin)
  async rejectDeposit(req, res, next) {
    try {
      const { id } = req.params;
      const { reason } = req.body;

      const transaction = await prisma.transaction.findUnique({
        where: { id }
      });

      if (!transaction) {
        return res.status(404).json({ error: 'Claim not found' });
      }

      if (transaction.status !== 'PENDING') {
        return res.status(400).json({ error: 'This claim has already been processed' });
      }

      const updatedTransaction = await prisma.transaction.update({
        where: { id },
        data: { 
          status: 'FAILED',
          description: transaction.description + (reason ? ` | Rejected: ${reason}` : ' | Rejected by admin')
        }
      });

      res.json({
        message: 'Claim rejected',
        transaction: updatedTransaction
      });
    } catch (error) {
      next(error);
    }
  },

  // Transfer to another user OR admin fund/debit
  // HARDENED: Serializable isolation + optimistic locks on all balance changes
  async transfer(req, res, next) {
    try {
      const { recipientEmail, userId, amount, description, type, note } = req.body;
      
      // Admin fund/debit flow (when userId and type are provided)
      if (userId && type && (type === 'credit' || type === 'debit')) {
        // Check if user is admin
        if (req.user.role !== 'ADMIN') {
          return res.status(403).json({ error: 'Admin access required for fund/debit operations' });
        }

        if (!amount || amount <= 0) {
          return res.status(400).json({ error: 'Valid amount is required' });
        }

        // FINANCIAL SAFETY: Cap admin operations
        const MAX_ADMIN_OP = 100000;
        if (amount > MAX_ADMIN_OP) {
          return res.status(400).json({ error: `Maximum admin ${type} is GHS ${MAX_ADMIN_OP}` });
        }

        const reference = type === 'credit' 
          ? `ADMIN-CREDIT-${uuidv4().slice(0, 8).toUpperCase()}`
          : `ADMIN-DEBIT-${uuidv4().slice(0, 8).toUpperCase()}`;

        // HARDENED: Use interactive Serializable transaction
        const updatedWallet = await prisma.$transaction(async (tx) => {
          const targetWallet = await tx.wallet.findUnique({
            where: { userId },
            include: { user: { select: { name: true, email: true } } }
          });

          if (!targetWallet) {
            throw new Error('WALLET_NOT_FOUND');
          }

          if (type === 'debit') {
            // Optimistic lock for debits: ensure balance is sufficient
            const result = await tx.wallet.update({
              where: { 
                id: targetWallet.id,
                balance: { gte: amount } // CRITICAL: Optimistic lock
              },
              data: { balance: { decrement: amount } }
            });
            if (!result) throw new Error('INSUFFICIENT_BALANCE');
          } else {
            await tx.wallet.update({
              where: { id: targetWallet.id },
              data: { balance: { increment: amount } }
            });
          }

          await tx.transaction.create({
            data: {
              walletId: targetWallet.id,
              type: type === 'credit' ? 'DEPOSIT' : 'WITHDRAWAL',
              amount: type === 'credit' ? amount : -amount,
              status: 'COMPLETED',
              reference,
              description: note || description || (type === 'credit' ? 'Admin credit' : 'Admin debit')
            }
          });

          // Audit log
          await tx.auditLog.create({
            data: {
              userId: req.user.id,
              action: type === 'credit' ? 'ADMIN_WALLET_CREDIT' : 'ADMIN_WALLET_DEBIT',
              entityType: 'Wallet',
              entityId: targetWallet.id,
              newValues: { amount, type, reference, targetUserId: userId }
            }
          });

          // Re-fetch for accurate balance
          return await tx.wallet.findUnique({
            where: { id: targetWallet.id },
            include: { user: { select: { name: true } } }
          });
        }, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
          timeout: 10000
        });

        return res.json({
          message: `Wallet ${type === 'credit' ? 'credited' : 'debited'} successfully`,
          reference,
          amount,
          type,
          newBalance: updatedWallet.balance,
          user: updatedWallet.user.name
        });
      }

      // Regular user-to-user transfer flow
      if (amount <= 0) {
        return res.status(400).json({ error: 'Invalid amount' });
      }

      // FINANCIAL SAFETY: Cap transfer amount
      const MAX_TRANSFER = 50000;
      if (amount > MAX_TRANSFER) {
        return res.status(400).json({ error: `Maximum transfer is GHS ${MAX_TRANSFER}` });
      }

      const recipient = await prisma.user.findUnique({
        where: { email: recipientEmail },
        include: { wallet: true }
      });

      if (!recipient || !recipient.wallet) {
        return res.status(404).json({ error: 'Recipient not found' });
      }

      // Cannot transfer to yourself
      if (recipient.id === req.user.id) {
        return res.status(400).json({ error: 'Cannot transfer to yourself' });
      }

      const reference = `TRF-${uuidv4().slice(0, 8).toUpperCase()}`;

      // HARDENED: Serializable transaction with optimistic lock on sender balance
      await prisma.$transaction(async (tx) => {
        // Check sender balance INSIDE transaction
        const senderWallet = await tx.wallet.findUnique({
          where: { userId: req.user.id }
        });

        if (!senderWallet || senderWallet.balance < amount) {
          throw new Error('INSUFFICIENT_BALANCE');
        }

        // Check frozen
        if (senderWallet.isFrozen) {
          throw new Error('WALLET_FROZEN');
        }

        // Deduct from sender with OPTIMISTIC LOCK
        const deductResult = await tx.wallet.update({
          where: { 
            id: senderWallet.id,
            balance: { gte: amount } // CRITICAL: Optimistic lock
          },
          data: { balance: { decrement: amount } }
        });
        if (!deductResult) throw new Error('INSUFFICIENT_BALANCE');

        // Add to recipient
        await tx.wallet.update({
          where: { id: recipient.wallet.id },
          data: { balance: { increment: amount } }
        });
        // Record sender transaction
        await tx.transaction.create({
          data: {
            walletId: senderWallet.id,
            type: 'TRANSFER_OUT',
            amount: -amount,
            status: 'COMPLETED',
            reference,
            description: description || `Transfer to ${recipientEmail}`
          }
        });
        // Record recipient transaction
        await tx.transaction.create({
          data: {
            walletId: recipient.wallet.id,
            type: 'TRANSFER_IN',
            amount,
            status: 'COMPLETED',
            reference,
            description: `Transfer from ${req.user.email}`
          }
        });
      }, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        timeout: 10000
      });

      res.json({
        message: 'Transfer successful',
        reference
      });
    } catch (error) {
      next(error);
    }
  },

  // Get all deposits (admin)
  async getAllDeposits(req, res, next) {
    try {
      const page = parseInt(req.query.page) || 1;
      const limit = parseInt(req.query.limit) || 50;
      const skip = (page - 1) * limit;
      const status = req.query.status; // Optional filter: PENDING, COMPLETED, FAILED

      const where = {
        type: 'DEPOSIT'
      };
      if (status) {
        where.status = status.toUpperCase();
      }

      const [deposits, total] = await Promise.all([
        prisma.transaction.findMany({
          where,
          skip,
          take: limit,
          orderBy: { createdAt: 'desc' },
          include: {
            wallet: {
              include: {
                user: {
                  select: {
                    id: true,
                    name: true,
                    email: true,
                    phone: true
                  }
                }
              }
            }
          }
        }),
        prisma.transaction.count({ where })
      ]);

      res.json({
        deposits: deposits.map(d => ({
          id: d.id,
          amount: d.amount,
          status: d.status,
          reference: d.reference,
          description: d.description,
          createdAt: d.createdAt,
          user: d.wallet?.user
        })),
        pagination: {
          page,
          limit,
          total,
          pages: Math.ceil(total / limit)
        }
      });
    } catch (error) {
      next(error);
    }
  },

  // Get all transactions (admin) - for wallet management tab
  async getAllTransactions(req, res, next) {
    try {
      const page = parseInt(req.query.page) || 1;
      const limit = Math.min(parseInt(req.query.limit) || 100, 500);
      const skip = (page - 1) * limit;
      const typeFilter = req.query.type; // Optional filter
      const userIdFilter = req.query.userId; // Optional user filter

      const where = {};
      if (typeFilter) {
        where.type = typeFilter.toUpperCase();
      }
      
      // Filter by userId (through wallet relation)
      if (userIdFilter) {
        where.wallet = {
          userId: userIdFilter
        };
      }

      const [transactions, total] = await Promise.all([
        prisma.transaction.findMany({
          where,
          skip,
          take: limit,
          orderBy: { createdAt: 'desc' },
          include: {
            wallet: {
              include: {
                user: {
                  select: {
                    id: true,
                    name: true,
                    email: true,
                    phone: true
                  }
                }
              }
            }
          }
        }),
        prisma.transaction.count({ where })
      ]);

      res.json({
        transactions: transactions.map(t => ({
          id: t.id,
          type: t.type,
          amount: t.amount,
          status: t.status,
          reference: t.reference,
          description: t.description,
          createdAt: t.createdAt,
          userName: t.wallet?.user?.name,
          userPhone: t.wallet?.user?.phone,
          userId: t.wallet?.user?.id
        })),
        pagination: {
          page,
          limit,
          total,
          pages: Math.ceil(total / limit)
        }
      });
    } catch (error) {
      next(error);
    }
  },

  // Fund user wallet (admin) - HARDENED with Serializable isolation + audit
  async fundUserWallet(req, res, next) {
    try {
      const { userId, amount, description } = req.body;

      if (!userId || !amount || amount <= 0) {
        return res.status(400).json({ error: 'Valid userId and amount are required' });
      }

      // FINANCIAL SAFETY: Cap admin funding
      const MAX_FUND = 100000;
      if (amount > MAX_FUND) {
        return res.status(400).json({ error: `Maximum admin funding is GHS ${MAX_FUND}` });
      }

      const reference = 'ADMIN-FUND-' + uuidv4().slice(0, 8).toUpperCase();

      // HARDENED: Serializable transaction with audit
      const updatedWallet = await prisma.$transaction(async (tx) => {
        const wallet = await tx.wallet.findUnique({
          where: { userId }
        });

        if (!wallet) {
          throw new Error('WALLET_NOT_FOUND');
        }

        const updated = await tx.wallet.update({
          where: { id: wallet.id },
          data: { balance: { increment: amount } }
        });

        await tx.transaction.create({
          data: {
            walletId: wallet.id,
            type: 'DEPOSIT',
            amount,
            status: 'COMPLETED',
            reference,
            description: description || 'Admin wallet funding'
          }
        });

        // Audit trail
        await tx.auditLog.create({
          data: {
            userId: req.user.id,
            action: 'ADMIN_FUND_WALLET',
            entityType: 'Wallet',
            entityId: wallet.id,
            newValues: { amount, reference, targetUserId: userId, description }
          }
        });

        return updated;
      }, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        timeout: 10000
      });

      res.json({
        message: 'Wallet funded successfully',
        reference,
        amount,
        newBalance: updatedWallet.balance
      });
    } catch (error) {
      if (error.message === 'WALLET_NOT_FOUND') {
        return res.status(404).json({ error: 'User wallet not found' });
      }
      next(error);
    }
  },

  // Deduct from user wallet (admin) - HARDENED with Serializable + optimistic lock
  async deductUserWallet(req, res, next) {
    try {
      const { userId, amount, reason } = req.body;

      if (!userId || !amount || amount <= 0) {
        return res.status(400).json({ error: 'Valid userId and amount are required' });
      }

      if (!reason) {
        return res.status(400).json({ error: 'Reason for deduction is required' });
      }

      const reference = 'ADMIN-DEDUCT-' + uuidv4().slice(0, 8).toUpperCase();

      // HARDENED: Serializable + optimistic lock
      const updatedWallet = await prisma.$transaction(async (tx) => {
        const wallet = await tx.wallet.findUnique({
          where: { userId }
        });

        if (!wallet) {
          throw new Error('WALLET_NOT_FOUND');
        }

        if (wallet.balance < amount) {
          throw new Error('INSUFFICIENT_BALANCE');
        }

        // Optimistic lock: ensure balance didn't change between check and update
        const updated = await tx.wallet.update({
          where: { 
            id: wallet.id,
            balance: { gte: amount } // CRITICAL: Prevents negative balance
          },
          data: { balance: { decrement: amount } }
        });

        if (!updated) {
          throw new Error('INSUFFICIENT_BALANCE');
        }

        await tx.transaction.create({
          data: {
            walletId: wallet.id,
            type: 'WITHDRAWAL',
            amount: -amount,
            status: 'COMPLETED',
            reference,
            description: `Admin deduction: ${reason}`
          }
        });

        // Audit trail
        await tx.auditLog.create({
          data: {
            userId: req.user.id,
            action: 'ADMIN_DEDUCT_WALLET',
            entityType: 'Wallet',
            entityId: wallet.id,
            newValues: { amount, reason, reference, targetUserId: userId }
          }
        });

        return updated;
      }, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        timeout: 10000
      }).catch(err => {
        if (err.message === 'WALLET_NOT_FOUND') {
          throw { status: 404, message: 'User wallet not found' };
        }
        if (err.message === 'INSUFFICIENT_BALANCE') {
          throw { status: 400, message: 'Insufficient balance for deduction' };
        }
        throw err;
      });

      res.json({
        message: 'Wallet deducted successfully',
        reference,
        amount,
        reason,
        newBalance: updatedWallet.balance
      });
    } catch (error) {
      if (error.status) {
        return res.status(error.status).json({ error: error.message });
      }
      next(error);
    }
  },

  // Get all wallets (admin only)
  async getAllWallets(req, res, next) {
    try {
      const wallets = await prisma.wallet.findMany({
        include: {
          user: {
            select: {
              id: true,
              name: true,
              email: true,
              role: true
            }
          },
          transactions: {
            take: 5,
            orderBy: { createdAt: 'desc' }
          }
        }
      });

      res.json(wallets);
    } catch (error) {
      next(error);
    }
  }
};

module.exports = walletController;
