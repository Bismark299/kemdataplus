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
 * Place order through storefront (no auth required - customer facing)
 */
router.post('/store/:slug/order', async (req, res, next) => {
  try {
    const { bundleId, phone, name, paymentReference } = req.body;

    if (!bundleId || !phone) {
      return res.status(400).json({ error: 'Bundle ID and phone number are required' });
    }

    // Validate phone format (Ghana)
    const phoneRegex = /^0[235]\d{8}$/;
    if (!phoneRegex.test(phone)) {
      return res.status(400).json({ error: 'Invalid phone number format. Use format: 0241234567' });
    }

    const storefront = await storefrontService.getBySlug(req.params.slug);
    
    if (!storefront) {
      return res.status(404).json({ error: 'Store not found' });
    }

    const order = await storefrontService.placeOrder(
      storefront.id,
      bundleId,
      phone,
      name,
      paymentReference
    );

    res.status(201).json({
      success: true,
      message: 'Order placed successfully! Your data will be delivered shortly.',
      order
    });
  } catch (error) {
    console.error('Store order error:', error);
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
