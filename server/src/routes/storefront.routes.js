/**
 * STOREFRONT ROUTES
 * =================
 * API endpoints for user-generated storefronts.
 * 
 * PUBLIC endpoints: /api/store/:slug (no auth required)
 * OWNER endpoints: /api/storefronts (auth required)
 * ADMIN endpoints: /api/admin/storefronts (admin only)
 */

const express = require('express');
const router = express.Router();
const { authenticate, authorize } = require('../middleware/auth');
const storefrontService = require('../services/storefront.service');
const paystackService = require('../services/paystack.service');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

// ============================================
// PUBLIC ENDPOINTS (No auth required)
// ============================================

/**
 * GET /api/store/:slug
 * Get public storefront by slug
 */
router.get('/store/:slug', async (req, res, next) => {
  try {
    const storefront = await storefrontService.getBySlug(req.params.slug);
    
    if (!storefront) {
      return res.status(404).json({ error: 'Store not found' });
    }

    res.json(storefront);
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/store/:slug/products
 * Get products for a storefront with live prices
 */
router.get('/store/:slug/products', async (req, res, next) => {
  try {
    const storefront = await storefrontService.getBySlug(req.params.slug);
    
    if (!storefront) {
      return res.status(404).json({ error: 'Store not found' });
    }

    const products = await storefrontService.getStorefrontProducts(storefront.id);
    res.json(products);
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/store/:slug/order
 * DEPRECATED: MoMo orders no longer supported for storefronts
 * Storefronts now only support Paystack payments
 */
router.post('/store/:slug/order', async (req, res, next) => {
  return res.status(400).json({ 
    error: 'MoMo payment is no longer supported. Please use the Paystack payment option.' 
  });
});

/**
 * POST /api/store/:slug/paystack/initialize
 * Initialize Paystack payment for storefront order
 * Creates pending order and returns payment URL
 */
router.post('/store/:slug/paystack/initialize', async (req, res, next) => {
  try {
    const { bundleId, phone, name, email } = req.body;

    if (!bundleId || !phone) {
      return res.status(400).json({ error: 'Bundle ID and phone number are required' });
    }

    // Validate phone format (Ghana) - allow 0XX format
    const phoneRegex = /^0\d{9}$/;
    if (!phoneRegex.test(phone)) {
      return res.status(400).json({ error: 'Invalid phone number format. Use format: 0241234567' });
    }

    const storefront = await storefrontService.getBySlug(req.params.slug);
    
    if (!storefront) {
      return res.status(404).json({ error: 'Store not found' });
    }

    if (!storefront.paystackEnabled) {
      return res.status(400).json({ error: 'Paystack payment not enabled for this store' });
    }

    // Verify Paystack is configured at system level
    const paystackPublicKey = paystackService.getPublicKey();
    if (!paystackPublicKey) {
      console.error('[Storefront] Paystack API keys not configured');
      return res.status(503).json({ 
        error: 'Payment system temporarily unavailable. Please contact support.',
        code: 'PAYSTACK_NOT_CONFIGURED'
      });
    }

    // Check if customer is logged in - use their account phone for order tracking
    // The 'phone' from request is the RECIPIENT phone (where data goes)
    let customerAccountPhone = phone; // Default to recipient phone if not logged in
    const jwt = require('jsonwebtoken');
    const customerToken = req.cookies['store_customer_token'];
    if (customerToken) {
      try {
        const decoded = jwt.verify(customerToken, process.env.JWT_SECRET || 'your-super-secret-jwt-key-change-in-production');
        if (decoded.type === 'store_customer') {
          const customer = await prisma.storeCustomer.findUnique({ where: { id: decoded.id } });
          if (customer && customer.isActive) {
            customerAccountPhone = customer.phone;
            console.log(`[Storefront] Logged-in customer ${customer.phone} placing order for ${phone}`);
          }
        }
      } catch (e) {
        // Token invalid, continue as guest
      }
    }

    // Get bundle and pricing - pass both account phone (for tracking) and recipient phone (for fulfillment)
    const result = await storefrontService.createPendingPaystackOrder(
      storefront.id,
      bundleId,
      customerAccountPhone, // Customer's account phone for order lookup
      name,
      phone // Recipient phone (where data goes) - stored in order when fulfilling
    );

    // Build callback URL
    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const host = req.headers['x-forwarded-host'] || req.get('host');
    const callbackUrl = `${protocol}://${host}/store/${req.params.slug}?payment=callback`;

    console.log(`[Storefront] Callback URL: ${callbackUrl}`);

    // Use customer email or generate from phone
    const customerEmail = email || `${phone}@customer.store`;

    // Calculate processing fee (1.5%) - charged to customer
    const PROCESSING_FEE_RATE = 0.015; // 1.5%
    const subtotal = result.amount;
    const processingFee = Math.round(subtotal * PROCESSING_FEE_RATE * 100) / 100;
    const totalAmount = subtotal + processingFee;

    console.log(`[Storefront] Payment breakdown - Subtotal: ${subtotal}, Fee: ${processingFee}, Total: ${totalAmount}`);
    console.log(`[Storefront] Initializing Paystack for storefrontOrderId: ${result.storefrontOrderId}`);

    // Initialize Paystack payment with TOTAL amount (subtotal + fee)
    const paystackResult = await paystackService.initializeStorefrontPayment({
      email: customerEmail,
      amount: totalAmount,       // Customer pays this (includes fee)
      subtotal: subtotal,        // Original order amount
      processingFee: processingFee, // Fee for tracking
      storefrontId: storefront.id,
      storefrontOrderId: result.storefrontOrderId,
      callbackUrl,
      customerPhone: phone
    });

    console.log(`[Storefront] Paystack initialized - Reference: ${paystackResult.reference}, URL: ${paystackResult.authorizationUrl?.substring(0, 50)}...`);

    // Update storefront order with Paystack reference
    await prisma.storefrontOrder.update({
      where: { id: result.storefrontOrderId },
      data: { paystackReference: paystackResult.reference }
    });

    console.log(`[Storefront] Order ${result.storefrontOrderId} updated with reference: ${paystackResult.reference}`);

    res.json({
      success: true,
      ...paystackResult,
      orderId: result.storefrontOrderId,
      amount: result.amount,     // Original order amount (what agent priced)
      subtotal: subtotal,        // Same as amount (for clarity)
      processingFee: processingFee, // 1.5% fee
      totalAmount: totalAmount   // What customer pays
    });
  } catch (error) {
    console.error('Paystack initialize error:', error);
    res.status(400).json({ error: error.message });
  }
});

/**
 * GET /api/store/:slug/paystack/verify/:reference
 * Verify Paystack payment and complete order
 */
router.get('/store/:slug/paystack/verify/:reference', async (req, res, next) => {
  try {
    const { reference } = req.params;

    console.log(`[Storefront] Verifying payment reference: ${reference}`);

    const storefront = await storefrontService.getBySlug(req.params.slug);
    
    if (!storefront) {
      return res.status(404).json({ error: 'Store not found' });
    }

    // First check if we have a StorefrontOrder with this reference
    // This helps us verify the payment even if Paystack session expired
    const storefrontOrder = await prisma.storefrontOrder.findFirst({
      where: { paystackReference: reference },
      include: { bundle: true }
    });

    if (storefrontOrder) {
      console.log(`[Storefront] Found order with reference ${reference}, status: ${storefrontOrder.paymentStatus}`);
      
      // If already paid and completed, return success
      if (storefrontOrder.paymentStatus === 'PAID' && storefrontOrder.orderId) {
        console.log(`[Storefront] Order already completed: ${storefrontOrder.orderId}`);
        return res.json({
          success: true,
          message: 'Payment already verified',
          orderId: storefrontOrder.orderId || reference,
          bundle: storefrontOrder.bundle?.name || 'Data Bundle',
          phone: storefrontOrder.paymentPhone || storefrontOrder.customerPhone || '',
          amount: storefrontOrder.amount || 0,
          status: 'COMPLETED'
        });
      }
    }

    // Verify payment with Paystack (with retry for transient errors)
    let verification;
    let retryCount = 0;
    const maxRetries = 2;
    
    while (retryCount <= maxRetries) {
      try {
        verification = await paystackService.verifyPayment(reference);
        break; // Success, exit loop
      } catch (paystackError) {
        retryCount++;
        console.error(`[Storefront] Paystack verify API error (attempt ${retryCount}):`, paystackError.message);
        
        if (retryCount <= maxRetries) {
          // Wait 1 second before retry
          await new Promise(resolve => setTimeout(resolve, 1000));
          console.log(`[Storefront] Retrying verification...`);
          continue;
        }
        
        // All retries failed
        // If Paystack fails but we have a pending order, check if it was paid via webhook
        if (storefrontOrder && storefrontOrder.paymentStatus === 'PAID') {
          console.log(`[Storefront] Paystack API failed but order is PAID - completing via stored data`);
          try {
            const orderResult = await storefrontService.completePaystackOrder(storefrontOrder.id, reference);
            return res.json({
              success: true,
              message: 'Payment verified via webhook',
              orderId: orderResult?.orderId || storefrontOrder.id,
              bundle: storefrontOrder.bundle?.name || 'Data Bundle',
              phone: storefrontOrder.paymentPhone || storefrontOrder.customerPhone || '',
              amount: storefrontOrder.amount || 0,
              status: orderResult?.status || 'PROCESSING'
            });
          } catch (completionError) {
            if (completionError.message?.includes('already completed')) {
              return res.json({
                success: true,
                message: 'Order already processed',
                orderId: storefrontOrder.orderId || reference,
                bundle: storefrontOrder.bundle?.name || 'Data Bundle',
                phone: storefrontOrder.paymentPhone || storefrontOrder.customerPhone || '',
                amount: storefrontOrder.amount || 0,
                status: 'COMPLETED'
              });
            }
          }
        }
        
        // Return user-friendly error
        return res.status(400).json({ 
          error: 'Payment verification failed. If you were charged, please contact support with reference: ' + reference,
          reference: reference
        });
      }
    }

    if (!verification.success) {
      return res.json({
        success: false,
        status: verification.status,
        message: 'Payment not successful'
      });
    }

    // Find and complete the order
    const storefrontOrderId = verification.metadata?.storefrontOrderId;
    let orderResult = null;
    
    if (storefrontOrderId) {
      orderResult = await storefrontService.completePaystackOrder(storefrontOrderId, reference);
    }

    res.json({
      success: true,
      message: 'Payment verified successfully',
      orderId: orderResult?.orderId || storefrontOrderId || reference,
      bundle: orderResult?.bundle || 'Data Bundle',
      phone: orderResult?.phone || verification.metadata?.phone || '',
      amount: orderResult?.amount || (verification.amount / 100) || 0,
      status: orderResult?.status || 'PROCESSING'
    });
  } catch (error) {
    console.error('Paystack verify error:', error);
    res.status(400).json({ error: error.message });
  }
});

/**
 * GET /api/store/:slug/orders
 * Track orders by phone number (public - customer facing)
 */
router.get('/store/:slug/orders', async (req, res, next) => {
  try {
    const { phone } = req.query;
    
    if (!phone) {
      return res.status(400).json({ error: 'Phone number is required' });
    }

    const storefront = await storefrontService.getBySlug(req.params.slug);
    
    if (!storefront) {
      return res.status(404).json({ error: 'Store not found' });
    }

    const orders = await storefrontService.getCustomerOrders(storefront.id, phone);
    res.json(orders);
  } catch (error) {
    next(error);
  }
});

/**
 * PUT /api/storefronts/:id/prices/:bundleId
 * Set custom selling price for a bundle
 */
router.put('/:id/prices/:bundleId', authenticate, async (req, res, next) => {
  try {
    const { sellingPrice } = req.body;
    
    if (!sellingPrice || sellingPrice <= 0) {
      return res.status(400).json({ error: 'Valid selling price is required' });
    }

    const product = await storefrontService.setProductPrice(
      req.params.id,
      req.user.id,
      req.params.bundleId,
      parseFloat(sellingPrice)
    );

    res.json(product);
  } catch (error) {
    next(error);
  }
});

// ============================================
// OWNER ENDPOINTS (Auth required)
// ============================================

/**
 * GET /api/storefronts
 * Get user's own storefronts
 */
router.get('/', authenticate, async (req, res, next) => {
  try {
    const storefronts = await storefrontService.getByOwner(req.user.id);
    res.json(storefronts);
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/storefronts
 * Create new storefront
 */
router.post('/', authenticate, async (req, res, next) => {
  try {
    const storefront = await storefrontService.createStore(req.user.id, req.body);
    res.status(201).json({
      message: 'Storefront created successfully',
      storefront
    });
  } catch (error) {
    if (error.message.includes('limit')) {
      return res.status(403).json({ error: error.message });
    }
    next(error);
  }
});

/**
 * GET /api/storefronts/:id
 * Get specific storefront (owner only)
 */
router.get('/:id', authenticate, async (req, res, next) => {
  try {
    const storefront = await storefrontService.getById(req.params.id);
    
    if (!storefront) {
      return res.status(404).json({ error: 'Storefront not found' });
    }

    // Check ownership (unless admin)
    if (storefront.ownerId !== req.user.id && req.user.role !== 'ADMIN') {
      return res.status(403).json({ error: 'Access denied' });
    }

    res.json(storefront);
  } catch (error) {
    next(error);
  }
});

/**
 * PUT /api/storefronts/:id
 * Update storefront details
 */
router.put('/:id', authenticate, async (req, res, next) => {
  try {
    const storefront = await storefrontService.updateStore(
      req.params.id,
      req.user.id,
      req.body
    );
    res.json({
      message: 'Storefront updated',
      storefront
    });
  } catch (error) {
    if (error.message === 'Not authorized to update this storefront') {
      return res.status(403).json({ error: error.message });
    }
    next(error);
  }
});

/**
 * POST /api/storefronts/:id/products
 * Add product to storefront
 */
router.post('/:id/products', authenticate, async (req, res, next) => {
  try {
    const { bundleId, displayName, displayOrder, isVisible, sellingPrice } = req.body;

    if (!bundleId) {
      return res.status(400).json({ error: 'bundleId is required' });
    }

    const product = await storefrontService.addProduct(
      req.params.id,
      req.user.id,
      bundleId,
      { displayName, displayOrder, isVisible, sellingPrice }
    );

    res.status(201).json({
      message: 'Product added to storefront',
      product
    });
  } catch (error) {
    if (error.message === 'Not authorized' || error.message.includes('cannot be less')) {
      return res.status(403).json({ error: error.message });
    }
    if (error.message.includes('already exists')) {
      return res.status(409).json({ error: error.message });
    }
    next(error);
  }
});

/**
 * PUT /api/storefronts/:id/products/:productId
 * Update product pricing/visibility
 */
router.put('/:id/products/:productId', authenticate, async (req, res, next) => {
  try {
    const { displayName, displayOrder, isVisible, sellingPrice } = req.body;

    const product = await storefrontService.updateProduct(
      req.params.id,
      req.user.id,
      req.params.productId,
      { displayName, displayOrder, isVisible, sellingPrice }
    );

    res.json({
      message: 'Product updated',
      product
    });
  } catch (error) {
    if (error.message.includes('cannot be less') || error.message.includes('not authorized')) {
      return res.status(403).json({ error: error.message });
    }
    next(error);
  }
});

/**
 * DELETE /api/storefronts/:id/products/:productId
 * Remove product from storefront
 */
router.delete('/:id/products/:productId', authenticate, async (req, res, next) => {
  try {
    await storefrontService.removeProduct(
      req.params.id,
      req.user.id,
      req.params.productId
    );
    res.json({ message: 'Product removed from storefront' });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/storefronts/:id/products
 * Get storefront products with live prices (owner view with costs)
 */
router.get('/:id/products', authenticate, async (req, res, next) => {
  try {
    const storefront = await storefrontService.getById(req.params.id);
    
    if (!storefront) {
      return res.status(404).json({ error: 'Storefront not found' });
    }

    if (storefront.ownerId !== req.user.id && req.user.role !== 'ADMIN') {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Owner view includes cost breakdown
    const products = await storefrontService.getStorefrontProducts(req.params.id, true);
    res.json(products);
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/storefronts/:id/orders
 * Get storefront orders (owner view)
 */
router.get('/:id/orders', authenticate, async (req, res, next) => {
  try {
    const orders = await storefrontService.getStoreOrders(req.params.id, req.user.id);
    res.json(orders);
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/storefronts/bundles/available
 * Get available bundles for user to add to their store
 */
router.get('/bundles/available', authenticate, async (req, res, next) => {
  try {
    const bundles = await storefrontService.getAvailableBundles(req.user.id);
    res.json(bundles);
  } catch (error) {
    next(error);
  }
});

// ============================================
// ADMIN ENDPOINTS
// ============================================

/**
 * GET /api/storefronts/admin/all
 * Get all storefronts (admin only)
 */
router.get('/admin/all', authenticate, authorize('ADMIN'), async (req, res, next) => {
  try {
    const { status, ownerId, tenantId } = req.query;
    const storefronts = await storefrontService.getAllStorefronts({
      status,
      ownerId,
      tenantId
    });
    res.json(storefronts);
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/storefronts/admin/:id/suspend
 * Suspend a storefront (admin only)
 */
router.post('/admin/:id/suspend', authenticate, authorize('ADMIN'), async (req, res, next) => {
  try {
    const { reason } = req.body;
    if (!reason) {
      return res.status(400).json({ error: 'Reason is required' });
    }

    const storefront = await storefrontService.suspendStore(
      req.params.id,
      req.user.id,
      reason
    );

    res.json({
      message: 'Storefront suspended',
      storefront
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/storefronts/admin/:id/activate
 * Activate a storefront (admin only)
 */
router.post('/admin/:id/activate', authenticate, authorize('ADMIN'), async (req, res, next) => {
  try {
    const storefront = await storefrontService.activateStore(
      req.params.id,
      req.user.id
    );

    res.json({
      message: 'Storefront activated',
      storefront
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/storefronts/admin/:id/disable
 * Permanently disable a storefront (admin only)
 */
router.post('/admin/:id/disable', authenticate, authorize('ADMIN'), async (req, res, next) => {
  try {
    const { reason } = req.body;
    if (!reason) {
      return res.status(400).json({ error: 'Reason is required' });
    }

    const storefront = await storefrontService.disableStore(
      req.params.id,
      req.user.id,
      reason
    );

    res.json({
      message: 'Storefront permanently disabled',
      storefront
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
