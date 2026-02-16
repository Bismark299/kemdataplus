/**
 * PAYSTACK PAYMENT SERVICE
 * ========================
 * Handles payment initialization, verification, and webhook processing
 * for auto-deposit to user wallets.
 * 
 * API Docs: https://paystack.com/docs/api/
 */

const { PrismaClient } = require('@prisma/client');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const prisma = new PrismaClient();

// Get Paystack config from settings or env
function getPaystackConfig() {
  // Check environment variables first
  if (process.env.PAYSTACK_SECRET_KEY) {
    return {
      secretKey: process.env.PAYSTACK_SECRET_KEY,
      publicKey: process.env.PAYSTACK_PUBLIC_KEY || ''
    };
  }
  
  // Fallback to settings.json
  try {
    const settingsPath = path.join(__dirname, '../../settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    return {
      secretKey: settings.adminSettings?.paystackSecretKey || '',
      publicKey: settings.adminSettings?.paystackPublicKey || ''
    };
  } catch (e) {
    console.error('[Paystack] Error reading config:', e.message);
    return { secretKey: '', publicKey: '' };
  }
}

// Make API request to Paystack
async function paystackRequest(endpoint, method = 'GET', body = null) {
  const config = getPaystackConfig();
  const url = `https://api.paystack.co${endpoint}`;
  
  // Validate key is present (don't log actual key values)
  if (!config.secretKey) {
    console.error('[Paystack] Secret key not configured');
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
    console.error('[Paystack] API Error:', data);
    console.error(`[Paystack] Status: ${response.status}, Message: ${data.message}`);
    throw new Error(data.message || `Paystack API Error: ${response.status}`);
  }
  
  return data;
}

