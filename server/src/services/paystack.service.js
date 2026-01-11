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
   * @param {number} amount - Amount in GHS (will be converted to pesewas)
   * @param {string} userId - User ID for reference
   * @param {string} callbackUrl - URL to redirect after payment
   */
  async initializePayment({ email, amount, userId, callbackUrl }) {
    // Amount must be in pesewas (kobo equivalent)
    const amountInPesewas = Math.round(amount * 100);
    
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
        amountGHS: amount
      }
    });
    
    // Store pending payment in database
    await prisma.pendingPayment.create({
      data: {
        reference,
        userId,
        amount,
        status: 'PENDING',
        provider: 'PAYSTACK',
        metadata: JSON.stringify({ email })
      }
    });
    
    console.log(`[Paystack] Payment initialized: ${reference} for ${amount} GHS`);
    
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
    const hash = crypto
      .createHmac('sha512', config.secretKey)
      .update(body)
      .digest('hex');
    
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
    const amountGHS = amount / 100;
    
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
  async initializeStorefrontPayment({ email, amount, storefrontId, storefrontOrderId, callbackUrl, customerPhone }) {
    // Amount must be in pesewas
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
        amountGHS: amount
      }
    });
    
    console.log(`[Paystack] Storefront payment initialized: ${reference} for ${amount} GHS`);
    
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
  }
};

module.exports = paystackService;
