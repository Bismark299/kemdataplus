/**
 * PROFIT PAYOUT SERVICE (ENHANCED)
 * ==================================
 * 
 * Enhanced Flow with Balance Reservation:
 * 1. Store sale completes → recordPendingProfit() → Goes to "Uncredited Profits"
 * 2. User requests withdrawal → Balance RESERVED (not deducted yet)
 * 3. Admin approves bulk payouts → Paystack bulk transfer initiated → Status: PROCESSING
 * 4. Paystack webhook confirms success/failure → Balance finalized
 * 
 * Features:
 * - Recipient code caching (saves API calls)
 * - True bulk transfer support
 * - Webhook-driven finalization
 * - Fee transparency
 * - Full audit trail with alerts
 */

const fs = require('fs');
const path = require('path');
const auditService = require('./audit.service');
const alertService = require('./alert.service');
const smsService = require('./sms.service');

const prisma = require('../lib/prisma');

// Ghana Mobile Money codes for Paystack
const MOBILE_MONEY_CODES = {
  'mtn': 'MTN',
  'MTN': 'MTN',
  'vodafone': 'VOD',
  'telecel': 'VOD',
  'VOD': 'VOD',
  'airteltigo': 'ATL',
  'ATL': 'ATL'
};

// Paystack MoMo transfer fee (flat fee per transfer in GHS)
const PAYSTACK_MOMO_FEE = 1.00; // GH₵1.00 per MoMo transfer

// Get Paystack config
function getPaystackConfig() {
  if (process.env.PAYSTACK_SECRET_KEY) {
    return {
      secretKey: process.env.PAYSTACK_SECRET_KEY,
      publicKey: process.env.PAYSTACK_PUBLIC_KEY || ''
    };
  }
  
  try {
    const settingsPath = path.join(__dirname, '../../settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    return {
      secretKey: settings.adminSettings?.paystackSecretKey || '',
      publicKey: settings.adminSettings?.paystackPublicKey || ''
    };
  } catch (e) {
    return { secretKey: '', publicKey: '' };
  }
}

// Check Paystack balance
async function checkPaystackBalance() {
  try {
    const data = await paystackRequest('/balance');
    // Paystack returns balance in kobo/pesewas — convert to GHS
    const ghsBalance = (data.data?.[0]?.balance || 0) / 100;
    console.log(`[Paystack] Balance: GH₵${ghsBalance.toFixed(2)}`);
    return ghsBalance;
  } catch (err) {
    console.error('[Paystack] Balance check failed:', err.message);
    return 0; // Fail safe — treat as no balance so it goes to admin
  }
}

// Paystack API helper
async function paystackRequest(endpoint, method = 'GET', body = null) {
  const config = getPaystackConfig();
  const url = `https://api.paystack.co${endpoint}`;
  
  if (!config.secretKey) {
    throw new Error('Paystack secret key not configured');
  }
  
  const options = {
    method,
    headers: {
      'Authorization': `Bearer ${config.secretKey}`,
      'Content-Type': 'application/json'
    }
  };
  
  if (body && method !== 'GET') {
    options.body = JSON.stringify(body);
  }
  
  console.log(`[Paystack] ${method} ${endpoint}`);
  
  const response = await fetch(url, options);
  const data = await response.json();
  
  if (!response.ok) {
    console.error(`[Paystack] Error:`, data);
    throw new Error(data.message || `Paystack API Error: ${response.status}`);
  }
  
  return data;
}

// Get payout settings
function getPayoutSettings() {
  try {
    const settingsPath = path.join(__dirname, '../../settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    return {
      mode: settings.profitPayoutSettings?.mode || 'weekly_momo',
      minPayout: settings.profitPayoutSettings?.minPayout || 10,
      payoutDay: settings.profitPayoutSettings?.payoutDay || 'friday',
      payoutTime: settings.profitPayoutSettings?.payoutTime || '19:30'
    };
  } catch (e) {
    return { mode: 'weekly_momo', minPayout: 10, payoutDay: 'friday', payoutTime: '19:30' };
  }
}