const paystackService = {
  /**
   * Get public key for frontend
   */
  getPublicKey() {
    return getPaystackConfig().publicKey;
  },

  /**
   * Initialize a payment transaction
   * @param {string} email - Customer email
   * @param {number} amount - Total amount in GHS (includes fee)
   * @param {number} subtotal - Original amount (what's credited to wallet)
   * @param {number} processingFee - The 1.5% fee
   * @param {string} userId - User ID for reference
   * @param {string} callbackUrl - URL to redirect after payment
   */
  async initializePayment({ email, amount, subtotal, processingFee, userId, callbackUrl }) {
    // Amount must be in pesewas (kobo equivalent) - this is the TOTAL customer pays
    const amountInPesewas = Math.round(amount * 100);
    
    // The subtotal is what gets credited to wallet
    const creditAmount = subtotal || amount;
    
    // Generate unique reference
    const reference = `KDP_${userId.slice(0, 8)}_${Date.now()}`;
    
    const response = await paystackRequest('/transaction/initialize', 'POST', {
      email,
      amount: amountInPesewas,
      currency: 'GHS',
      reference,
      callback_url: callbackUrl,
      metadata: {
        userId,
        type: 'wallet_topup',
        amountGHS: creditAmount,          // This is the SUBTOTAL - what gets credited
        totalPaidGHS: amount,             // Total customer paid
        processingFeeGHS: processingFee || 0
      }
    });
    
    // Store pending payment in database (store subtotal, not total)
    await prisma.pendingPayment.create({
      data: {
        reference,
        userId,
        amount: creditAmount,  // Store subtotal - what will be credited
        status: 'PENDING',
        provider: 'PAYSTACK',
        metadata: JSON.stringify({ email, totalPaid: amount, processingFee: processingFee || 0 })
      }
    });
    
    console.log(`[Paystack] Payment initialized: ${reference} for ${amount} GHS (credit: ${creditAmount}, fee: ${processingFee || 0})`);
    
    return {
      success: true,
      reference,
      authorizationUrl: response.data.authorization_url,
      accessCode: response.data.access_code
    };
  },

  /**
   * Verify a payment transaction
   * @param {string} reference - Payment reference
   */
  async verifyPayment(reference) {
    const response = await paystackRequest(`/transaction/verify/${reference}`);
    
    return {
      success: response.data.status === 'success',
      status: response.data.status,
      amount: response.data.amount / 100, // Convert back to GHS
      reference: response.data.reference,
      metadata: response.data.metadata,
      paidAt: response.data.paid_at,
      channel: response.data.channel
    };
  },

  /**
   * Verify webhook signature
   * @param {string} body - Raw request body
   * @param {string} signature - X-Paystack-Signature header
   */
  verifyWebhookSignature(body, signature) {
    const config = getPaystackConfig();
    
    // Debug logging - remove after fixing
    // Validate secret key exists (never log key values)
    if (!config.secretKey) {
      console.error('[Paystack] Cannot verify signature - secret key not configured');
      return false;
    }
    console.log(`[Paystack] Signature received: ${signature?.substring(0, 20)}...`);
    
    const hash = crypto
      .createHmac('sha512', config.secretKey)
      .update(body)
      .digest('hex');
    
    console.log(`[Paystack] Computed hash: ${hash.substring(0, 20)}...`);
    
    return hash === signature;
  },

  /**
   * Process webhook event and credit wallet if successful
   * @param {object} event - Webhook event data
   */
  async processWebhook(event) {
    console.log(`[Paystack] Webhook event: ${event.event}`);
    
    if (event.event !== 'charge.success') {
      console.log(`[Paystack] Ignoring event: ${event.event}`);
      return { processed: false, reason: 'Not a charge.success event' };
    }
    
    const { reference, amount, metadata, paid_at } = event.data;
    
    // ========================================
    // STOREFRONT ORDER HANDLING
    // ========================================
    // If this is a storefront payment, handle it separately
    if (metadata?.type === 'storefront_order' && metadata?.storefrontOrderId) {
      console.log(`[Paystack] 🛒 Storefront payment detected for order ${metadata.storefrontOrderId}`);
      
      // First mark payment as paid
      const paymentResult = await this.processStorefrontPayment(event.data);
      
      if (paymentResult.processed || paymentResult.reason === 'Already paid') {
        // Now complete the order and trigger API fulfillment
        try {
          const storefrontService = require('./storefront.service');
          const completionResult = await storefrontService.completePaystackOrder(
            metadata.storefrontOrderId,
            reference
          );
          
          console.log(`[Paystack] ✅ Storefront order completed via webhook: ${metadata.storefrontOrderId}`);
          
          return {
            processed: true,
            type: 'storefront_order',
            storefrontOrderId: metadata.storefrontOrderId,
            orderId: completionResult?.orderId,
            reference
          };
        } catch (completionError) {
          // Order might already be completed (via frontend verify) - that's OK
          if (completionError.message?.includes('already completed')) {
            console.log(`[Paystack] Storefront order already completed: ${metadata.storefrontOrderId}`);
            return { processed: false, reason: 'Already completed' };
          }
          console.error(`[Paystack] Error completing storefront order:`, completionError.message);
          return { processed: true, reason: 'Payment confirmed but completion failed' };
        }
      }
      
      return paymentResult;
    }
    
    // ========================================
    // WALLET TOP-UP HANDLING (original logic)
    // ========================================
    // Use metadata.amountGHS (subtotal) if available, otherwise calculate from pesewas
    // This ensures we credit the original amount, not the amount + fee
    // Parse as float since Paystack metadata returns strings
    const amountGHS = parseFloat(metadata?.amountGHS) || (amount / 100);
    
    // Check if already processed (idempotency) - check both PendingPayment and Transaction
    const existingPayment = await prisma.pendingPayment.findUnique({
      where: { reference }
    });
    
    if (existingPayment?.status === 'COMPLETED') {
      console.log(`[Paystack] Payment ${reference} already processed (PendingPayment)`);
      return { processed: false, reason: 'Already processed' };
    }
    
    // Also check Transaction table for duplicate
    const existingTransaction = await prisma.transaction.findUnique({
      where: { reference: `PS_${reference}` }
    });
    
    if (existingTransaction) {
      console.log(`[Paystack] Payment ${reference} already has transaction record`);
      return { processed: false, reason: 'Transaction already exists' };
    }
    
    // Get user from metadata
    const userId = metadata?.userId;
    if (!userId) {
      console.error(`[Paystack] No userId in metadata for ${reference}`);
      return { processed: false, reason: 'No userId in metadata' };
    }
    
    // Credit wallet in a transaction
    try {
      await prisma.$transaction(async (tx) => {
        // Get or create wallet
        let wallet = await tx.wallet.findUnique({ where: { userId } });
        
        if (!wallet) {
          wallet = await tx.wallet.create({
            data: { userId, balance: 0 }
          });
        }
        
        // Credit wallet
        await tx.wallet.update({
          where: { id: wallet.id },
          data: { balance: { increment: amountGHS } }
        });
        
        // Create transaction record (prefix with PS_ to avoid conflicts)
        await tx.transaction.create({
          data: {
            walletId: wallet.id,
            type: 'DEPOSIT',
            amount: amountGHS,
            status: 'COMPLETED',
            reference: `PS_${reference}`,
            paymentMethod: 'PAYSTACK',
            description: `Paystack deposit via ${event.data.channel || 'unknown'}`
          }
        });
        
        // Update pending payment status
        if (existingPayment) {
          await tx.pendingPayment.update({
            where: { reference },
            data: {
              status: 'COMPLETED',
              completedAt: new Date(paid_at)
            }
          });
        }
      });
      
      console.log(`[Paystack] ✅ Wallet credited: ${amountGHS} GHS for user ${userId}`);
      
      return {
        processed: true,
        userId,
        amount: amountGHS,
        reference
      };
    } catch (error) {
      console.error(`[Paystack] Error crediting wallet:`, error);
      return { processed: false, reason: error.message };
    }
  },

  /**
   * Get list of banks for transfers (if needed later)
   */
  async getBanks() {
    const response = await paystackRequest('/bank?country=ghana');
    return response.data;
  },

  /**
   * Check Paystack account balance
   */
  async getBalance() {
    try {
      const response = await paystackRequest('/balance');
      return {
        success: true,
        balance: response.data[0]?.balance / 100 || 0,
        currency: response.data[0]?.currency || 'GHS'
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  },

  /**
   * Test connection
   */
  async testConnection() {
    try {
      const response = await paystackRequest('/balance');
      return {
        success: true,
        message: 'Connected to Paystack successfully'
      };
    } catch (error) {
      return {
        success: false,
        message: error.message
      };
    }
  },

  /**
   * Initialize storefront payment
   * For customers buying from stores
   * @param {string} email - Customer email (can be phone@store.com)
   * @param {number} amount - Amount in GHS
   * @param {string} storefrontId - Storefront ID
   * @param {string} storefrontOrderId - StorefrontOrder ID
   * @param {string} callbackUrl - URL to redirect after payment
   */
  async initializeStorefrontPayment({ email, amount, subtotal, processingFee, storefrontId, storefrontOrderId, callbackUrl, customerPhone }) {
    // Amount must be in pesewas (this is the TOTAL customer pays including fee)
    const amountInPesewas = Math.round(amount * 100);
    
    // Generate unique reference for storefront
    const reference = `STF_${storefrontOrderId.slice(0, 8)}_${Date.now()}`;
    
    const response = await paystackRequest('/transaction/initialize', 'POST', {
      email,
      amount: amountInPesewas,
      currency: 'GHS',
      reference,
      callback_url: callbackUrl,
      metadata: {
        type: 'storefront_order',
        storefrontId,
        storefrontOrderId,
        customerPhone,
        amountGHS: amount,          // Total customer paid
        subtotalGHS: subtotal || amount,  // Original order amount (what agent credited)
        processingFeeGHS: processingFee || 0  // Fee we charged customer
      }
    });
    
    console.log(`[Paystack] Storefront payment initialized: ${reference} for ${amount} GHS (subtotal: ${subtotal || amount}, fee: ${processingFee || 0})`);
    
    return {
      success: true,
      reference,
      authorizationUrl: response.data.authorization_url,
      accessCode: response.data.access_code
    };
  },

  /**
   * Process storefront payment webhook
   * Marks order as paid and triggers fulfillment
   * @param {object} data - Webhook data with storefront metadata
   */
  async processStorefrontPayment(data) {
    const { reference, metadata } = data;
    const { storefrontId, storefrontOrderId, customerPhone } = metadata || {};
    
    if (!storefrontOrderId) {
      console.log(`[Paystack] No storefrontOrderId in metadata for ${reference}`);
      return { processed: false, reason: 'Missing storefrontOrderId' };
    }
    
    // Find the storefront order
    const storefrontOrder = await prisma.storefrontOrder.findUnique({
      where: { id: storefrontOrderId }
    });
    
    if (!storefrontOrder) {
      console.log(`[Paystack] StorefrontOrder not found: ${storefrontOrderId}`);
      return { processed: false, reason: 'Order not found' };
    }
    
    // Check if already processed
    if (storefrontOrder.paymentStatus === 'PAID') {
      console.log(`[Paystack] StorefrontOrder already paid: ${storefrontOrderId}`);
      return { processed: false, reason: 'Already paid' };
    }
    
    // Update payment status
    await prisma.storefrontOrder.update({
      where: { id: storefrontOrderId },
      data: {
        paymentStatus: 'PAID',
        paymentMethod: 'PAYSTACK',
        paystackReference: reference
      }
    });
    
    console.log(`[Paystack] ✅ StorefrontOrder payment confirmed: ${storefrontOrderId}`);
    
    return {
      processed: true,
      storefrontOrderId,
      reference
    };
  },

  // ============================================================
  // TRANSFER / PAYOUT FUNCTIONS
  // ============================================================

  /**
   * Create a transfer recipient for MoMo
   * @param {string} name - Recipient name
   * @param {string} accountNumber - Mobile money number (e.g., 0241234567)
   * @param {string} bankCode - Bank/network code (MTN, VOD, ATL)
   */
  async createTransferRecipient({ name, accountNumber, bankCode }) {
    try {
      const response = await paystackRequest('/transferrecipient', 'POST', {
        type: 'mobile_money',
        name,
        account_number: accountNumber,
        bank_code: bankCode,
        currency: 'GHS'
      });

      return {
        success: true,
        recipientCode: response.data.recipient_code,
        details: response.data
      };
    } catch (error) {
      console.error('[Paystack] Error creating recipient:', error);
      throw new Error(`Failed to create recipient: ${error.message}`);
    }
  },

  /**
   * Initiate a MoMo transfer
   * @param {number} amount - Amount in GHS
   * @param {string} recipientName - Recipient name
   * @param {string} recipientAccount - Mobile money number
   * @param {string} bankCode - Network code (MTN, VOD, ATL)
   * @param {string} reason - Transfer reason/description
   * @param {string} reference - Unique reference
   * @param {string} otp - OTP for transfer (if required)
   */
  async initiateMoMoTransfer({ amount, recipientName, recipientAccount, bankCode, reason, reference, otp }) {
    try {
      // First, create the transfer recipient
      const recipientResult = await this.createTransferRecipient({
        name: recipientName,
        accountNumber: recipientAccount,
        bankCode
      });

      if (!recipientResult.success) {
        throw new Error('Failed to create transfer recipient');
      }

      // Amount in pesewas
      const amountInPesewas = Math.round(amount * 100);

      // Build transfer payload
      const transferPayload = {
        source: 'balance',
        amount: amountInPesewas,
        recipient: recipientResult.recipientCode,
        reason: reason || 'Profit withdrawal',
        reference: reference || `TRF_${Date.now()}`
      };

      // If OTP is provided, use finalize_transfer endpoint
      if (otp) {
        // First initiate the transfer
        const initResponse = await paystackRequest('/transfer', 'POST', transferPayload);
        
        // Then finalize with OTP
        const finalizeResponse = await paystackRequest('/transfer/finalize_transfer', 'POST', {
          transfer_code: initResponse.data.transfer_code,
          otp: otp
        });

        console.log(`[Paystack] Transfer finalized with OTP: ${finalizeResponse.data.transfer_code} - ${amount} GHS to ${recipientAccount}`);

        return {
          success: true,
          transfer_code: finalizeResponse.data.transfer_code,
          reference: finalizeResponse.data.reference,
          status: finalizeResponse.data.status,
          details: finalizeResponse.data
        };
      }

      // Initiate the transfer (without OTP - assumes OTP disabled on account)
      const response = await paystackRequest('/transfer', 'POST', transferPayload);

      console.log(`[Paystack] Transfer initiated: ${response.data.transfer_code} - ${amount} GHS to ${recipientAccount}`);

      return {
        success: true,
        transfer_code: response.data.transfer_code,
        reference: response.data.reference,
        status: response.data.status,
        details: response.data
      };
    } catch (error) {
      console.error('[Paystack] Transfer error:', error);
      
      // Check if it's an OTP required error
      if (error.message && error.message.toLowerCase().includes('otp')) {
        throw new Error('OTP required. Please enter the OTP sent to your registered email/phone.');
      }
      
      throw new Error(`Transfer failed: ${error.message}`);
    }
  },

  /**
   * Check transfer status
   * @param {string} transferCode - Transfer code from initiation
   */
  async checkTransferStatus(transferCode) {
    try {
      const response = await paystackRequest(`/transfer/${transferCode}`);
      return {
        success: true,
        status: response.data.status,
        details: response.data
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  },

  /**
   * Resolve account number (verify MoMo details)
   * @param {string} accountNumber - Mobile money number
   * @param {string} bankCode - Network code
   */
  async resolveAccountNumber(accountNumber, bankCode) {
    try {
      const response = await paystackRequest(`/bank/resolve?account_number=${accountNumber}&bank_code=${bankCode}`);
      return {
        success: true,
        verified: true,
        accountName: response.data.account_name,
        accountNumber: response.data.account_number,
        bankId: response.data.bank_id
      };
    } catch (error) {
      // Paystack returns 422 if account not found
      if (error.message && error.message.includes('resolve')) {
        return {
          success: false,
          verified: false,
          error: 'Could not verify account. Please check the number and network.'
        };
      }
      throw error;
    }
  },

  /**
   * Get transfer status by transfer code or ID
   * @param {string} idOrCode - Transfer code (TRF_xxx) or ID
   */
  async getTransferStatus(idOrCode) {
    try {
      const response = await paystackRequest(`/transfer/${idOrCode}`);
      return {
        success: true,
        status: response.data.status, // success, failed, pending, reversed
        reference: response.data.reference,
        transferCode: response.data.transfer_code,
        amount: response.data.amount / 100,
        recipient: response.data.recipient,
        reason: response.data.reason,
        createdAt: response.data.createdAt,
        updatedAt: response.data.updatedAt
      };
    } catch (error) {
      console.error(`[Paystack] Failed to get transfer status for ${idOrCode}:`, error.message);
      return {
        success: false,
        error: error.message
      };
    }
  },

  /**
   * Verify transfer by reference
   * @param {string} reference - Transfer reference
   */
  async verifyTransfer(reference) {
    try {
      const response = await paystackRequest(`/transfer/verify/${reference}`);
      return {
        success: true,
        status: response.data.status,
        reference: response.data.reference,
        amount: response.data.amount / 100
      };
    } catch (error) {
      console.error(`[Paystack] Failed to verify transfer ${reference}:`, error.message);
      return {
        success: false,
        error: error.message
      };
    }
  }
};

module.exports = paystackService;
