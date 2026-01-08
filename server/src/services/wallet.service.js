/**
 * WALLET SERVICE - LEDGER-BASED FINANCIAL SYSTEM
 * ================================================
 * Implements a true ledger-based wallet with financial safeguards.
 * 
 * NON-NEGOTIABLE RULES:
 * 1. NO direct balance edits - balance = SUM of ledger entries
 * 2. All operations are atomic (transaction-based)
 * 3. All entries are immutable (append-only)
 * 4. Locked balances for pending orders
 * 5. Daily transaction caps enforced
 * 6. Duplicate references rejected
 * 7. Frozen wallets cannot transact
 */

const { PrismaClient } = require('@prisma/client');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const tenantService = require('./tenant.service');

const prisma = new PrismaClient();

const walletService = {
  /**
   * Get wallet with calculated balance from ledger
   */
  async getWallet(userId) {
    const wallet = await prisma.wallet.findUnique({
      where: { userId },
      include: {
        ledgerEntries: {
          take: 20,
          orderBy: { createdAt: 'desc' }
        }
      }
    });

    if (!wallet) {
      return null;
    }

    // Verify balance matches ledger
    const ledgerBalance = await this.calculateLedgerBalance(wallet.id);
    
    if (Math.abs(wallet.balance - ledgerBalance) > 0.01) {
      console.error(`Balance mismatch for wallet ${wallet.id}: stored=${wallet.balance}, ledger=${ledgerBalance}`);
      // Auto-correct balance to match ledger (ledger is source of truth)
      await prisma.wallet.update({
        where: { id: wallet.id },
        data: { balance: ledgerBalance }
      });
      wallet.balance = ledgerBalance;
    }

    return {
      ...wallet,
      availableBalance: wallet.balance - wallet.lockedBalance
    };
  },

  /**
   * Calculate actual balance from ledger entries
   */
  async calculateLedgerBalance(walletId) {
    const result = await prisma.walletLedger.aggregate({
      where: { walletId },
      _sum: { amount: true }
    });
    return result._sum.amount || 0;
  },

  /**
   * Create wallet for user (with initial zero balance)
   */
  async createWallet(userId) {
    const existing = await prisma.wallet.findUnique({ where: { userId } });
    if (existing) {
      return existing;
    }

    return await prisma.wallet.create({
      data: {
        id: uuidv4(),
        userId,
        balance: 0,
        lockedBalance: 0
      }
    });
  },

  /**
   * CREDIT WALLET - Add funds
   * @param {string} userId - User ID
   * @param {number} amount - Amount to credit (must be positive)
   * @param {string} description - Transaction description
   * @param {string} reference - Unique reference (prevents duplicates)
   * @param {Object} metadata - Additional data (orderId, profitRecordId, etc.)
   */
  async creditWallet(userId, amount, description, reference, metadata = {}) {
    if (amount <= 0) {
      throw new Error('Credit amount must be positive');
    }

    // Check for duplicate reference
    const existingRef = await prisma.walletLedger.findUnique({
      where: { reference }
    });
    if (existingRef) {
      throw new Error('Duplicate transaction reference');
    }

    return await prisma.$transaction(async (tx) => {
      const wallet = await tx.wallet.findUnique({
        where: { userId }
      });

      if (!wallet) {
        throw new Error('Wallet not found');
      }

      if (wallet.isFrozen) {
        throw new Error('Wallet is frozen');
      }

      // Check daily credit cap
      await this.checkDailyCap(wallet, amount, 'credit', tx);

      const newBalance = wallet.balance + amount;

      // Create ledger entry
      const ledgerEntry = await tx.walletLedger.create({
        data: {
          id: uuidv4(),
          walletId: wallet.id,
          entryType: metadata.entryType || 'DEPOSIT',
          amount: amount, // Positive for credit
          runningBalance: newBalance,
          orderId: metadata.orderId,
          transactionId: metadata.transactionId,
          profitRecordId: metadata.profitRecordId,
          description,
          reference,
          checksum: this.generateChecksum({
            walletId: wallet.id,
            amount,
            reference,
            timestamp: new Date().toISOString()
          })
        }
      });

      // Update wallet balance and daily tracking
      await tx.wallet.update({
        where: { id: wallet.id },
        data: {
          balance: newBalance,
          dailyCredits: wallet.dailyCredits + amount
        }
      });

      // Log audit
      await tenantService.logAudit({
        userId,
        action: 'WALLET_CREDIT',
        entityType: 'Wallet',
        entityId: wallet.id,
        newValues: { amount, reference, newBalance },
        metadata
      });

      return {
        success: true,
        ledgerEntry,
        newBalance,
        availableBalance: newBalance - wallet.lockedBalance
      };
    });
  },

  /**
   * DEBIT WALLET - Remove funds
   * @param {string} userId - User ID
   * @param {number} amount - Amount to debit (must be positive)
   * @param {string} description - Transaction description
   * @param {string} reference - Unique reference
   * @param {Object} metadata - Additional data
   */
  async debitWallet(userId, amount, description, reference, metadata = {}) {
    if (amount <= 0) {
      throw new Error('Debit amount must be positive');
    }

    // Check for duplicate reference
    const existingRef = await prisma.walletLedger.findUnique({
      where: { reference }
    });
    if (existingRef) {
      throw new Error('Duplicate transaction reference');
    }

    return await prisma.$transaction(async (tx) => {
      const wallet = await tx.wallet.findUnique({
        where: { userId }
      });

      if (!wallet) {
        throw new Error('Wallet not found');
      }

      if (wallet.isFrozen) {
        throw new Error('Wallet is frozen');
      }

      // Check available balance (exclude locked)
      const availableBalance = wallet.balance - wallet.lockedBalance;
      if (availableBalance < amount) {
        throw new Error(`Insufficient balance. Available: ${availableBalance.toFixed(2)}, Required: ${amount.toFixed(2)}`);
      }

      // Check daily debit cap
      await this.checkDailyCap(wallet, amount, 'debit', tx);

      const newBalance = wallet.balance - amount;

      // Create ledger entry
      const ledgerEntry = await tx.walletLedger.create({
        data: {
          id: uuidv4(),
          walletId: wallet.id,
          entryType: metadata.entryType || 'PURCHASE',
          amount: -amount, // Negative for debit
          runningBalance: newBalance,
          orderId: metadata.orderId,
          transactionId: metadata.transactionId,
          description,
          reference,
          checksum: this.generateChecksum({
            walletId: wallet.id,
            amount: -amount,
            reference,
            timestamp: new Date().toISOString()
          })
        }
      });

      // Update wallet balance
      await tx.wallet.update({
        where: { id: wallet.id },
        data: {
          balance: newBalance,
          dailyDebits: wallet.dailyDebits + amount
        }
      });

      // Log audit
      await tenantService.logAudit({
        userId,
        action: 'WALLET_DEBIT',
        entityType: 'Wallet',
        entityId: wallet.id,
        newValues: { amount, reference, newBalance },
        metadata
      });

      return {
        success: true,
        ledgerEntry,
        newBalance,
        availableBalance: newBalance - wallet.lockedBalance
      };
    });
  },

  /**
   * LOCK BALANCE - Reserve funds for pending order
   */
  async lockBalance(userId, amount, orderId) {
    return await prisma.$transaction(async (tx) => {
      const wallet = await tx.wallet.findUnique({
        where: { userId }
      });

      if (!wallet) {
        throw new Error('Wallet not found');
      }

      if (wallet.isFrozen) {
        throw new Error('Wallet is frozen');
      }

      const availableBalance = wallet.balance - wallet.lockedBalance;
      if (availableBalance < amount) {
        throw new Error(`Insufficient balance to lock. Available: ${availableBalance.toFixed(2)}`);
      }

      await tx.wallet.update({
        where: { id: wallet.id },
        data: {
          lockedBalance: wallet.lockedBalance + amount
        }
      });

      return {
        success: true,
        lockedAmount: amount,
        totalLocked: wallet.lockedBalance + amount,
        availableBalance: availableBalance - amount
      };
    });
  },

  /**
   * UNLOCK BALANCE - Release locked funds (order cancelled)
   */
  async unlockBalance(userId, amount, orderId) {
    return await prisma.$transaction(async (tx) => {
      const wallet = await tx.wallet.findUnique({
        where: { userId }
      });

      if (!wallet) {
        throw new Error('Wallet not found');
      }

      const unlockAmount = Math.min(amount, wallet.lockedBalance);

      await tx.wallet.update({
        where: { id: wallet.id },
        data: {
          lockedBalance: wallet.lockedBalance - unlockAmount
        }
      });

      return {
        success: true,
        unlockedAmount: unlockAmount,
        totalLocked: wallet.lockedBalance - unlockAmount
      };
    });
  },

  /**
   * SETTLE LOCKED BALANCE - Convert locked to actual debit (order completed)
   */
  async settleLockedBalance(userId, amount, orderId, reference) {
    return await prisma.$transaction(async (tx) => {
      const wallet = await tx.wallet.findUnique({
        where: { userId }
      });

      if (!wallet) {
        throw new Error('Wallet not found');
      }

      // Reduce locked balance
      const settleAmount = Math.min(amount, wallet.lockedBalance);

      // Create ledger entry for the settlement
      const ledgerEntry = await tx.walletLedger.create({
        data: {
          id: uuidv4(),
          walletId: wallet.id,
          entryType: 'PURCHASE',
          amount: -settleAmount,
          runningBalance: wallet.balance - settleAmount,
          orderId,
          description: `Order settlement: ${orderId.slice(0, 8)}`,
          reference,
          checksum: this.generateChecksum({
            walletId: wallet.id,
            amount: -settleAmount,
            reference,
            timestamp: new Date().toISOString()
          })
        }
      });

      // Update wallet
      await tx.wallet.update({
        where: { id: wallet.id },
        data: {
          balance: wallet.balance - settleAmount,
          lockedBalance: wallet.lockedBalance - settleAmount,
          dailyDebits: wallet.dailyDebits + settleAmount
        }
      });

      return {
        success: true,
        settledAmount: settleAmount,
        ledgerEntry
      };
    });
  },

  /**
   * Check daily transaction caps
   */
  async checkDailyCap(wallet, amount, type, tx) {
    // Reset daily counters if new day
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    if (wallet.dailyResetAt < today) {
      await tx.wallet.update({
        where: { id: wallet.id },
        data: {
          dailyCredits: 0,
          dailyDebits: 0,
          dailyResetAt: today
        }
      });
      wallet.dailyCredits = 0;
      wallet.dailyDebits = 0;
    }

    // Get user's tenant for caps
    const user = await tx.user.findUnique({
      where: { id: wallet.userId },
      include: { tenant: true }
    });

    const dailyCap = user?.tenant?.dailyTransactionCap;
    
    if (dailyCap) {
      const currentDaily = type === 'credit' ? wallet.dailyCredits : wallet.dailyDebits;
      if (currentDaily + amount > dailyCap) {
        throw new Error(`Daily ${type} limit exceeded. Limit: ${dailyCap}, Used: ${currentDaily}`);
      }
    }
  },

  /**
   * FREEZE WALLET - Admin action
   */
  async freezeWallet(userId, reason, frozenById) {
    const wallet = await prisma.wallet.update({
      where: { userId },
      data: {
        isFrozen: true,
        frozenAt: new Date(),
        frozenReason: reason
      }
    });

    await tenantService.logAudit({
      userId: frozenById,
      action: 'ADMIN_OVERRIDE',
      entityType: 'Wallet',
      entityId: wallet.id,
      metadata: { action: 'FREEZE', reason, targetUserId: userId }
    });

    return wallet;
  },

  /**
   * UNFREEZE WALLET - Admin action
   */
  async unfreezeWallet(userId, unfrozenById) {
    const wallet = await prisma.wallet.update({
      where: { userId },
      data: {
        isFrozen: false,
        frozenAt: null,
        frozenReason: null
      }
    });

    await tenantService.logAudit({
      userId: unfrozenById,
      action: 'ADMIN_OVERRIDE',
      entityType: 'Wallet',
      entityId: wallet.id,
      metadata: { action: 'UNFREEZE', targetUserId: userId }
    });

    return wallet;
  },

  /**
   * Generate checksum for ledger entry integrity
   */
  generateChecksum(data) {
    return crypto
      .createHash('sha256')
      .update(JSON.stringify(data))
      .digest('hex')
      .substring(0, 16);
  },

  /**
   * REFUND - Reverse a transaction (admin only)
   */
  async refundTransaction(ledgerEntryId, refundedById, reason) {
    const original = await prisma.walletLedger.findUnique({
      where: { id: ledgerEntryId },
      include: { wallet: true }
    });

    if (!original) {
      throw new Error('Original transaction not found');
    }

    if (original.amount >= 0) {
      throw new Error('Can only refund debit transactions');
    }

    const refundAmount = Math.abs(original.amount);
    const refundReference = `REFUND-${original.reference}`;

    // Check for duplicate refund
    const existingRefund = await prisma.walletLedger.findUnique({
      where: { reference: refundReference }
    });
    if (existingRefund) {
      throw new Error('Transaction already refunded');
    }

    return await this.creditWallet(
      original.wallet.userId,
      refundAmount,
      `Refund: ${reason || 'Admin refund'}`,
      refundReference,
      {
        entryType: 'REFUND',
        originalEntryId: ledgerEntryId,
        refundedBy: refundedById
      }
    );
  },

  /**
   * Get ledger history with pagination
   */
  async getLedgerHistory(userId, page = 1, limit = 20) {
    const wallet = await prisma.wallet.findUnique({
      where: { userId }
    });

    if (!wallet) {
      throw new Error('Wallet not found');
    }

    const [entries, total] = await Promise.all([
      prisma.walletLedger.findMany({
        where: { walletId: wallet.id },
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'desc' }
      }),
      prisma.walletLedger.count({
        where: { walletId: wallet.id }
      })
    ]);

    return {
      entries,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      }
    };
  },

  /**
   * Verify ledger integrity
   */
  async verifyLedgerIntegrity(walletId) {
    const entries = await prisma.walletLedger.findMany({
      where: { walletId },
      orderBy: { createdAt: 'asc' }
    });

    let calculatedBalance = 0;
    const issues = [];

    for (const entry of entries) {
      calculatedBalance += entry.amount;
      
      if (Math.abs(entry.runningBalance - calculatedBalance) > 0.01) {
        issues.push({
          entryId: entry.id,
          expected: calculatedBalance,
          recorded: entry.runningBalance,
          difference: entry.runningBalance - calculatedBalance
        });
      }
    }

    return {
      walletId,
      totalEntries: entries.length,
      calculatedBalance,
      issues,
      isValid: issues.length === 0
    };
  }
};

module.exports = walletService;