const profitPayoutService = {
  
  getSettings() {
    return getPayoutSettings();
  },

  /**
   * Calculate withdrawal fee
   */
  calculateFee(amount) {
    return PAYSTACK_MOMO_FEE;
  },

  /**
   * Get or create Paystack recipient for a user (with caching)
   * This saves API calls by reusing recipient codes
   */
  async getOrCreateRecipient({ userId, accountName, accountNumber, bankCode }) {
    // Check if user already has a cached recipient code for these details
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { momoRecipientCode: true, momoNumber: true, momoNetwork: true, momoName: true }
    });

    // If same MoMo details already have a recipient code, reuse it
    if (user?.momoRecipientCode && 
        user.momoNumber === accountNumber && 
        user.momoNetwork === bankCode) {
      console.log(`[Payout] Reusing cached recipient code for user ${userId}`);
      return user.momoRecipientCode;
    }

    // Create new recipient with Paystack
    const recipientData = {
      type: 'mobile_money',
      name: accountName,
      account_number: accountNumber,
      bank_code: bankCode,
      currency: 'GHS'
    };

    const response = await paystackRequest('/transferrecipient', 'POST', recipientData);
    const recipientCode = response.data.recipient_code;

    // Cache the recipient code on the user
    await prisma.user.update({
      where: { id: userId },
      data: {
        momoRecipientCode: recipientCode,
        momoNumber: accountNumber,
        momoNetwork: bankCode,
        momoName: accountName
      }
    });

    console.log(`[Payout] Created and cached new recipient code for user ${userId}: ${recipientCode}`);
    return recipientCode;
  },

  /**
   * Resolve/verify MoMo account with Paystack
   */
  async resolveAccount(accountNumber, bankCode) {
    try {
      const response = await paystackRequest(
        `/bank/resolve?account_number=${accountNumber}&bank_code=${bankCode}`
      );
      
      if (response.status && response.data) {
        return {
          success: true,
          verified: true,
          accountName: response.data.account_name,
          accountNumber: response.data.account_number,
          bankCode: bankCode,
          fee: PAYSTACK_MOMO_FEE // Include fee for transparency
        };
      }
      
      return { success: false, verified: false, message: 'Could not verify account' };
    } catch (error) {
      console.error('[Profit] Account resolution error:', error.message);
      return { success: false, verified: false, message: error.message || 'Verification failed' };
    }
  },

  // ============================================================
  // PENDING PROFITS (Uncredited Earnings)
  // ============================================================

  /**
   * Record a pending profit when store sale completes
   */
  async recordPendingProfit({ userId, storefrontId, orderId, orderReference, amount, description }) {
    const profit = await prisma.pendingProfit.create({
      data: {
        userId,
        storefrontId,
        orderId,
        orderReference,
        amount,
        description,
        status: 'PENDING'
      }
    });
    console.log(`[Profit] Recorded GH₵${amount} for user ${userId} (${orderReference})`);
    return profit;
  },

  /**
   * Cancel pending profit (on refund)
   */
  async cancelPendingProfit(orderId, reason = 'Order refunded') {
    const profit = await prisma.pendingProfit.findFirst({
      where: { orderId, status: 'PENDING' }
    });

    if (!profit) return null;

    return prisma.pendingProfit.update({
      where: { id: profit.id },
      data: { status: 'CANCELLED', cancelledAt: new Date(), cancelReason: reason }
    });
  },

  /**
   * Get user's pending (uncredited) profits
   */
  async getUserPendingProfits(userId) {
    const profits = await prisma.pendingProfit.findMany({
      where: { userId, status: 'PENDING' },
      include: { storefront: { select: { name: true } } },
      orderBy: { createdAt: 'desc' }
    });

    const total = profits.reduce((sum, p) => sum + p.amount, 0);
    return { profits, total, count: profits.length };
  },

  /**
   * Get user's profit stats
   */
  async getUserProfitStats(userId) {
    // Today's date range (UTC)
    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);
    const todayEnd = new Date();
    todayEnd.setUTCHours(23, 59, 59, 999);

    const [pending, paid, today, pendingWithdrawals] = await Promise.all([
      prisma.pendingProfit.aggregate({
        where: { userId, status: 'PENDING' },
        _sum: { amount: true },
        _count: true
      }),
      prisma.pendingProfit.aggregate({
        where: { userId, status: 'PAID' },
        _sum: { amount: true },
        _count: true
      }),
      prisma.pendingProfit.aggregate({
        where: { 
          userId, 
          status: 'PENDING',
          createdAt: { gte: todayStart, lte: todayEnd }
        },
        _sum: { amount: true },
        _count: true
      }),
      // Get pending/processing withdrawal requests that haven't been completed
      prisma.agentPayout.aggregate({
        where: { 
          userId, 
          status: { in: ['PENDING', 'RESERVED', 'PROCESSING'] }
        },
        _sum: { amount: true }
      })
    ]);

    const settings = getPayoutSettings();
    
    // Available = Total pending profits - amounts already requested for withdrawal
    const totalPending = pending._sum.amount || 0;
    const reservedForWithdrawal = pendingWithdrawals._sum.amount || 0;
    const availableForWithdrawal = Math.max(0, totalPending - reservedForWithdrawal);

    return {
      pendingAmount: totalPending,
      pendingCount: pending._count || 0,
      availableForWithdrawal,  // This is what they can actually withdraw
      reservedForWithdrawal,   // Amount already in pending withdrawal requests
      totalPaidAmount: paid._sum.amount || 0,
      totalPaidCount: paid._count || 0,
      todayAmount: today._sum.amount || 0,
      todayCount: today._count || 0,
      minPayout: settings.minPayout
    };
  },

  /**
   * Get user's profit history
   */
  async getUserProfitHistory(userId, { page = 1, limit = 20 } = {}) {
    const skip = (page - 1) * limit;

    const [profits, total] = await Promise.all([
      prisma.pendingProfit.findMany({
        where: { userId },
        include: { storefront: { select: { name: true } } },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit
      }),
      prisma.pendingProfit.count({ where: { userId } })
    ]);

    return { profits, pagination: { page, limit, total, pages: Math.ceil(total / limit) } };
  },

  // ============================================================
  // WITHDRAWAL REQUESTS
  // ============================================================

  /**
   * User requests withdrawal from their earnings
   * Flow: Creates PENDING request → Admin approves → RESERVED → PROCESSING → COMPLETED
   */
  async requestWithdrawal({ userId, amount, accountName, accountNumber, network, saveMomoDetails = false }) {
    console.log('[requestWithdrawal] Starting:', { userId, amount, accountName, accountNumber, network });
    
    const settings = getPayoutSettings();
    const fee = this.calculateFee(amount);
    const netAmount = amount - fee;

    console.log('[requestWithdrawal] Fee calculation:', { fee, netAmount, minPayout: settings.minPayout });

    // Check minimum (after fee)
    if (netAmount < settings.minPayout) {
      throw new Error(`Minimum withdrawal is GH₵${settings.minPayout} (after GH₵${fee.toFixed(2)} fee)`);
    }

    // Validate amount
    if (!amount || typeof amount !== 'number' || amount <= 0 || !isFinite(amount) || amount > 999999) {
      throw new Error('Invalid withdrawal amount');
    }

    // Save MoMo details to user profile for future use (outside transaction — non-critical)
    if (saveMomoDetails) {
      const networkCode = MOBILE_MONEY_CODES[network] || network.toUpperCase();
      await prisma.user.update({
        where: { id: userId },
        data: {
          momoName: accountName,
          momoNumber: accountNumber,
          momoNetwork: networkCode
        }
      });
      console.log('[requestWithdrawal] Saved MoMo details to user profile');
    }

    // Network display names
    const networkNames = {
      'mtn': 'MTN Mobile Money',
      'MTN': 'MTN Mobile Money',
      'vodafone': 'Vodafone Cash',
      'telecel': 'Vodafone Cash',
      'VOD': 'Vodafone Cash',
      'airteltigo': 'AirtelTigo Money',
      'ATL': 'AirtelTigo Money'
    };

    // === ATOMIC TRANSACTION: balance check + payout creation ===
    // Serializable isolation prevents concurrent withdrawals from reading stale balances
    const result = await prisma.$transaction(async (tx) => {
      // Check available earnings INSIDE transaction
      const [pendingProfits, pendingWithdrawals] = await Promise.all([
        tx.pendingProfit.aggregate({
          where: { userId, status: 'PENDING' },
          _sum: { amount: true }
        }),
        tx.agentPayout.aggregate({
          where: { 
            userId, 
            status: { in: ['PENDING', 'RESERVED', 'PROCESSING'] }
          },
          _sum: { amount: true }
        })
      ]);

      const totalPending = pendingProfits._sum.amount || 0;
      const alreadyRequested = pendingWithdrawals._sum.amount || 0;
      const available = Math.max(0, totalPending - alreadyRequested);
      
      console.log('[requestWithdrawal] Available earnings:', { totalPending, alreadyRequested, available });
      
      if (amount > available) {
        throw new Error(`Insufficient earnings. Available: GH₵${available.toFixed(2)}`);
      }

      // Check for existing requests INSIDE transaction
      const existingPending = await tx.agentPayout.findFirst({
        where: { userId, status: 'PENDING' }
      });
      
      const existingProcessing = await tx.agentPayout.findFirst({
        where: { 
          userId, 
          status: { in: ['RESERVED', 'PROCESSING'] }
        }
      });

      console.log('[requestWithdrawal] Existing PENDING:', existingPending ? existingPending.id : 'none');
      console.log('[requestWithdrawal] Existing PROCESSING:', existingProcessing ? existingProcessing.id : 'none');
      
      // Block if already being processed
      if (existingProcessing) {
        throw new Error('You have a withdrawal being processed. Please wait until it completes.');
      }

      // If existing PENDING request, accumulate to it
      if (existingPending) {
        const newTotal = existingPending.amount + amount;
        const newFee = this.calculateFee(newTotal);
        const newNetAmount = newTotal - newFee;
        
        // Check minimum after fee for the new total
        if (newNetAmount < settings.minPayout) {
          throw new Error(`Minimum withdrawal is GH₵${settings.minPayout} (after GH₵${newFee.toFixed(2)} fee)`);
        }
        
        const updatedPayout = await tx.agentPayout.update({
          where: { id: existingPending.id },
          data: {
            amount: newTotal,
            fee: newFee,
            netAmount: newNetAmount,
            accountName,
            accountNumber,
            bankCode: MOBILE_MONEY_CODES[network] || 'MTN',
            bankName: networkNames[network] || network,
            reason: `Profit withdrawal - ${networkNames[network] || network} (accumulated)`
          }
        });
        
        console.log(`[Payout] Withdrawal accumulated: ${existingPending.reference} - GH₵${existingPending.amount} + GH₵${amount} = GH₵${newTotal}`);
        
        return {
          payout: updatedPayout,
          accumulated: true,
          previousAmount: existingPending.amount,
          reference: existingPending.reference,
          newTotal,
          newFee,
          newNetAmount
        };
      }

      // Create new withdrawal request
      const reference = `WD-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
      
      const payout = await tx.agentPayout.create({
        data: {
          userId,
          amount,
          fee,
          netAmount,
          status: 'PENDING',
          accountType: 'mobile_money',
          accountName,
          accountNumber,
          bankCode: MOBILE_MONEY_CODES[network] || 'MTN',
          bankName: networkNames[network] || network,
          reference,
          reason: `Profit withdrawal - ${networkNames[network] || network}`
        }
      });

      console.log(`[Payout] Withdrawal request created: ${reference} - GH₵${amount}`);

      return { payout, accumulated: false, reference };
    }, {
      isolationLevel: 'Serializable',
      timeout: 10000
    });
    // === END ATOMIC TRANSACTION ===

    // Audit logging (outside transaction — non-critical)
    if (result.accumulated) {
      try {
        await auditService.logPayoutAccumulate({
          userId,
          payoutId: result.payout.id,
          reference: result.reference,
          previousAmount: result.previousAmount,
          previousFee: result.payout.fee,
          addedAmount: amount,
          newAmount: result.newTotal,
          newFee: result.newFee
        });
      } catch (auditErr) {
        console.error('[requestWithdrawal] Audit log failed (non-critical):', auditErr.message);
      }

      return {
        success: true,
        payout: result.payout,
        accumulated: true,
        previousAmount: result.previousAmount,
        addedAmount: amount,
        message: `Added GH₵${amount.toFixed(2)} to your pending request. New total: GH₵${result.newTotal.toFixed(2)} (receive GH₵${result.newNetAmount.toFixed(2)} after fee)`
      };
    }

    const payout = result.payout;
    const reference = result.reference;

    // Audit log for new payout (non-critical)
    try {
      await auditService.logPayoutRequest({
        userId,
        payoutId: payout.id,
        reference,
        amount,
        fee,
        netAmount,
        accountName,
        accountNumber,
        network: MOBILE_MONEY_CODES[network] || 'MTN'
      });
    } catch (auditErr) {
      console.error('[requestWithdrawal] Audit log failed (non-critical):', auditErr.message);
    }

    // AUTO-PROCESS: Check Paystack balance and auto-send if sufficient
    try {
      const paystackBalance = await checkPaystackBalance();
      if (paystackBalance >= netAmount) {
        console.log(`[Payout] Auto-processing ${reference}: Paystack balance GH₵${paystackBalance.toFixed(2)} >= net GH₵${netAmount.toFixed(2)}`);
        
        // Auto-process the payout (use system as admin)
        const autoResult = await this.processSinglePayout(payout, 'SYSTEM_AUTO');
        
        if (autoResult.requiresOtp) {
          // OTP required — can't auto-process, leave as PENDING for admin
          console.log(`[Payout] OTP required for ${reference}, leaving as PENDING for admin`);
          return {
            success: true,
            payout,
            autoProcessed: false,
            message: `Withdrawal request of GH₵${amount.toFixed(2)} submitted. Awaiting admin approval (OTP required).`
          };
        }
        
        // Use actual status from processing result (COMPLETED for instant, PROCESSING otherwise)
        const finalStatus = autoResult.status || 'PROCESSING';
        const statusMessage = finalStatus === 'COMPLETED' 
          ? `Withdrawal of GH₵${netAmount.toFixed(2)} sent successfully!`
          : `Withdrawal of GH₵${amount.toFixed(2)} is being processed. You'll receive GH₵${netAmount.toFixed(2)} shortly.`;
        
        return {
          success: true,
          payout: { ...payout, status: finalStatus },
          autoProcessed: true,
          message: statusMessage
        };
      } else {
        console.log(`[Payout] Insufficient Paystack balance for auto-process: GH₵${paystackBalance.toFixed(2)} < GH₵${netAmount.toFixed(2)}. Queued for admin.`);
      }
    } catch (autoErr) {
      console.error(`[Payout] Auto-process failed for ${reference}, queued for admin:`, autoErr.message);
      // Fall through — leave as PENDING for admin
    }

    return {
      success: true,
      payout,
      autoProcessed: false,
      message: `Withdrawal request of GH₵${amount.toFixed(2)} submitted. Awaiting admin approval.`
    };
  },

  /**
   * Get user's withdrawal requests
   */
  async getUserWithdrawals(userId, { page = 1, limit = 10 } = {}) {
    const skip = (page - 1) * limit;

    const [payouts, total] = await Promise.all([
      prisma.agentPayout.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit
      }),
      prisma.agentPayout.count({ where: { userId } })
    ]);

    return { payouts, pagination: { page, limit, total, pages: Math.ceil(total / limit) } };
  },

  /**
   * Cancel withdrawal request (user)
   */
  async cancelWithdrawal(userId, payoutId) {
    const payout = await prisma.agentPayout.findUnique({ where: { id: payoutId } });

    if (!payout || payout.userId !== userId) {
      throw new Error('Withdrawal request not found');
    }

    if (payout.status !== 'PENDING') {
      throw new Error('Can only cancel pending requests');
    }

    return prisma.agentPayout.update({
      where: { id: payoutId },
      data: { status: 'REJECTED', reviewNotes: 'Cancelled by user' }
    });
  },

  // ============================================================
  // ADMIN FUNCTIONS
  // ============================================================

  /**
   * Get admin stats
   */
  async getAdminStats() {
    // Today's date range (UTC)
    const now = new Date();
    const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0));
    const todayEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 59, 59, 999));

    const [pendingProfits, todayProfits, completedWithdrawals, usersWithProfits] = await Promise.all([
      prisma.pendingProfit.aggregate({
        where: { status: 'PENDING' },
        _sum: { amount: true },
        _count: true
      }),
      // Today's earned profits from storefront orders
      prisma.storefrontOrder.aggregate({
        where: {
          status: { in: ['COMPLETED', 'PROCESSING'] },
          createdAt: { gte: todayStart, lte: todayEnd }
        },
        _sum: { ownerProfit: true },
        _count: true
      }),
      prisma.agentPayout.aggregate({
        where: { status: 'COMPLETED' },
        _sum: { amount: true },
        _count: true
      }),
      prisma.pendingProfit.groupBy({
        by: ['userId'],
        where: { status: 'PENDING' }
      })
    ]);

    return {
      pending: {
        amount: pendingProfits._sum.amount || 0,
        count: pendingProfits._count || 0,
        userCount: usersWithProfits.length
      },
      today: {
        amount: todayProfits._sum.ownerProfit || 0,
        count: todayProfits._count || 0
      },
      totalPaid: {
        amount: completedWithdrawals._sum.amount || 0,
        count: completedWithdrawals._count || 0
      }
    };
  },

  /**
   * Get withdrawal stats grouped by status
   */
  async getWithdrawalStats() {
    const [pending, completed, failed, rejected] = await Promise.all([
      prisma.agentPayout.aggregate({
        where: { status: 'PENDING' },
        _sum: { amount: true },
        _count: true
      }),
      prisma.agentPayout.aggregate({
        where: { status: 'COMPLETED' },
        _sum: { amount: true },
        _count: true
      }),
      prisma.agentPayout.aggregate({
        where: { status: 'FAILED' },
        _sum: { amount: true },
        _count: true
      }),
      prisma.agentPayout.aggregate({
        where: { status: 'REJECTED' },
        _sum: { amount: true },
        _count: true
      })
    ]);

    return {
      pending: { amount: pending._sum.amount || 0, count: pending._count || 0 },
      completed: { amount: completed._sum.amount || 0, count: completed._count || 0 },
      failed: { amount: failed._sum.amount || 0, count: failed._count || 0 },
      rejected: { amount: rejected._sum.amount || 0, count: rejected._count || 0 }
    };
  },

  /**
   * Get all pending withdrawal requests (admin)
   */
  async getPendingWithdrawals({ page = 1, limit = 50 } = {}) {
    const skip = (page - 1) * limit;

    const [requests, total] = await Promise.all([
      prisma.agentPayout.findMany({
        where: { status: 'PENDING' },
        include: {
          user: { select: { id: true, name: true, email: true, phone: true } }
        },
        orderBy: { createdAt: 'asc' },
        skip,
        take: limit
      }),
      prisma.agentPayout.count({ where: { status: 'PENDING' } })
    ]);

    return { requests, pagination: { page, limit, total, pages: Math.ceil(total / limit) } };
  },

  /**
   * Get all withdrawal requests (admin)
   * Supports status and date range filtering
   */
  async getAllWithdrawals({ page = 1, limit = 50, status = null, startDate = null, endDate = null } = {}) {
    const skip = (page - 1) * limit;
    const where = {};
    
    // Status filter
    if (status) {
      where.status = status;
    }
    
    // Date range filter
    if (startDate || endDate) {
      where.createdAt = {};
      if (startDate) {
        where.createdAt.gte = new Date(startDate);
      }
      if (endDate) {
        // Set to end of the day
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);
        where.createdAt.lte = end;
      }
    }

    const [requests, total] = await Promise.all([
      prisma.agentPayout.findMany({
        where,
        include: {
          user: { select: { id: true, name: true, email: true, phone: true } }
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit
      }),
      prisma.agentPayout.count({ where })
    ]);

    return { requests, pagination: { page, limit, total, pages: Math.ceil(total / limit) } };
  },

  /**
   * BULK APPROVE - Process all pending withdrawal requests via MoMo
   * Enhanced flow: PENDING → RESERVED → PROCESSING → COMPLETED (via webhook)
   */
  async bulkApproveWithdrawals(adminId) {
    console.log('[BulkPayout] Starting bulk approval of pending withdrawals...');

    // Get all pending withdrawal requests
    const pendingPayouts = await prisma.agentPayout.findMany({
      where: { status: 'PENDING' },
      include: { user: { select: { id: true, name: true, email: true } } }
    });

    if (pendingPayouts.length === 0) {
      return { success: true, processed: 0, message: 'No pending withdrawal requests' };
    }

    const totalAmount = pendingPayouts.reduce((sum, p) => sum + p.netAmount, 0);
    const totalFees = pendingPayouts.reduce((sum, p) => sum + p.fee, 0);

    // Create batch record
    const batch = await prisma.payoutBatch.create({
      data: {
        totalAmount,
        payoutCount: pendingPayouts.length,
        processedBy: adminId,
        processorName: 'Admin Bulk Approval',
        notes: `Total fees: GH₵${totalFees.toFixed(2)}`
      }
    });

    // Step 1: Reserve all balances and get/create recipient codes
    console.log(`[BulkPayout] Reserving ${pendingPayouts.length} payouts...`);
    const preparedPayouts = [];
    
    for (const payout of pendingPayouts) {
      try {
        // Get or create recipient code
        const recipientCode = await this.getOrCreateRecipient({
          userId: payout.userId,
          accountName: payout.accountName,
          accountNumber: payout.accountNumber,
          bankCode: payout.bankCode
        });

        // Reserve the payout (link to batch)
        await prisma.agentPayout.update({
          where: { id: payout.id },
          data: {
            status: 'RESERVED',
            recipientCode,
            batchId: batch.id,
            reviewedBy: adminId,
            reviewedAt: new Date()
          }
        });

        preparedPayouts.push({ ...payout, recipientCode });
      } catch (err) {
        console.error(`[BulkPayout] Failed to prepare ${payout.reference}:`, err.message);
        
        // Mark as failed
        await prisma.agentPayout.update({
          where: { id: payout.id },
          data: {
            status: 'FAILED',
            failureReason: `Preparation failed: ${err.message}`,
            batchId: batch.id
          }
        });
      }
    }

    if (preparedPayouts.length === 0) {
      await prisma.payoutBatch.update({
        where: { id: batch.id },
        data: { failedCount: pendingPayouts.length }
      });
      return { success: false, message: 'All payouts failed preparation', batchId: batch.id };
    }

    // Step 2: Process transfers using Paystack BULK endpoint (/transfer/bulk)
    // Paystack limits: max 100 per batch, 5 second delay between batches
    console.log(`[BulkPayout] Processing ${preparedPayouts.length} transfers via bulk endpoint...`);
    
    let successCount = 0;
    let failedCount = pendingPayouts.length - preparedPayouts.length;
    const results = [];
    const BATCH_SIZE = 100;
    
    // Split into batches of 100
    const batches = [];
    for (let i = 0; i < preparedPayouts.length; i += BATCH_SIZE) {
      batches.push(preparedPayouts.slice(i, i + BATCH_SIZE));
    }
    
    for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
      const currentBatch = batches[batchIndex];
      
      // Wait 5 seconds between batches (Paystack rate limit)
      if (batchIndex > 0) {
        console.log(`[BulkPayout] Waiting 5s before batch ${batchIndex + 1}...`);
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
      
      // Build transfers array for Paystack bulk endpoint
      // Use unique reference per attempt to avoid Paystack duplicate rejection
      const batchTimestamp = Date.now();
      const transfers = currentBatch.map((payout, idx) => ({
        amount: Math.round(payout.netAmount * 100), // Convert to pesewas
        reference: `${payout.reference}-${batchTimestamp}-${idx}`,
        reason: `Profit withdrawal - ${payout.reference}`,
        recipient: payout.recipientCode
      }));
      
      try {
        console.log(`[BulkPayout] Sending batch ${batchIndex + 1}/${batches.length} (${transfers.length} transfers)...`);
        
        const bulkResponse = await paystackRequest('/transfer/bulk', 'POST', {
          currency: 'GHS',
          source: 'balance',
          transfers
        });
        
        // Process results from bulk response
        const responseData = bulkResponse.data || [];
        
        for (let i = 0; i < currentBatch.length; i++) {
          const payout = currentBatch[i];
          const transferResult = responseData[i];
          
          if (transferResult && transferResult.transfer_code) {
            // Update payout to PROCESSING
            await prisma.agentPayout.update({
              where: { id: payout.id },
              data: {
                status: 'PROCESSING',
                transferCode: transferResult.transfer_code,
                paystackReference: transferResult.reference || transfers[i]?.reference || payout.reference,
                processedAt: new Date()
              }
            });
            
            successCount++;
            results.push({ payoutId: payout.id, success: true, transferCode: transferResult.transfer_code });
            console.log(`[BulkPayout] Transfer initiated: ${payout.reference} → ${transferResult.transfer_code}`);
          } else {
            // Transfer didn't get a code
            await prisma.agentPayout.update({
              where: { id: payout.id },
              data: {
                status: 'FAILED',
                failureReason: 'No transfer code received from Paystack'
              }
            });
            failedCount++;
            results.push({ payoutId: payout.id, success: false, error: 'No transfer code' });
          }
        }
        
      } catch (err) {
        console.error(`[BulkPayout] Batch ${batchIndex + 1} failed:`, err.message);
        
        // Mark all payouts in this batch as failed
        for (const payout of currentBatch) {
          await prisma.agentPayout.update({
            where: { id: payout.id },
            data: {
              status: 'FAILED',
              failureReason: `Bulk transfer failed: ${err.message}`
            }
          });
          failedCount++;
          results.push({ payoutId: payout.id, success: false, error: err.message });
        }
      }
    }

    // Update batch with results
    await prisma.payoutBatch.update({
      where: { id: batch.id },
      data: { successCount, failedCount }
    });

    console.log(`[BulkPayout] Complete: ${successCount} successful, ${failedCount} failed`);

    return {
      success: true,
      batchId: batch.id,
      processed: successCount,
      failed: failedCount,
      totalAmount,
      totalFees,
      results
    };
  },

  /**
   * Initiate transfer to Paystack (doesn't finalize - waits for webhook)
   */
  async initiateTransfer(payout, adminId) {
    // Amount to transfer is the net amount (after fee)
    const amountInPesewas = Math.round(payout.netAmount * 100);
    
    // Generate unique transfer reference per attempt to avoid Paystack duplicate rejection
    const transferRef = `${payout.reference}-${Date.now()}`;
    
    const transferData = {
      source: 'balance',
      amount: amountInPesewas,
      recipient: payout.recipientCode,
      reason: `Profit withdrawal - ${payout.reference}`,
      reference: transferRef
    };

    const transferResponse = await paystackRequest('/transfer', 'POST', transferData);
    
    const transferCode = transferResponse.data?.transfer_code;
    const paystackReference = transferResponse.data?.reference || transferRef;
    const transferStatus = transferResponse.data?.status;

    // Update payout status to PROCESSING
    await prisma.agentPayout.update({
      where: { id: payout.id },
      data: {
        status: 'PROCESSING',
        transferCode,
        paystackReference,
        processedAt: new Date()
      }
    });

    console.log(`[Payout] Transfer initiated: ${payout.reference} → ${transferCode} (status: ${transferStatus})`);

    return { 
      payoutId: payout.id, 
      success: true, 
      transferCode,
      status: transferStatus
    };
  },

  /**
   * Process a single withdrawal payout via Paystack (legacy - for single approvals)
   */
  async processSinglePayout(payout, adminId, otp = null) {
    // reviewedBy is a FK to User — only set it for valid UUIDs, not 'SYSTEM_AUTO'
    const reviewerId = adminId && adminId !== 'SYSTEM_AUTO' ? adminId : null;
    try {
      // Get or create recipient code
      const recipientCode = await this.getOrCreateRecipient({
        userId: payout.userId,
        accountName: payout.accountName,
        accountNumber: payout.accountNumber,
        bankCode: payout.bankCode
      });

      // Initiate transfer (net amount - after fee)
      const amountInPesewas = Math.round(payout.netAmount * 100);
      // Generate unique transfer reference per attempt to avoid Paystack duplicate rejection
      const transferRef = `${payout.reference}-${Date.now()}`;
      const transferData = {
        source: 'balance',
        amount: amountInPesewas,
        recipient: recipientCode,
        reason: `Profit withdrawal - ${payout.reference}`,
        reference: transferRef
      };

      const transferResponse = await paystackRequest('/transfer', 'POST', transferData);
      
      // Log the full transfer response for debugging
      console.log(`[Payout] Transfer response:`, JSON.stringify(transferResponse.data, null, 2));

      // If OTP is required and provided, finalize the transfer
      if (transferResponse.data?.status === 'otp' && otp) {
        await paystackRequest('/transfer/finalize_transfer', 'POST', {
          transfer_code: transferResponse.data.transfer_code,
          otp
        });
      } else if (transferResponse.data?.status === 'otp' && !otp) {
        // OTP required but not provided - return requiresOtp flag
        return { payoutId: payout.id, requiresOtp: true, transferCode: transferResponse.data?.transfer_code };
      }

      // IMMEDIATELY save transferCode + paystackReference so webhook can find this payout
      // This must happen BEFORE profit processing to prevent race conditions
      const transferStatus = transferResponse.data?.status?.toLowerCase();
      const isInstantSuccess = transferStatus === 'success';
      const finalStatus = isInstantSuccess ? 'COMPLETED' : 'PROCESSING';
      const savedTransferCode = transferResponse.data?.transfer_code;
      const savedPaystackRef = transferResponse.data?.reference || transferRef;

      await prisma.agentPayout.update({
        where: { id: payout.id },
        data: {
          status: finalStatus,
          processedAt: new Date(),
          reviewedBy: reviewerId,
          transferCode: savedTransferCode,
          paystackReference: savedPaystackRef,
          recipientCode
        }
      });

      console.log(`[Payout] Payout ${payout.reference} updated to ${finalStatus} (transferCode: ${savedTransferCode}, paystackRef: ${savedPaystackRef})`);

      // NOTE: Profit marking is handled ONLY by the webhook (handleTransferSuccess)
      // to prevent double-deduction when both this function and the webhook run.

      console.log(`[Payout] Processed ${payout.reference}: GH₵${payout.netAmount} to ${payout.accountNumber} (${finalStatus})`);

      return { payoutId: payout.id, success: true, transferCode: savedTransferCode, status: finalStatus };

    } catch (err) {
      // Mark as failed
      await prisma.agentPayout.update({
        where: { id: payout.id },
        data: {
          status: 'FAILED',
          processedAt: new Date(),
          reviewedBy: reviewerId,
          failureReason: err.message
        }
      });

      return { payoutId: payout.id, success: false, error: err.message };
    }
  },

  /**
   * Approve single withdrawal (admin)
   */
  async approveSingleWithdrawal(payoutId, adminId, otp = null) {
    const payout = await prisma.agentPayout.findUnique({ where: { id: payoutId } });

    if (!payout) throw new Error('Withdrawal request not found');
    if (payout.status !== 'PENDING') throw new Error('Request is not pending');

    return this.processSinglePayout(payout, adminId, otp);
  },

  /**
   * Reject withdrawal (admin)
   */
  async rejectWithdrawal(payoutId, adminId, reason = 'Rejected by admin') {
    const payout = await prisma.agentPayout.findUnique({ where: { id: payoutId } });

    if (!payout) throw new Error('Withdrawal request not found');
    if (payout.status !== 'PENDING') throw new Error('Request is not pending');

    return prisma.agentPayout.update({
      where: { id: payoutId },
      data: {
        status: 'REJECTED',
        processedAt: new Date(),
        reviewedBy: adminId,
        reviewNotes: reason
      }
    });
  },

  /**
   * Force complete a stuck PROCESSING withdrawal (admin)
   * Use this when webhook didn't arrive but you've verified the transfer succeeded
   */
  async forceCompleteWithdrawal(payoutId, adminId) {
    const payout = await prisma.agentPayout.findUnique({
      where: { id: payoutId },
      include: { user: { select: { id: true, name: true, phone: true, momoNumber: true } } }
    });

    if (!payout) throw new Error('Withdrawal request not found');
    const oldStatus = payout.status;
    if (oldStatus !== 'PROCESSING' && oldStatus !== 'RESERVED') {
      throw new Error(`Cannot force complete - status is ${oldStatus} (must be PROCESSING or RESERVED)`);
    }

    // Mark profits as PAID
    const profits = await prisma.pendingProfit.findMany({
      where: { userId: payout.userId, status: 'PENDING' },
      orderBy: { createdAt: 'asc' }
    });

    let remaining = payout.amount;
    const profitIdsToMark = [];
    let partialProfitId = null;
    let partialDeduction = 0;
    for (const profit of profits) {
      if (remaining <= 0) break;
      if (profit.amount <= remaining) {
        profitIdsToMark.push(profit.id);
        remaining -= profit.amount;
      } else {
        partialProfitId = profit.id;
        partialDeduction = remaining;
        remaining = 0;
      }
    }

    await prisma.$transaction([
      prisma.agentPayout.update({
        where: { id: payoutId },
        data: {
          status: 'COMPLETED',
          processedAt: new Date(),
          reviewedBy: adminId,
          reviewNotes: 'Force completed by admin - webhook may not have arrived'
        }
      }),
      ...(profitIdsToMark.length > 0 ? [prisma.pendingProfit.updateMany({
        where: { id: { in: profitIdsToMark } },
        data: { status: 'PAID', paidAt: new Date() }
      })] : []),
      ...(partialProfitId ? [prisma.pendingProfit.update({
        where: { id: partialProfitId },
        data: { amount: { decrement: partialDeduction } }
      })] : [])
    ]);

    console.log(`[Admin] Force completed withdrawal ${payoutId}: GH₵${payout.netAmount}`);

    // Audit log
    await auditService.logPayoutForceComplete({
      adminId,
      payoutId,
      oldStatus,
      reference: payout.reference,
      agentId: payout.userId,
      amount: payout.netAmount
    });

    // Send SMS notification to agent
    try {
      const agentPhone = payout.user?.momoNumber || payout.user?.phone;
      if (agentPhone) {
        await smsService.sendPayoutCompletedSMS(
          agentPhone,
          payout.user?.name,
          payout.netAmount,
          payout.reference
        );
      }
    } catch (smsError) {
      console.error('[Admin] SMS notification failed:', smsError.message);
    }

    return { payoutId, amount: payout.netAmount, profitsMarked: profitIdsToMark.length };
  },

  /**
   * Force cancel a stuck PROCESSING withdrawal (admin)
   * Use this when transfer failed but webhook didn't arrive, or to reset stuck requests
   */
  async forceCancelWithdrawal(payoutId, adminId, reason = 'Force cancelled by admin') {
    const payout = await prisma.agentPayout.findUnique({
      where: { id: payoutId },
      include: { user: { select: { id: true, name: true, phone: true, momoNumber: true } } }
    });

    if (!payout) throw new Error('Withdrawal request not found');
    const oldStatus = payout.status;
    if (oldStatus !== 'PROCESSING' && oldStatus !== 'RESERVED') {
      throw new Error(`Cannot force cancel - status is ${oldStatus} (must be PROCESSING or RESERVED)`);
    }

    // Mark as FAILED so user can request again
    await prisma.agentPayout.update({
      where: { id: payoutId },
      data: {
        status: 'FAILED',
        processedAt: new Date(),
        reviewedBy: adminId,
        reviewNotes: reason,
        failureReason: reason
      }
    });

    console.log(`[Admin] Force cancelled withdrawal ${payoutId}: ${reason}`);

    // Audit log
    await auditService.logPayoutForceCancel({
      adminId,
      payoutId,
      oldStatus,
      reference: payout.reference,
      agentId: payout.userId,
      amount: payout.amount,
      reason
    });

    // Create alert for tracking
    await alertService.payoutFailed({
      payoutId,
      reference: payout.reference,
      agentName: payout.user?.name || 'Unknown',
      amount: payout.amount,
      reason: `Force cancelled: ${reason}`
    });

    // Send SMS notification to agent about cancellation
    try {
      const agentPhone = payout.user?.momoNumber || payout.user?.phone;
      if (agentPhone) {
        await smsService.sendPayoutFailedSMS(
          agentPhone,
          payout.user?.name,
          payout.amount,
          reason || 'Request was cancelled'
        );
      }
    } catch (smsError) {
      console.error('[Admin] SMS notification failed:', smsError.message);
    }

    return { payoutId, amount: payout.amount, message: 'User can now request a new withdrawal' };
  },

  /**
   * Get batch history (admin)
   */
  async getBatchHistory({ page = 1, limit = 20 } = {}) {
    const skip = (page - 1) * limit;

    const [batches, total] = await Promise.all([
      prisma.payoutBatch.findMany({
        orderBy: { processedAt: 'desc' },
        skip,
        take: limit
      }),
      prisma.payoutBatch.count()
    ]);

    return { batches, pagination: { page, limit, total, pages: Math.ceil(total / limit) } };
  },

  /**
   * Get profits by user (admin view)
   */
  async getProfitsByUser() {
    const result = await prisma.pendingProfit.groupBy({
      by: ['userId'],
      where: { status: 'PENDING' },
      _sum: { amount: true },
      _count: true
    });

    const userIds = result.map(r => r.userId);
    const users = await prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, name: true, email: true, phone: true }
    });

    const userMap = Object.fromEntries(users.map(u => [u.id, u]));
    const settings = getPayoutSettings();

    return result.map(r => ({
      user: userMap[r.userId],
      totalAmount: r._sum.amount || 0,
      profitCount: r._count || 0,
      meetsMinimum: (r._sum.amount || 0) >= settings.minPayout
    })).sort((a, b) => b.totalAmount - a.totalAmount);
  },

  /**
   * Process batch payout - credit all pending profits to users' wallets
   */
  async processBatchPayout(adminId) {
    const settings = getPayoutSettings();
    
    // Get all users with pending profits above minimum
    const profitsByUser = await prisma.pendingProfit.groupBy({
      by: ['userId'],
      where: { status: 'PENDING' },
      _sum: { amount: true },
      _count: true
    });

    const eligibleUsers = profitsByUser.filter(u => (u._sum.amount || 0) >= settings.minPayout);
    
    if (eligibleUsers.length === 0) {
      return { processed: 0, totalAmount: 0, message: 'No users with pending profits above minimum threshold' };
    }

    let processed = 0;
    let totalAmount = 0;
    const errors = [];

    for (const userProfit of eligibleUsers) {
      try {
        const amount = userProfit._sum.amount || 0;
        
        // Credit to wallet
        await prisma.wallet.update({
          where: { userId: userProfit.userId },
          data: { balance: { increment: amount } }
        });

        // Record wallet transaction
        await prisma.walletTransaction.create({
          data: {
            walletId: (await prisma.wallet.findUnique({ where: { userId: userProfit.userId } })).id,
            amount: amount,
            type: 'CREDIT',
            description: `Profit payout - ${userProfit._count} orders`,
            reference: `PROFIT-BATCH-${Date.now()}-${userProfit.userId.slice(0, 8)}`
          }
        });

        // Mark all pending profits as credited
        await prisma.pendingProfit.updateMany({
          where: { userId: userProfit.userId, status: 'PENDING' },
          data: { 
            status: 'PAID',
            paidAt: new Date()
          }
        });

        processed++;
        totalAmount += amount;
        console.log(`[Payout] Credited GH₵${amount.toFixed(2)} to user ${userProfit.userId}`);
      } catch (err) {
        console.error(`[Payout] Error crediting user ${userProfit.userId}:`, err.message);
        errors.push({ userId: userProfit.userId, error: err.message });
      }
    }

    return {
      processed,
      totalAmount,
      failed: errors.length,
      errors: errors.length > 0 ? errors : undefined,
      message: `Batch processed: ${processed} users paid GH₵${totalAmount.toFixed(2)}`
    };
  },

  // ============================================================
  // MANUAL PAYOUT COMPLETION
  // ============================================================

  /**
   * Manually complete a payout (admin paid externally)
   * Used when Paystack is unavailable or for cash/bank payments
   */
  async manualComplete({ payoutId, paymentMethod, externalReference, note, adminId }) {
    console.log(`[Payout] Manual completion requested for payout ${payoutId}`);

    // Find the payout
    const payout = await prisma.agentPayout.findUnique({
      where: { id: payoutId },
      include: { user: { select: { id: true, name: true, phone: true, momoNumber: true } } }
    });

    if (!payout) {
      throw new Error('Payout not found');
    }

    // Check valid statuses for manual completion
    const validStatuses = ['PENDING', 'APPROVED', 'RESERVED', 'PROCESSING', 'FAILED'];
    if (!validStatuses.includes(payout.status)) {
      throw new Error(`Cannot manually complete payout with status: ${payout.status}`);
    }

    // Prevent duplicate completion
    if (payout.status === 'COMPLETED') {
      throw new Error('Payout already completed');
    }

    const oldStatus = payout.status;

    // Mark profits as paid
    const profits = await prisma.pendingProfit.findMany({
      where: { userId: payout.userId, status: 'PENDING' },
      orderBy: { createdAt: 'asc' }
    });

    let remaining = payout.amount;
    const profitIdsToMark = [];
    let partialProfitId = null;
    let partialDeduction = 0;
    for (const profit of profits) {
      if (remaining <= 0) break;
      if (profit.amount <= remaining) {
        profitIdsToMark.push(profit.id);
        remaining -= profit.amount;
      } else {
        partialProfitId = profit.id;
        partialDeduction = remaining;
        remaining = 0;
      }
    }

    // Finalize payout with manual completion data
    await prisma.$transaction([
      prisma.agentPayout.update({
        where: { id: payout.id },
        data: {
          status: 'COMPLETED',
          processedAt: new Date(),
          reviewedBy: adminId,
          manualPayment: true,
          manualPaymentMethod: paymentMethod,
          manualReference: externalReference,
          manualNote: note
        }
      }),
      ...(profitIdsToMark.length > 0 ? [prisma.pendingProfit.updateMany({
        where: { id: { in: profitIdsToMark } },
        data: { status: 'PAID', paidAt: new Date() }
      })] : []),
      ...(partialProfitId ? [prisma.pendingProfit.update({
        where: { id: partialProfitId },
        data: { amount: { decrement: partialDeduction } }
      })] : [])
    ]);

    console.log(`[Payout] ✅ Manually completed payout ${payout.reference}: GH₵${payout.netAmount} via ${paymentMethod}`);

    // Audit log
    await auditService.logPayoutComplete({
      payoutId: payout.id,
      oldStatus,
      reference: payout.reference,
      agentId: payout.userId,
      amount: payout.netAmount,
      completedVia: `manual_${paymentMethod}`,
      adminId,
      note: `External ref: ${externalReference || 'N/A'}. ${note || ''}`
    });

    // Send SMS notification to agent
    try {
      const agentPhone = payout.user?.momoNumber || payout.user?.phone;
      if (agentPhone) {
        await smsService.sendPayoutCompletedSMS(
          agentPhone,
          payout.user?.name,
          payout.netAmount,
          payout.reference
        );
      }
    } catch (smsError) {
      console.error('[Payout] SMS notification failed:', smsError.message);
    }

    return { 
      success: true, 
      payoutId: payout.id, 
      amount: payout.netAmount,
      paymentMethod,
      reference: externalReference,
      agentName: payout.user?.name
    };
  },

  // ============================================================
  // WEBHOOK HANDLERS
  // ============================================================

  /**
   * Handle transfer.success webhook from Paystack
   * Finalizes the payout and marks profits as paid
   */
  async handleTransferSuccess(transferData) {
    const { reference, transfer_code } = transferData;
    
    console.log(`[Webhook] Transfer success: ${reference} (${transfer_code})`);

    // Build search conditions — skip null values to avoid matching wrong records
    const orConditions = [];
    if (reference) {
      orConditions.push({ reference });
      orConditions.push({ paystackReference: reference });
    }
    if (transfer_code) {
      orConditions.push({ transferCode: transfer_code });
    }

    let payout = null;
    if (orConditions.length > 0) {
      payout = await prisma.agentPayout.findFirst({
        where: { OR: orConditions },
        include: { user: { select: { id: true, name: true, phone: true, momoNumber: true } } }
      });
    }

    // Fallback: if reference looks like "WD-xxx-timestamp", try matching by the base reference
    if (!payout && reference) {
      const baseRef = reference.replace(/-\d{13,}$/, '');
      if (baseRef !== reference) {
        payout = await prisma.agentPayout.findFirst({
          where: { reference: baseRef },
          include: { user: { select: { id: true, name: true, phone: true, momoNumber: true } } }
        });
      }
    }

    if (!payout) {
      console.log(`[Webhook] No payout found for reference: ${reference} / transfer_code: ${transfer_code}`);
      return { success: false, message: 'Payout not found' };
    }
    
    console.log(`[Webhook] Found payout: ${payout.reference} (status: ${payout.status}, transferCode: ${payout.transferCode})`);
    
    // If already completed, just acknowledge
    if (payout.status === 'COMPLETED') {
      console.log(`[Webhook] Payout ${reference} already COMPLETED`);
      return { success: true, message: 'Already completed' };
    }

    // Prevent duplicate processing
    if (payout.webhookReceived) {
      console.log(`[Webhook] Already processed: ${reference}`);
      return { success: true, message: 'Already processed' };
    }

    const oldStatus = payout.status;

    // Mark profits as paid
    const profits = await prisma.pendingProfit.findMany({
      where: { userId: payout.userId, status: 'PENDING' },
      orderBy: { createdAt: 'asc' }
    });

    let remaining = payout.amount;
    const profitIdsToMark = [];
    let partialProfitId = null;
    let partialDeduction = 0;
    for (const profit of profits) {
      if (remaining <= 0) break;
      if (profit.amount <= remaining) {
        profitIdsToMark.push(profit.id);
        remaining -= profit.amount;
      } else {
        partialProfitId = profit.id;
        partialDeduction = remaining;
        remaining = 0;
      }
    }

    // Finalize payout
    await prisma.$transaction([
      prisma.agentPayout.update({
        where: { id: payout.id },
        data: {
          status: 'COMPLETED',
          webhookReceived: true,
          webhookData: JSON.stringify(transferData)
        }
      }),
      ...(profitIdsToMark.length > 0 ? [prisma.pendingProfit.updateMany({
        where: { id: { in: profitIdsToMark } },
        data: { status: 'PAID', paidAt: new Date() }
      })] : []),
      ...(partialProfitId ? [prisma.pendingProfit.update({
        where: { id: partialProfitId },
        data: { amount: { decrement: partialDeduction } }
      })] : [])
    ]);

    console.log(`[Webhook] Finalized payout ${payout.reference}: GH₵${payout.netAmount}`);

    // Audit log
    await auditService.logPayoutComplete({
      payoutId: payout.id,
      oldStatus,
      reference: payout.reference,
      agentId: payout.userId,
      amount: payout.netAmount,
      completedVia: 'webhook'
    });

    // Send SMS notification to agent
    try {
      const agentPhone = payout.user?.momoNumber || payout.user?.phone;
      if (agentPhone) {
        await smsService.sendPayoutCompletedSMS(
          agentPhone,
          payout.user?.name,
          payout.netAmount,
          payout.reference
        );
      }
    } catch (smsError) {
      console.error('[Webhook] SMS notification failed:', smsError.message);
      // Don't fail the webhook for SMS errors
    }

    return { success: true, payoutId: payout.id, amount: payout.netAmount };
  },

  /**
   * Handle transfer.failed webhook from Paystack
   * Restores the payout to PENDING and unreserves profits
   */
  async handleTransferFailed(transferData) {
    const { reference, transfer_code, reason } = transferData;
    
    console.log(`[Webhook] Transfer failed: ${reference} - ${reason}`);

    // Build search conditions — skip null values to avoid matching wrong records
    const orConditions = [];
    if (reference) {
      orConditions.push({ reference });
      orConditions.push({ paystackReference: reference });
    }
    if (transfer_code) {
      orConditions.push({ transferCode: transfer_code });
    }

    let payout = null;
    if (orConditions.length > 0) {
      payout = await prisma.agentPayout.findFirst({
        where: {
          OR: orConditions,
          status: { in: ['PROCESSING', 'RESERVED'] }
        },
        include: { user: { select: { id: true, name: true, phone: true, momoNumber: true } } }
      });
    }

    // Fallback: try matching by base reference
    if (!payout && reference) {
      const baseRef = reference.replace(/-\d{13,}$/, '');
      if (baseRef !== reference) {
        payout = await prisma.agentPayout.findFirst({
          where: { reference: baseRef, status: { in: ['PROCESSING', 'RESERVED'] } },
          include: { user: { select: { id: true, name: true, phone: true, momoNumber: true } } }
        });
      }
    }

    if (!payout) {
      console.log(`[Webhook] No pending payout found for reference: ${reference} / transfer_code: ${transfer_code}`);
      return { success: false, message: 'Payout not found' };
    }

    // Prevent duplicate processing
    if (payout.webhookReceived) {
      console.log(`[Webhook] Already processed: ${reference}`);
      return { success: true, message: 'Already processed' };
    }

    const oldStatus = payout.status;

    // Mark payout as failed
    await prisma.agentPayout.update({
      where: { id: payout.id },
      data: {
        status: 'FAILED',
        failureReason: reason || 'Transfer failed',
        webhookReceived: true,
        webhookData: JSON.stringify(transferData)
      }
    });

    console.log(`[Webhook] Payout failed ${payout.reference}: ${reason}`);

    // Audit log
    await auditService.logPayoutFail({
      payoutId: payout.id,
      oldStatus,
      reference: payout.reference,
      agentId: payout.userId,
      amount: payout.amount,
      failureReason: reason || 'Transfer failed',
      failedVia: 'webhook'
    });

    // Create alert for admin
    await alertService.payoutFailed({
      payoutId: payout.id,
      reference: payout.reference,
      agentName: payout.user?.name || 'Unknown',
      amount: payout.amount,
      reason: reason || 'Transfer failed'
    });

    // Send SMS notification to agent about failure
    try {
      const agentPhone = payout.user?.momoNumber || payout.user?.phone;
      if (agentPhone) {
        await smsService.sendPayoutFailedSMS(
          agentPhone,
          payout.user?.name,
          payout.amount,
          reason || 'Transfer could not be completed'
        );
      }
    } catch (smsError) {
      console.error('[Webhook] SMS notification failed:', smsError.message);
    }

    return { success: true, payoutId: payout.id, failed: true };
  },

  /**
   * Handle transfer.reversed webhook from Paystack
   */
  async handleTransferReversed(transferData) {
    const { reference, transfer_code, reason } = transferData;
    
    console.log(`[Webhook] Transfer reversed: ${reference} - ${reason}`);

    // Build search conditions — skip null values to avoid matching wrong records
    const orConditions = [];
    if (reference) {
      orConditions.push({ reference });
      orConditions.push({ paystackReference: reference });
    }
    if (transfer_code) {
      orConditions.push({ transferCode: transfer_code });
    }

    let payout = null;
    if (orConditions.length > 0) {
      payout = await prisma.agentPayout.findFirst({
        where: { OR: orConditions },
        include: { user: { select: { name: true } } }
      });
    }

    // Fallback: try matching by base reference
    if (!payout && reference) {
      const baseRef = reference.replace(/-\d{13,}$/, '');
      if (baseRef !== reference) {
        payout = await prisma.agentPayout.findFirst({
          where: { reference: baseRef },
          include: { user: { select: { name: true } } }
        });
      }
    }

    if (!payout) {
      console.log(`[Webhook] No payout found for reference: ${reference} / transfer_code: ${transfer_code}`);
      return { success: false, message: 'Payout not found' };
    }

    const oldStatus = payout.status;

    // Mark payout as failed and restore profits
    if (payout.status === 'COMPLETED') {
      // This is a reversal of successful transfer - need to restore profits
      console.log(`[Webhook] Reversing completed payout ${payout.reference}`);
      
      // TODO: Restore profits - this is a complex case
      // For now, just mark it as failed with clear reason
    }

    await prisma.agentPayout.update({
      where: { id: payout.id },
      data: {
        status: 'FAILED',
        failureReason: `REVERSED: ${reason || 'Transfer reversed by Paystack'}`,
        webhookData: JSON.stringify(transferData)
      }
    });

    // Audit log
    await auditService.logPayoutFail({
      payoutId: payout.id,
      oldStatus,
      reference: payout.reference,
      agentId: payout.userId,
      amount: payout.amount,
      failureReason: `REVERSED: ${reason || 'Transfer reversed'}`,
      failedVia: 'webhook_reversal'
    });

    // Create critical alert for reversal
    await alertService.create({
      type: 'PAYOUT_FAILED',
      severity: 'CRITICAL',
      title: 'Payout Reversed by Paystack',
      message: `Payout ${payout.reference} was reversed after completion. Agent: ${payout.user?.name}, Amount: GH₵${payout.amount.toFixed(2)}`,
      entityType: 'AgentPayout',
      entityId: payout.id,
      metadata: { reference: payout.reference, reason, originalStatus: oldStatus }
    });

    return { success: true, payoutId: payout.id, reversed: true };
  },

  /**
   * Get transfer fee information for display
   */
  getTransferFeeInfo() {
    return {
      momoFee: PAYSTACK_MOMO_FEE,
      feeType: 'flat',
      currency: 'GHS',
      description: `GH₵${PAYSTACK_MOMO_FEE.toFixed(2)} per MoMo transfer`
    };
  },

  /**
   * Get agent profits summary for admin view
   * Shows: Agent, Total Profit, This Month, Available for Withdrawal
   * When date filter is applied, filters by the ORDER's creation date (when profit was actually earned)
   */
  async getAgentProfitsSummary({ startDate, endDate } = {}) {
    // Build date filter - use UTC consistently to avoid timezone issues
    const hasDateFilter = Boolean(startDate || endDate);
    let dateFilterStart = null;
    let dateFilterEnd = null;
    
    console.log('[AgentProfits] Request params:', { startDate, endDate, hasDateFilter });
    
    if (startDate) {
      // Parse as start of day in UTC
      dateFilterStart = new Date(startDate + 'T00:00:00.000Z');
    }
    if (endDate) {
      // Parse as end of day in UTC
      dateFilterEnd = new Date(endDate + 'T23:59:59.999Z');
    }
    
    console.log('[AgentProfits] Parsed dates:', { dateFilterStart, dateFilterEnd });

    // Get all agents (non-admin users)
    const agents = await prisma.user.findMany({
      where: { role: { not: 'ADMIN' } },
      select: { id: true, name: true, phone: true, email: true, role: true }
    });

    // Get this month's date range (UTC)
    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
    const monthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0, 23, 59, 59, 999));

    // Get profit data for all agents
    const results = await Promise.all(agents.map(async (agent) => {
      // Get agent's storefront IDs (needed for all profit queries)
      const sfIds = (await prisma.storefront.findMany({
        where: { ownerId: agent.id },
        select: { id: true }
      })).map(s => s.id);

      // When date filter is applied, filter by the associated order's createdAt date
      let filteredProfitResult = { _sum: { amount: null } };
      
      if (hasDateFilter && sfIds.length > 0) {
        const orderProfitResult = await prisma.storefrontOrder.aggregate({
          where: {
            storefrontId: { in: sfIds },
            status: { in: ['COMPLETED', 'PROCESSING'] },
            createdAt: {
              ...(dateFilterStart && { gte: dateFilterStart }),
              ...(dateFilterEnd && { lte: dateFilterEnd })
            }
          },
          _sum: { ownerProfit: true }
        });
        filteredProfitResult = { _sum: { amount: orderProfitResult._sum.ownerProfit } };
      }

      // Total profit (all-time) from StorefrontOrder - the true source of truth
      // PendingProfit amounts get mutated by partial withdrawals, so we use orders instead
      const totalProfitResult = sfIds.length > 0 ? await prisma.storefrontOrder.aggregate({
        where: {
          storefrontId: { in: sfIds },
          status: { in: ['COMPLETED', 'PROCESSING'] }
        },
        _sum: { ownerProfit: true }
      }) : { _sum: { ownerProfit: null } };

      // This month's profit from StorefrontOrder
      const monthProfitResult = sfIds.length > 0 ? await prisma.storefrontOrder.aggregate({
        where: {
          storefrontId: { in: sfIds },
          status: { in: ['COMPLETED', 'PROCESSING'] },
          createdAt: { gte: monthStart, lte: monthEnd }
        },
        _sum: { ownerProfit: true }
      }) : { _sum: { ownerProfit: null } };

      // Withdrawal totals and wallet balance
      const [pendingWithdrawals, completedWithdrawals, walletData, orderCount, adjustmentSum] = await Promise.all([
        prisma.agentPayout.aggregate({
          where: {
            userId: agent.id,
            status: { in: ['PENDING', 'RESERVED', 'PROCESSING'] }
          },
          _sum: { amount: true }
        }),
        // Total successfully withdrawn (completed payouts)
        prisma.agentPayout.aggregate({
          where: {
            userId: agent.id,
            status: 'COMPLETED'
          },
          _sum: { amount: true }
        }),
        // Wallet balance
        prisma.wallet.findUnique({
          where: { userId: agent.id },
          select: { balance: true }
        }),
        // Total completed orders count
        prisma.storefrontOrder.count({
          where: {
            storefront: { ownerId: agent.id },
            status: { in: ['COMPLETED', 'PROCESSING'] }
          }
        }),
        // Admin profit adjustments total
        prisma.adminProfitAdjustment.aggregate({
          where: { userId: agent.id },
          _sum: { amount: true }
        })
      ]);
      
      const reservedForWithdrawal = pendingWithdrawals._sum.amount || 0;
      const totalWithdrawn = completedWithdrawals._sum.amount || 0;
      const allTimeProfit = totalProfitResult._sum.ownerProfit || 0;
      const adminAdjustment = adjustmentSum._sum.amount || 0;
      // Available = totalProfit - withdrawn - pendingWithdrawals + adminAdjustment
      const availableForWithdrawal = Math.max(0, allTimeProfit - totalWithdrawn - reservedForWithdrawal + adminAdjustment);
      const walletBalance = walletData?.balance || 0;

      return {
        id: agent.id,
        name: agent.name,
        phone: agent.phone,
        email: agent.email,
        role: agent.role,
        // When filtering by date, show filtered profit; otherwise show all-time total from orders
        totalProfit: hasDateFilter 
          ? (filteredProfitResult._sum.amount || 0)
          : (totalProfitResult._sum.ownerProfit || 0),
        allTimeProfit: allTimeProfit,
        thisMonthProfit: monthProfitResult._sum.ownerProfit || 0,
        availableForWithdrawal,
        reservedForWithdrawal,
        totalWithdrawn,
        adminAdjustment,
        walletBalance,
        totalOrders: orderCount
      };
    }));

    // Filter out agents based on activity
    // When date filter: show agents with profit in that period OR available balance
    // Otherwise: show agents with any profit OR available balance
    const filtered = results
      .filter(a => {
        if (hasDateFilter) {
          return a.totalProfit > 0 || a.availableForWithdrawal > 0;
        }
        return a.allTimeProfit > 0 || a.availableForWithdrawal > 0;
      })
      .sort((a, b) => b.totalProfit - a.totalProfit);

    // Calculate totals
    const totals = filtered.reduce((acc, a) => ({
      totalProfit: acc.totalProfit + a.totalProfit,
      thisMonthProfit: acc.thisMonthProfit + a.thisMonthProfit,
      availableForWithdrawal: acc.availableForWithdrawal + a.availableForWithdrawal,
      totalWithdrawn: acc.totalWithdrawn + a.totalWithdrawn,
      reservedForWithdrawal: acc.reservedForWithdrawal + a.reservedForWithdrawal,
      totalOrders: acc.totalOrders + a.totalOrders,
      totalWalletBalance: acc.totalWalletBalance + a.walletBalance
    }), { totalProfit: 0, thisMonthProfit: 0, availableForWithdrawal: 0, totalWithdrawn: 0, reservedForWithdrawal: 0, totalOrders: 0, totalWalletBalance: 0 });

    return {
      agents: filtered,
      totals,
      dateFilter: hasDateFilter ? { startDate, endDate } : null
    };
  }
};

module.exports = profitPayoutService;
