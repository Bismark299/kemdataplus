const { v4: uuidv4 } = require('uuid');

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
      const page  = Math.max(1, Math.min(parseInt(req.query.page)  || 1, 10000));
      const limit = Math.max(1, Math.min(parseInt(req.query.limit) || 20, 500));
      const skip  = (page - 1) * limit;

      const wallet = await prisma.wallet.findUnique({
        where: { userId: req.user.id }
      });

      if (!wallet) {
        return res.status(404).json({ error: 'Wallet not found' });
      }

      // Read from WalletLedger — this is where ALL balance changes are recorded
      // (creditWallet, debitWallet, refunds, deposits, payouts all write here)
      const [entries, total] = await Promise.all([
        prisma.walletLedger.findMany({
          where: { walletId: wallet.id },
          skip,
          take: limit,
          orderBy: { createdAt: 'desc' }
        }),
        prisma.walletLedger.count({
          where: { walletId: wallet.id }
        })
      ]);

      res.json({
        transactions: entries.map(e => ({
          id:          e.id,
          type:        e.entryType,
          amount:      e.amount,
          balance:     e.runningBalance,
          description: e.description,
          reference:   e.reference,
          createdAt:   e.createdAt
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
          amount: parseFloat(amount),
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
      const [updatedTransaction] = await prisma.$transaction([
        prisma.transaction.update({
          where: { id },
          data: { status: 'COMPLETED' }
        }),
        prisma.wallet.update({
          where: { id: transaction.walletId },
          data: {
            balance: {
              increment: transaction.amount
            }
          }
        })
      ]);

      res.json({
        message: 'Claim verified and approved! Funds have been credited.',
        transaction: updatedTransaction
      });
    } catch (error) {
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

        const targetWallet = await prisma.wallet.findUnique({
          where: { userId },
          include: { user: { select: { name: true, email: true } } }
        });

        if (!targetWallet) {
          return res.status(404).json({ error: 'User wallet not found' });
        }

        if (type === 'debit' && targetWallet.balance < amount) {
          return res.status(400).json({ 
            error: 'Insufficient balance for debit',
            available: targetWallet.balance,
            requested: amount
          });
        }

        const reference = type === 'credit' 
          ? `ADMIN-CREDIT-${uuidv4().slice(0, 8).toUpperCase()}`
          : `ADMIN-DEBIT-${uuidv4().slice(0, 8).toUpperCase()}`;

        const [updatedWallet] = await prisma.$transaction([
          prisma.wallet.update({
            where: { id: targetWallet.id },
            data: { 
              balance: type === 'credit' 
                ? { increment: amount } 
                : { decrement: amount } 
            }
          }),
          prisma.transaction.create({
            data: {
              walletId: targetWallet.id,
              type: type === 'credit' ? 'DEPOSIT' : 'WITHDRAWAL',
              amount: type === 'credit' ? amount : -amount,
              status: 'COMPLETED',
              reference,
              description: note || description || (type === 'credit' ? 'Admin credit' : 'Admin debit')
            }
          })
        ]);

        return res.json({
          message: `Wallet ${type === 'credit' ? 'credited' : 'debited'} successfully`,
          reference,
          amount,
          type,
          newBalance: updatedWallet.balance,
          user: targetWallet.user.name
        });
      }

      // Regular user-to-user transfer flow
      if (amount <= 0) {
        return res.status(400).json({ error: 'Invalid amount' });
      }

      const recipient = await prisma.user.findUnique({
        where: { email: recipientEmail },
        include: { wallet: true }
      });

      if (!recipient || !recipient.wallet) {
        return res.status(404).json({ error: 'Recipient not found' });
      }

      const reference = `TRF-${uuidv4().slice(0, 8).toUpperCase()}`;

      // Execute transfer with balance check INSIDE transaction to prevent race condition
      await prisma.$transaction(async (tx) => {
        // Check sender balance INSIDE transaction (prevents race condition)
        const senderWallet = await tx.wallet.findUnique({
          where: { userId: req.user.id }
        });

        if (!senderWallet || senderWallet.balance < amount) {
          throw new Error('INSUFFICIENT_BALANCE');
        }

        //
        // Deduct from sender
        await tx.wallet.update({
          where: { id: senderWallet.id },
          data: { balance: { decrement: amount } }
        });
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
      const typeFilter = req.query.type;
      const userIdFilter = req.query.userId;
      const search = req.query.search;
      const fromDate = req.query.fromDate;
      const toDate = req.query.toDate;

      const where = {};

      // Type filter — 'credit' and 'debit' are meta-groups
      if (typeFilter) {
        const creditTypes = ['DEPOSIT', 'REFUND', 'TRANSFER_IN', 'CREDIT', 'PROFIT_CREDIT', 'COMMISSION'];
        const debitTypes  = ['PURCHASE', 'DEDUCTION', 'TRANSFER_OUT', 'WITHDRAWAL'];
        if (typeFilter.toLowerCase() === 'credit') {
          where.type = { in: creditTypes };
        } else if (typeFilter.toLowerCase() === 'debit') {
          where.type = { in: debitTypes };
        } else {
          where.type = typeFilter.toUpperCase();
        }
      }

      // Date range filter
      if (fromDate || toDate) {
        where.createdAt = {};
        if (fromDate) where.createdAt.gte = new Date(fromDate);
        if (toDate) {
          const to = new Date(toDate);
          to.setUTCDate(to.getUTCDate() + 1);
          where.createdAt.lt = to;
        }
      }

      // Search filter — description or reference
      if (search) {
        where.OR = [
          { description: { contains: search, mode: 'insensitive' } },
          { reference:   { contains: search, mode: 'insensitive' } }
        ];
      }

      // Filter by userId (through wallet relation)
      if (userIdFilter) {
        where.wallet = { userId: userIdFilter };
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

  // Fund user wallet (admin)
  async fundUserWallet(req, res, next) {
    try {
      const { userId, amount, description } = req.body;

      if (!userId || !amount || amount <= 0) {
        return res.status(400).json({ error: 'Valid userId and amount are required' });
      }

      const wallet = await prisma.wallet.findUnique({
        where: { userId }
      });

      if (!wallet) {
        return res.status(404).json({ error: 'User wallet not found' });
      }

      const reference = 'ADMIN-FUND-' + uuidv4().slice(0, 8).toUpperCase();

      const [updatedWallet] = await prisma.$transaction([
        prisma.wallet.update({
          where: { id: wallet.id },
          data: { balance: { increment: amount } }
        }),
        prisma.transaction.create({
          data: {
            walletId: wallet.id,
            type: 'DEPOSIT',
            amount,
            status: 'COMPLETED',
            reference,
            description: description || 'Admin wallet funding'
          }
        })
      ]);

      res.json({
        message: 'Wallet funded successfully',
        reference,
        amount,
        newBalance: updatedWallet.balance
      });
    } catch (error) {
      next(error);
    }
  },

  // Deduct from user wallet (admin)
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

      // Balance check INSIDE transaction to prevent race condition
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

        const updated = await tx.wallet.update({
          where: { id: wallet.id },
          data: { balance: { decrement: amount } }
        });

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

        return updated;
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
