/**
 * Paystack Payment Routes
 * =======================
 * Handles payment initialization, verification, and webhooks
 * for automatic wallet top-ups.
 */

const express = require('express');
const router = express.Router();
const { PrismaClient } = require('@prisma/client');
const paystackService = require('../services/paystack.service');
const { authenticate } = require('../middleware/auth');
const fs = require('fs');
const path = require('path');

const prisma = new PrismaClient();

// Helper to check if Paystack is enabled
function isPaystackEnabled() {
  try {
    const settingsPath = path.join(__dirname, '../../settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    return settings.siteSettings?.paystackEnabled !== false;
  } catch (e) {
    return true; // Default to enabled if settings can't be read
  }
}

/**
 * GET /api/paystack/public-key
 * Get public key for frontend Popup integration
 */
router.get('/public-key', (req, res) => {
  const publicKey = paystackService.getPublicKey();
  res.json({ publicKey });
});

/**
 * POST /api/paystack/initialize
 * Initialize a payment transaction
 * Requires authentication
 */
router.post('/initialize', authenticate, async (req, res, next) => {
  try {
    // Check if Paystack is enabled
    if (!isPaystackEnabled()) {
      return res.status(403).json({ error: 'Paystack payments are currently disabled' });
    }
    
    const { amount } = req.body;
    const userId = req.user.id;
    const email = req.user.email;
    
    if (!amount || amount <= 0) {
      return res.status(400).json({ error: 'Valid amount is required' });
    }
    
    // Minimum amount check (5 GHS)
    if (amount < 5) {
      return res.status(400).json({ error: 'Minimum deposit is 5 GHS' });
    }
    
    // Maximum amount check (e.g., 10,000 GHS)
    if (amount > 10000) {
      return res.status(400).json({ error: 'Maximum deposit is 10,000 GHS' });
    }
    
    // Calculate processing fee (1.5%) - charged to customer
    const PROCESSING_FEE_RATE = 0.015; // 1.5%
    const subtotal = parseFloat(amount);
    const processingFee = Math.round(subtotal * PROCESSING_FEE_RATE * 100) / 100;
    const totalAmount = subtotal + processingFee;
    
    console.log(`[Paystack] Top-up breakdown - Subtotal: ${subtotal}, Fee: ${processingFee}, Total: ${totalAmount}`);
    
    // Build callback URL dynamically
    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const host = req.headers['x-forwarded-host'] || req.get('host');
    const callbackUrl = `${protocol}://${host}/pages/wallet.html?payment=callback`;
    
    const result = await paystackService.initializePayment({
      email,
      amount: totalAmount,         // Total customer pays (includes fee)
      subtotal: subtotal,          // Original amount (credited to wallet)
      processingFee: processingFee,
      userId,
      callbackUrl
    });
    
    console.log('[Paystack] Initialize result:', JSON.stringify(result));
    res.json(result);
  } catch (error) {
    console.error('[Paystack] Initialize error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/paystack/verify/:reference
 * Verify a payment transaction and credit wallet if successful
 * Requires authentication
 */
router.get('/verify/:reference', authenticate, async (req, res, next) => {
  try {
    const { reference } = req.params;
    
    if (!reference) {
      return res.status(400).json({ error: 'Reference is required' });
    }
    
    const result = await paystackService.verifyPayment(reference);
    
    console.log(`[Paystack] Verify result for ${reference}:`, JSON.stringify(result));
    console.log(`[Paystack] Current user ID: ${req.user.id}, Metadata userId: ${result.metadata?.userId}`);
    
    // If payment is successful, credit wallet (handles idempotency internally)
    if (result.success) {
      // Allow crediting if userId matches OR if reference starts with KDP_ (agent topup)
      const isAgentTopup = reference.startsWith('KDP_');
      const userMatches = result.metadata?.userId === req.user.id;
      
      if (userMatches || isAgentTopup) {
        console.log(`[Paystack] Manual verification for ${reference}: ${result.status}`);
        
        // Get the subtotal (credit amount) from metadata, or look up from PendingPayment
        let creditAmount = result.metadata?.amountGHS;
        
        if (!creditAmount) {
          // Try to get from pending payment record
          const pendingPayment = await prisma.pendingPayment.findUnique({
            where: { reference }
          });
          creditAmount = pendingPayment?.amount || result.amount;
          console.log(`[Paystack] Got credit amount from PendingPayment: ${creditAmount}`);
        }
        
        // For agent topups without matching metadata, use current user
        const effectiveMetadata = {
          userId: result.metadata?.userId || req.user.id,
          type: result.metadata?.type || 'wallet_topup',
          amountGHS: creditAmount,  // The amount to credit (subtotal)
          totalPaidGHS: result.amount  // What customer actually paid
        };
        
        console.log(`[Paystack] Effective metadata:`, JSON.stringify(effectiveMetadata));
        
        // Process like a webhook to credit wallet
        const webhookResult = await paystackService.processWebhook({
          event: 'charge.success',
          data: {
            reference,
            amount: result.amount * 100, // Convert back to pesewas
            metadata: effectiveMetadata,
            paid_at: result.paidAt,
            channel: result.channel
          }
        });
        
        if (webhookResult.processed) {
          console.log(`[Paystack] ✅ Wallet credited via manual verification: ${effectiveMetadata.amountGHS} GHS`);
        } else {
          console.log(`[Paystack] Wallet not credited: ${webhookResult.reason}`);
        }
      } else {
        console.log(`[Paystack] User mismatch - not crediting. Expected: ${result.metadata?.userId}, Got: ${req.user.id}`);
      }
    }
    
    res.json(result);
  } catch (error) {
    console.error('[Paystack] Verify error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/paystack/webhook
 * Handle Paystack webhook events
 * NO AUTHENTICATION - Paystack sends directly
 * Protected by signature verification
 */
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const signature = req.headers['x-paystack-signature'];
    const rawBody = req.body.toString();
    
    // Verify webhook signature
    if (!paystackService.verifyWebhookSignature(rawBody, signature)) {
      console.error('[Paystack] Invalid webhook signature');
      return res.status(401).json({ error: 'Invalid signature' });
    }
    
    const event = JSON.parse(rawBody);
    console.log(`[Paystack] Webhook received: ${event.event}`);
    
    // Process the webhook
    const result = await paystackService.processWebhook(event);
    
    if (result.processed) {
      console.log(`[Paystack] ✅ Webhook processed: ${result.amount} GHS for user ${result.userId}`);
    } else {
      console.log(`[Paystack] Webhook not processed: ${result.reason}`);
    }
    
    // Always return 200 to Paystack
    res.status(200).json({ received: true });
  } catch (error) {
    console.error('[Paystack] Webhook error:', error.message);
    // Still return 200 to prevent Paystack from retrying
    res.status(200).json({ received: true, error: error.message });
  }
});

/**
 * GET /api/paystack/test
 * Test Paystack connection (Admin only)
 */
router.get('/test', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'ADMIN') {
      return res.status(403).json({ error: 'Admin only' });
    }
    
    const result = await paystackService.testConnection();
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/paystack/history
 * Get user's payment history (only completed payments)
 * Auto-deletes pending payments older than 1 hour
 */
router.get('/history', authenticate, async (req, res, next) => {
  try {
    // Auto-expire: delete pending payments older than 1 hour
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    await prisma.pendingPayment.deleteMany({
      where: {
        status: 'PENDING',
        createdAt: { lt: oneHourAgo }
      }
    });
    
    // Only return completed payments
    const payments = await prisma.pendingPayment.findMany({
      where: { 
        userId: req.user.id,
        status: 'COMPLETED'
      },
      orderBy: { createdAt: 'desc' },
      take: 50
    });
    
    res.json({ payments });
  } catch (error) {
    console.error('[Paystack] History error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
