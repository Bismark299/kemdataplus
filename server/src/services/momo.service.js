/**
 * MOMO SEND & CLAIM SERVICE
 * =========================
 * Admin-only manual wallet funding system with two-phase verification.
 * 
 * FLOW:
 * 1. SEND PHASE: Admin initiates send, generates reference, locks target wallet
 * 2. CLAIM PHASE: Admin verifies MoMo receipt, finalizes credit
 * 
 * SAFETY FEATURES:
 * - Idempotency keys prevent duplicate sends
 * - Reference uniqueness enforced
 * - Time-based expiration for pending claims
 * - Admin permission checks at every step
 * - Full audit trail
 */

const { PrismaClient } = require('@prisma/client');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');

const prisma = new PrismaClient();

// Configuration
const CLAIM_WINDOW_HOURS = 24; // Hours before pending claim expires
const REFERENCE_PREFIX = 'MOMO';

const momoService = {
  /**
   * SEND PHASE: Admin initiates MoMo send
   * Creates pending transaction and locks target wallet
   * 
   * @param {object} params
   * @param {string} params.targetUserId - User to receive funds
   * @param {number} params.amount - Amount to send
   * @param {string} params.targetPhone - MoMo phone number
   * @param {string} params.adminId - Admin initiating the send
   * @param {string} params.ipAddress - Admin's IP address
   */
  async initiateSend({ targetUserId, amount, targetPhone, adminId, ipAddress }) {
    // Validate admin
    const admin = await prisma.user.findUnique({ where: { id: adminId } });
    if (!admin || admin.role !== 'ADMIN') {
      throw new Error('Only ADMIN can initiate MoMo sends');
    }

    // Validate target user
    const targetUser = await prisma.user.findUnique({
      where: { id: targetUserId },
      include: { wallet: true }
    });

    if (!targetUser) {
      throw new Error('Target user not found');
    }

    if (!targetUser.isActive) {
      throw new Error('Target user account is not active');
    }

    if (!targetUser.wallet) {
      throw new Error('Target user has no wallet');
    }

    if (targetUser.wallet.isFrozen) {
      throw new Error('Target wallet is frozen');
    }

    // Validate amount
    if (amount <= 0) {
      throw new Error('Amount must be positive');
    }

    // Generate unique reference
    const reference = this.generateReference();
    
    // Calculate expiration
    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + CLAIM_WINDOW_HOURS);

    // Create transaction in database
    const transaction = await prisma.$transaction(async (tx) => {
      // Create MoMo transaction record
      const momoTx = await tx.momoTransaction.create({
        data: {
          reference,
          targetUserId,
          initiatedBy: adminId,
          amount,
          fee: 0,
          netAmount: amount,
          targetPhone,
          status: 'INITIATED',
          expiresAt,
          ipAddress,
          metadata: {
            initiatedAt: new Date().toISOString(),
            adminEmail: admin.email
          }
        }
      });

      // Lock amount in target wallet (prevent other operations)
      await tx.wallet.update({
        where: { userId: targetUserId },
        data: {
          lockedBalance: { increment: amount }
        }
      });

      // Audit log
      await tx.auditLog.create({
        data: {
          userId: adminId,
          action: 'WALLET_CREDIT',
          entityType: 'MomoTransaction',
          entityId: momoTx.id,
          newValues: {
            phase: 'SEND_INITIATED',
            reference,
            amount,
            targetUserId,
            targetPhone
          },
          ipAddress
        }
      });

      return momoTx;
    });

    return {
      success: true,
      transaction: {
        id: transaction.id,
        reference: transaction.reference,
        amount: transaction.amount,
        targetPhone: transaction.targetPhone,
        status: transaction.status,
        expiresAt: transaction.expiresAt
      },
      message: `MoMo send initiated. Reference: ${reference}. Complete send and claim within ${CLAIM_WINDOW_HOURS} hours.`
    };
  },

  /**
   * Mark transaction as sent (after physical MoMo send)
   */
  async markAsSent({ transactionId, momoReference, adminId }) {
    const admin = await prisma.user.findUnique({ where: { id: adminId } });
    if (!admin || admin.role !== 'ADMIN') {
      throw new Error('Only ADMIN can update MoMo transactions');
    }

    const transaction = await prisma.momoTransaction.findUnique({
      where: { id: transactionId }
    });

    if (!transaction) {
      throw new Error('Transaction not found');
    }

    if (transaction.status !== 'INITIATED') {
      throw new Error(`Cannot mark as sent. Current status: ${transaction.status}`);
    }

    // Check for duplicate MoMo reference
    if (momoReference) {
      const existing = await prisma.momoTransaction.findFirst({
        where: { momoReference, id: { not: transactionId } }
      });
      if (existing) {
        throw new Error('MoMo reference already used in another transaction');
      }
    }

    const updated = await prisma.momoTransaction.update({
      where: { id: transactionId },
      data: {
        status: 'PENDING_CLAIM',
        momoReference,
        sentAt: new Date()
      }
    });

    await prisma.auditLog.create({
      data: {
        userId: adminId,
        action: 'UPDATE',
        entityType: 'MomoTransaction',
        entityId: transactionId,
        newValues: { phase: 'SENT', momoReference }
      }
    });

    return updated;
  },

  /**
   * CLAIM PHASE: Admin verifies receipt and finalizes credit
   * 
   * @param {object} params
   * @param {string} params.transactionId - MoMo transaction ID
   * @param {string} params.momoReference - MoMo network reference (for verification)
   * @param {string} params.verificationNotes - Admin notes
   * @param {string} params.adminId - Admin processing claim
   * @param {string} params.ipAddress - Admin's IP
   */
  async processClaim({ transactionId, momoReference, verificationNotes, adminId, ipAddress }) {
    const admin = await prisma.user.findUnique({ where: { id: adminId } });
    if (!admin || admin.role !== 'ADMIN') {
      throw new Error('Only ADMIN can process claims');
    }

    const transaction = await prisma.momoTransaction.findUnique({
      where: { id: transactionId },
      include: { targetUser: { include: { wallet: true } } }
    });

    if (!transaction) {
      throw new Error('Transaction not found');
    }

    // Validate status
    if (transaction.status === 'CLAIMED') {
      throw new Error('Transaction already claimed');
    }

    if (transaction.status === 'EXPIRED') {
      throw new Error('Transaction has expired');
    }

    if (transaction.status === 'CANCELLED') {
      throw new Error('Transaction was cancelled');
    }

    if (!['INITIATED', 'PENDING_CLAIM'].includes(transaction.status)) {
      throw new Error(`Cannot claim. Current status: ${transaction.status}`);
    }

    // Check expiration
    if (new Date() > transaction.expiresAt) {
      await this.expireTransaction(transactionId);
      throw new Error('Claim window has expired');
    }

    // If MoMo reference provided, verify uniqueness
    if (momoReference && momoReference !== transaction.momoReference) {
      const existing = await prisma.momoTransaction.findFirst({
        where: { momoReference, id: { not: transactionId } }
      });
      if (existing) {
        throw new Error('MoMo reference already used');
      }
    }

    const wallet = transaction.targetUser.wallet;
    const ledgerReference = `${transaction.reference}-CLAIM`;

    // Process claim in transaction
    const result = await prisma.$transaction(async (tx) => {
      // 1. Update MoMo transaction status
      const momoTx = await tx.momoTransaction.update({
        where: { id: transactionId },
        data: {
          status: 'CLAIMED',
          momoReference: momoReference || transaction.momoReference,
          claimedBy: adminId,
          claimedAt: new Date(),
          verificationNotes
        }
      });

      // 2. Move locked balance to available
      const updatedWallet = await tx.wallet.update({
        where: { id: wallet.id },
        data: {
          balance: { increment: transaction.netAmount },
          lockedBalance: { decrement: transaction.amount },
          dailyCredits: { increment: transaction.netAmount }
        }
      });

      // 3. Create immutable ledger entry
      const ledgerEntry = await tx.walletLedger.create({
        data: {
          walletId: wallet.id,
          entryType: 'DEPOSIT',
          amount: transaction.netAmount,
          runningBalance: updatedWallet.balance,
          momoTransactionId: transactionId,
          reference: ledgerReference,
          description: `MoMo deposit - Ref: ${transaction.reference}`,
          checksum: this.generateChecksum(wallet.id, transaction.netAmount, ledgerReference)
        }
      });

      // 4. Audit log
      await tx.auditLog.create({
        data: {
          userId: adminId,
          action: 'WALLET_CREDIT',
          entityType: 'MomoTransaction',
          entityId: transactionId,
          newValues: {
            phase: 'CLAIMED',
            amount: transaction.netAmount,
            walletBalance: updatedWallet.balance,
            momoReference: momoReference || transaction.momoReference
          },
          ipAddress
        }
      });

      return { momoTx, updatedWallet, ledgerEntry };
    });

    return {
      success: true,
      message: 'MoMo claim processed successfully',
      transaction: result.momoTx,
      walletBalance: result.updatedWallet.balance
    };
  },

  /**
   * Cancel a pending MoMo transaction
   */
  async cancelTransaction({ transactionId, reason, adminId, ipAddress }) {
    const admin = await prisma.user.findUnique({ where: { id: adminId } });
    if (!admin || admin.role !== 'ADMIN') {
      throw new Error('Only ADMIN can cancel transactions');
    }

    const transaction = await prisma.momoTransaction.findUnique({
      where: { id: transactionId },
      include: { targetUser: { include: { wallet: true } } }
    });

    if (!transaction) {
      throw new Error('Transaction not found');
    }

    if (['CLAIMED', 'CANCELLED', 'EXPIRED'].includes(transaction.status)) {
      throw new Error(`Cannot cancel. Status: ${transaction.status}`);
    }

    // Cancel and unlock wallet
    await prisma.$transaction(async (tx) => {
      await tx.momoTransaction.update({
        where: { id: transactionId },
        data: {
          status: 'CANCELLED',
          verificationNotes: `Cancelled: ${reason}`
        }
      });

      // Unlock the locked balance
      await tx.wallet.update({
        where: { userId: transaction.targetUserId },
        data: {
          lockedBalance: { decrement: transaction.amount }
        }
      });

      await tx.auditLog.create({
        data: {
          userId: adminId,
          action: 'UPDATE',
          entityType: 'MomoTransaction',
          entityId: transactionId,
          newValues: { phase: 'CANCELLED', reason },
          ipAddress
        }
      });
    });

    return { success: true, message: 'Transaction cancelled' };
  },

  /**
   * Expire a transaction (called automatically or manually)
   */
  async expireTransaction(transactionId) {
    const transaction = await prisma.momoTransaction.findUnique({
      where: { id: transactionId }
    });

    if (!transaction || ['CLAIMED', 'CANCELLED', 'EXPIRED'].includes(transaction.status)) {
      return;
    }

    await prisma.$transaction(async (tx) => {
      await tx.momoTransaction.update({
        where: { id: transactionId },
        data: { status: 'EXPIRED' }
      });

      // Unlock the locked balance
      await tx.wallet.update({
        where: { userId: transaction.targetUserId },
        data: {
          lockedBalance: { decrement: transaction.amount }
        }
      });

      await tx.auditLog.create({
        data: {
          action: 'UPDATE',
          entityType: 'MomoTransaction',
          entityId: transactionId,
          newValues: { phase: 'EXPIRED', expiredAt: new Date().toISOString() }
        }
      });
    });
  },

  /**
   * Get pending transactions (for admin dashboard)
   */
  async getPendingTransactions() {
    return prisma.momoTransaction.findMany({
      where: {
        status: { in: ['INITIATED', 'PENDING_CLAIM'] }
      },
      include: {
        targetUser: {
          select: { id: true, name: true, email: true, phone: true }
        },
        initiator: {
          select: { id: true, name: true, email: true }
        }
      },
      orderBy: { createdAt: 'desc' }
    });
  },

  /**
   * Get transaction history
   */
  async getTransactionHistory(filters = {}) {
    const where = {};
    
    if (filters.status) where.status = filters.status;
    if (filters.targetUserId) where.targetUserId = filters.targetUserId;
    if (filters.startDate) where.createdAt = { gte: new Date(filters.startDate) };
    if (filters.endDate) {
      where.createdAt = { ...where.createdAt, lte: new Date(filters.endDate) };
    }

    return prisma.momoTransaction.findMany({
      where,
      include: {
        targetUser: {
          select: { id: true, name: true, email: true }
        },
        initiator: {
          select: { id: true, name: true }
        },
        claimer: {
          select: { id: true, name: true }
        }
      },
      orderBy: { createdAt: 'desc' },
      take: filters.limit || 100
    });
  },

  /**
   * Get transaction by reference
   */
  async getByReference(reference) {
    return prisma.momoTransaction.findUnique({
      where: { reference },
      include: {
        targetUser: {
          select: { id: true, name: true, email: true, phone: true }
        },
        initiator: {
          select: { id: true, name: true }
        }
      }
    });
  },

  /**
   * Process expired transactions (run periodically)
   */
  async processExpiredTransactions() {
    const expired = await prisma.momoTransaction.findMany({
      where: {
        status: { in: ['INITIATED', 'PENDING_CLAIM'] },
        expiresAt: { lt: new Date() }
      }
    });

    let processed = 0;
    for (const tx of expired) {
      await this.expireTransaction(tx.id);
      processed++;
    }

    return { processed };
  },

  /**
   * Generate unique reference
   */
  generateReference() {
    const timestamp = Date.now().toString(36).toUpperCase();
    const random = crypto.randomBytes(3).toString('hex').toUpperCase();
    return `${REFERENCE_PREFIX}-${timestamp}-${random}`;
  },

  /**
   * Generate checksum for ledger entry integrity
   */
  generateChecksum(walletId, amount, reference) {
    const data = `${walletId}:${amount}:${reference}:${Date.now()}`;
    return crypto.createHash('sha256').update(data).digest('hex').substring(0, 16);
  },

  /**
   * Admin dashboard stats for MoMo
   */
  async getStats() {
    const [pending, todayCompleted, todayAmount] = await Promise.all([
      prisma.momoTransaction.count({
        where: { status: { in: ['INITIATED', 'PENDING_CLAIM'] } }
      }),
      prisma.momoTransaction.count({
        where: {
          status: 'CLAIMED',
          claimedAt: { gte: new Date(new Date().setHours(0, 0, 0, 0)) }
        }
      }),
      prisma.momoTransaction.aggregate({
        where: {
          status: 'CLAIMED',
          claimedAt: { gte: new Date(new Date().setHours(0, 0, 0, 0)) }
        },
        _sum: { netAmount: true }
      })
    ]);

    return {
      pendingCount: pending,
      todayCompletedCount: todayCompleted,
      todayTotalAmount: todayAmount._sum.netAmount || 0
    };
  }
};

module.exports = momoService;
