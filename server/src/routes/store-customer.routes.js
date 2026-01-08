/**
 * Store Customer Authentication & Account Routes
 * Provides customer account management for storefronts
 * Features: Auth, Profile, Orders, Favorites, Reorder
 */

const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { PrismaClient } = require('@prisma/client');

const router = express.Router();
const prisma = new PrismaClient();

// SECURITY: JWT_SECRET must be set in environment - no fallback in production
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('CRITICAL: JWT_SECRET environment variable must be set in production!');
  }
  console.warn('⚠️ WARNING: JWT_SECRET not set. Using insecure default for development only.');
}
const EFFECTIVE_JWT_SECRET = JWT_SECRET || 'dev-only-insecure-secret-do-not-use-in-production';
const COOKIE_NAME = 'store_customer_token';

// In-memory store for failed login attempts (use Redis in production for multiple instances)
const loginAttempts = new Map();
const LOCKOUT_THRESHOLD = 5; // Lock after 5 failed attempts
const LOCKOUT_DURATION = 15 * 60 * 1000; // 15 minutes lockout

// Clean up expired lockouts periodically
setInterval(() => {
  const now = Date.now();
  for (const [phone, data] of loginAttempts.entries()) {
    if (data.lockedUntil && data.lockedUntil < now) {
      loginAttempts.delete(phone);
    }
  }
}, 60 * 1000); // Clean every minute

/**
 * Record a failed login attempt and return lockout status
 * @param {string} phone - Phone number that failed login
 * @returns {Object} { count, locked, lockedUntil }
 */
function recordFailedAttempt(phone) {
  const now = Date.now();
  const attempts = loginAttempts.get(phone) || { count: 0, firstAttempt: now };
  
  // Reset if first attempt was more than lockout duration ago
  if (now - attempts.firstAttempt > LOCKOUT_DURATION) {
    attempts.count = 0;
    attempts.firstAttempt = now;
  }
  
  attempts.count++;
  
  // Check if should be locked
  if (attempts.count >= LOCKOUT_THRESHOLD) {
    attempts.lockedUntil = now + LOCKOUT_DURATION;
    loginAttempts.set(phone, attempts);
    return { count: attempts.count, locked: true, lockedUntil: attempts.lockedUntil };
  }
  
  loginAttempts.set(phone, attempts);
  return { count: attempts.count, locked: false };
}

// ============================================
// MIDDLEWARE - Customer Authentication
// ============================================

/**
 * Middleware to verify customer token
 */
const authenticateCustomer = async (req, res, next) => {
  try {
    const token = req.cookies[COOKIE_NAME];
    
    if (!token) {
      return res.status(401).json({ error: 'Please login to continue' });
    }

    const decoded = jwt.verify(token, EFFECTIVE_JWT_SECRET);
    
    if (decoded.type !== 'store_customer') {
      return res.status(401).json({ error: 'Invalid session' });
    }

    const customer = await prisma.storeCustomer.findUnique({
      where: { id: decoded.id }
    });

    if (!customer || !customer.isActive) {
      res.clearCookie(COOKIE_NAME);
      return res.status(401).json({ error: 'Account not found or disabled' });
    }

    req.customer = customer;
    next();
  } catch (error) {
    res.clearCookie(COOKIE_NAME);
    return res.status(401).json({ error: 'Session expired. Please login again.' });
  }
};

// ============================================
// AUTHENTICATION ROUTES
// ============================================

/**
 * POST /api/store-customer/register
 * Register a new customer account
 */
router.post('/register', async (req, res, next) => {
  try {
    const { phone, pin, name, email } = req.body;

    // Validate required fields
    if (!phone || !pin) {
      return res.status(400).json({ error: 'Phone number and PIN are required' });
    }

    // Validate phone format (Ghana)
    const phoneRegex = /^0[235][0-9]{8}$/;
    if (!phoneRegex.test(phone)) {
      return res.status(400).json({ error: 'Invalid phone number. Use format: 0241234567' });
    }

    // Validate PIN (6 digits required for security)
    if (!/^\d{6}$/.test(pin)) {
      return res.status(400).json({ error: 'PIN must be exactly 6 digits' });
    }

    // Check if customer already exists
    const existingCustomer = await prisma.storeCustomer.findUnique({
      where: { phone }
    });

    if (existingCustomer) {
      return res.status(409).json({ error: 'This phone number is already registered. Please login instead.' });
    }

    // Hash PIN with strong bcrypt rounds
    const hashedPin = await bcrypt.hash(pin, 12);

    // Create customer
    const customer = await prisma.storeCustomer.create({
      data: {
        phone,
        pin: hashedPin,
        name: name?.trim() || null,
        email: email?.trim()?.toLowerCase() || null
      }
    });

    // Generate token
    const token = jwt.sign(
      { id: customer.id, phone: customer.phone, type: 'store_customer' },
      EFFECTIVE_JWT_SECRET,
      { expiresIn: '30d' }
    );

    // Set httpOnly cookie with strict security settings
    res.cookie(COOKIE_NAME, token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict', // Prevent CSRF
      maxAge: 30 * 24 * 60 * 60 * 1000 // 30 days
    });

    res.status(201).json({
      message: 'Account created successfully!',
      customer: {
        id: customer.id,
        phone: customer.phone,
        name: customer.name
      }
    });
  } catch (error) {
    console.error('Customer registration error:', error);
    next(error);
  }
});

/**
 * POST /api/store-customer/login
 * Login with phone and PIN
 */
router.post('/login', async (req, res, next) => {
  try {
    const { phone, pin } = req.body;

    if (!phone || !pin) {
      return res.status(400).json({ error: 'Phone number and PIN are required' });
    }

    // Check for account lockout (brute-force protection)
    const attempts = loginAttempts.get(phone);
    if (attempts && attempts.lockedUntil) {
      if (Date.now() < attempts.lockedUntil) {
        const remainingMins = Math.ceil((attempts.lockedUntil - Date.now()) / 60000);
        return res.status(429).json({ 
          error: `Account temporarily locked. Try again in ${remainingMins} minute(s).`,
          lockedUntil: attempts.lockedUntil
        });
      } else {
        // Lockout expired, reset attempts
        loginAttempts.delete(phone);
      }
    }

    // Find customer
    const customer = await prisma.storeCustomer.findUnique({
      where: { phone }
    });

    if (!customer) {
      // Record failed attempt even for non-existent accounts (prevent enumeration)
      recordFailedAttempt(phone);
      return res.status(401).json({ error: 'Invalid phone number or PIN' });
    }

    if (!customer.isActive) {
      return res.status(401).json({ error: 'Account is disabled. Please contact support.' });
    }

    // Verify PIN
    const validPin = await bcrypt.compare(pin, customer.pin);
    if (!validPin) {
      // Record failed attempt
      const lockoutInfo = recordFailedAttempt(phone);
      if (lockoutInfo.locked) {
        return res.status(429).json({ 
          error: `Too many failed attempts. Account locked for 15 minutes.`,
          lockedUntil: lockoutInfo.lockedUntil
        });
      }
      const attemptsLeft = LOCKOUT_THRESHOLD - lockoutInfo.count;
      return res.status(401).json({ 
        error: `Invalid phone number or PIN. ${attemptsLeft} attempt(s) remaining.`
      });
    }

    // Successful login - clear failed attempts
    loginAttempts.delete(phone);

    // Update last login
    await prisma.storeCustomer.update({
      where: { id: customer.id },
      data: { lastLoginAt: new Date() }
    });

    // Generate token
    const token = jwt.sign(
      { id: customer.id, phone: customer.phone, type: 'store_customer' },
      EFFECTIVE_JWT_SECRET,
      { expiresIn: '30d' }
    );

    // Set httpOnly cookie with strict security settings
    res.cookie(COOKIE_NAME, token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict', // Prevent CSRF
      maxAge: 30 * 24 * 60 * 60 * 1000
    });

    res.json({
      message: 'Welcome back!',
      customer: {
        id: customer.id,
        phone: customer.phone,
        name: customer.name,
        email: customer.email
      }
    });
  } catch (error) {
    console.error('Customer login error:', error);
    next(error);
  }
});

/**
 * GET /api/store-customer/me
 * Get current logged in customer with stats
 */
router.get('/me', async (req, res) => {
  try {
    const token = req.cookies[COOKIE_NAME];
    
    if (!token) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const decoded = jwt.verify(token, EFFECTIVE_JWT_SECRET);
    
    if (decoded.type !== 'store_customer') {
      return res.status(401).json({ error: 'Invalid token type' });
    }

    const customer = await prisma.storeCustomer.findUnique({
      where: { id: decoded.id },
      include: {
        favorites: {
          select: { bundleId: true, storefrontId: true }
        }
      }
    });

    if (!customer || !customer.isActive) {
      res.clearCookie(COOKIE_NAME);
      return res.status(401).json({ error: 'Account not found or disabled' });
    }

    // Get order stats
    const orderStats = await prisma.storefrontOrder.aggregate({
      where: { customerPhone: customer.phone },
      _count: { id: true },
      _sum: { amount: true }
    });

    res.json({
      id: customer.id,
      phone: customer.phone,
      name: customer.name,
      email: customer.email,
      createdAt: customer.createdAt,
      stats: {
        totalOrders: orderStats._count.id || 0,
        totalSpent: orderStats._sum.amount || 0,
        favoritesCount: customer.favorites.length
      },
      favoriteIds: customer.favorites.map(f => `${f.bundleId}:${f.storefrontId}`)
    });
  } catch (error) {
    res.clearCookie(COOKIE_NAME);
    return res.status(401).json({ error: 'Invalid or expired session' });
  }
});

/**
 * POST /api/store-customer/logout
 * Logout customer
 */
router.post('/logout', (req, res) => {
  res.clearCookie(COOKIE_NAME);
  res.json({ message: 'Logged out successfully' });
});

// ============================================
// PROFILE ROUTES
// ============================================

/**
 * PUT /api/store-customer/profile
 * Update customer profile
 */
router.put('/profile', authenticateCustomer, async (req, res, next) => {
  try {
    const { name, email } = req.body;

    const customer = await prisma.storeCustomer.update({
      where: { id: req.customer.id },
      data: {
        name: name?.trim() || null,
        email: email?.trim()?.toLowerCase() || null
      }
    });

    res.json({
      message: 'Profile updated successfully',
      customer: {
        id: customer.id,
        phone: customer.phone,
        name: customer.name,
        email: customer.email
      }
    });
  } catch (error) {
    next(error);
  }
});

/**
 * PUT /api/store-customer/change-pin
 * Change customer PIN
 */
router.put('/change-pin', authenticateCustomer, async (req, res, next) => {
  try {
    const { currentPin, newPin } = req.body;

    if (!currentPin || !newPin) {
      return res.status(400).json({ error: 'Current PIN and new PIN are required' });
    }

    if (!/^\d{4,6}$/.test(newPin)) {
      return res.status(400).json({ error: 'New PIN must be 4-6 digits' });
    }

    // Verify current PIN
    const validPin = await bcrypt.compare(currentPin, req.customer.pin);
    if (!validPin) {
      return res.status(401).json({ error: 'Current PIN is incorrect' });
    }

    // Update PIN
    const hashedPin = await bcrypt.hash(newPin, 10);
    await prisma.storeCustomer.update({
      where: { id: req.customer.id },
      data: { pin: hashedPin }
    });

    res.json({ message: 'PIN changed successfully' });
  } catch (error) {
    next(error);
  }
});

// ============================================
// ORDER ROUTES
// ============================================

/**
 * GET /api/store-customer/orders
 * Get all orders for the logged in customer (across all stores)
 */
router.get('/orders', authenticateCustomer, async (req, res, next) => {
  try {
    const { limit = 50, status } = req.query;

    const whereClause = { customerPhone: req.customer.phone };
    
    // Optional status filter
    if (status) {
      whereClause.order = { status: status.toUpperCase() };
    }

    const orders = await prisma.storefrontOrder.findMany({
      where: whereClause,
      include: {
        storefront: {
          select: { name: true, slug: true, primaryColor: true, logoUrl: true }
        },
        bundle: {
          select: { id: true, name: true, network: true, dataAmount: true, validity: true }
        },
        order: {
          select: { status: true }
        }
      },
      orderBy: { createdAt: 'desc' },
      take: parseInt(limit)
    });

    res.json(orders.map(o => ({
      id: o.id,
      orderId: o.id.slice(0, 8).toUpperCase(),
      store: {
        name: o.storefront?.name || 'Unknown Store',
        slug: o.storefront?.slug,
        color: o.storefront?.primaryColor || '#024959',
        logo: o.storefront?.logoUrl
      },
      bundle: {
        id: o.bundle?.id,
        name: o.bundle?.name || 'Data Bundle',
        network: o.bundle?.network || 'N/A',
        dataAmount: o.bundle?.dataAmount || 'N/A',
        validity: o.bundle?.validity || 'N/A'
      },
      amount: o.amount,
      status: o.order?.status || o.status,
      paymentStatus: o.paymentStatus,
      paymentReference: o.paymentReference,
      createdAt: o.createdAt
    })));
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/store-customer/orders/stats
 * Get order statistics for dashboard
 */
router.get('/orders/stats', authenticateCustomer, async (req, res, next) => {
  try {
    const phone = req.customer.phone;

    // Get order stats by status
    const [total, completed, pending, totalSpent] = await Promise.all([
      prisma.storefrontOrder.count({ where: { customerPhone: phone } }),
      prisma.storefrontOrder.count({ 
        where: { 
          customerPhone: phone,
          OR: [
            { status: 'COMPLETED' },
            { order: { status: 'COMPLETED' } }
          ]
        } 
      }),
      prisma.storefrontOrder.count({ 
        where: { 
          customerPhone: phone,
          OR: [
            { status: 'PENDING' },
            { order: { status: 'PENDING' } }
          ]
        } 
      }),
      prisma.storefrontOrder.aggregate({
        where: { customerPhone: phone },
        _sum: { amount: true }
      })
    ]);

    // Get most ordered bundle
    const popularBundles = await prisma.storefrontOrder.groupBy({
      by: ['bundleId'],
      where: { customerPhone: phone },
      _count: { bundleId: true },
      orderBy: { _count: { bundleId: 'desc' } },
      take: 3
    });

    res.json({
      totalOrders: total,
      completedOrders: completed,
      pendingOrders: pending,
      totalSpent: totalSpent._sum.amount || 0,
      mostOrderedBundles: popularBundles.map(b => ({
        bundleId: b.bundleId,
        orderCount: b._count.bundleId
      }))
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/store-customer/recent-purchases
 * Get recently purchased bundles for quick reorder
 */
router.get('/recent-purchases', authenticateCustomer, async (req, res, next) => {
  try {
    const { storefrontSlug } = req.query;

    // Get recent distinct bundle purchases
    const recentOrders = await prisma.storefrontOrder.findMany({
      where: { 
        customerPhone: req.customer.phone,
        ...(storefrontSlug && { storefront: { slug: storefrontSlug } })
      },
      include: {
        bundle: {
          select: { id: true, name: true, network: true, dataAmount: true, validity: true }
        },
        storefront: {
          select: { slug: true, name: true }
        }
      },
      orderBy: { createdAt: 'desc' },
      take: 20
    });

    // Get unique bundles with order count
    const bundleMap = new Map();
    recentOrders.forEach(order => {
      if (!order.bundle) return;
      const key = `${order.bundle.id}:${order.storefront?.slug || 'unknown'}`;
      if (!bundleMap.has(key)) {
        bundleMap.set(key, {
          bundleId: order.bundle.id,
          bundle: order.bundle,
          store: order.storefront,
          lastOrderedAt: order.createdAt,
          orderCount: 1,
          lastAmount: order.amount
        });
      } else {
        bundleMap.get(key).orderCount++;
      }
    });

    res.json(Array.from(bundleMap.values()));
  } catch (error) {
    next(error);
  }
});

// ============================================
// FAVORITES ROUTES
// ============================================

/**
 * GET /api/store-customer/favorites
 * Get all favorites for the customer
 */
router.get('/favorites', authenticateCustomer, async (req, res, next) => {
  try {
    const { storefrontSlug } = req.query;

    const whereClause = { customerId: req.customer.id };
    if (storefrontSlug) {
      whereClause.storefront = { slug: storefrontSlug };
    }

    const favorites = await prisma.customerFavorite.findMany({
      where: whereClause,
      include: {
        bundle: {
          select: { id: true, name: true, network: true, dataAmount: true, validity: true, isActive: true }
        },
        storefront: {
          select: { slug: true, name: true, primaryColor: true }
        }
      },
      orderBy: { createdAt: 'desc' }
    });

    res.json(favorites.map(f => ({
      id: f.id,
      bundle: f.bundle,
      store: f.storefront,
      addedAt: f.createdAt
    })));
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/store-customer/favorites
 * Add a bundle to favorites
 */
router.post('/favorites', authenticateCustomer, async (req, res, next) => {
  try {
    const { bundleId, storefrontSlug } = req.body;

    if (!bundleId || !storefrontSlug) {
      return res.status(400).json({ error: 'Bundle ID and store are required' });
    }

    // Verify storefront exists
    const storefront = await prisma.storefront.findUnique({
      where: { slug: storefrontSlug },
      select: { id: true, name: true }
    });

    if (!storefront) {
      return res.status(404).json({ error: 'Store not found' });
    }

    // Verify bundle exists
    const bundle = await prisma.bundle.findUnique({
      where: { id: bundleId },
      select: { id: true, name: true }
    });

    if (!bundle) {
      return res.status(404).json({ error: 'Bundle not found' });
    }

    // Check if already favorited
    const existing = await prisma.customerFavorite.findFirst({
      where: {
        customerId: req.customer.id,
        bundleId,
        storefrontId: storefront.id
      }
    });

    if (existing) {
      return res.status(409).json({ error: 'Already in favorites' });
    }

    // Create favorite
    const favorite = await prisma.customerFavorite.create({
      data: {
        customerId: req.customer.id,
        bundleId,
        storefrontId: storefront.id
      }
    });

    res.status(201).json({
      message: 'Added to favorites',
      favorite: {
        id: favorite.id,
        bundleId,
        storeName: storefront.name
      }
    });
  } catch (error) {
    next(error);
  }
});

/**
 * DELETE /api/store-customer/favorites/:bundleId
 * Remove a bundle from favorites
 */
router.delete('/favorites/:bundleId', authenticateCustomer, async (req, res, next) => {
  try {
    const { bundleId } = req.params;
    const { storefrontSlug } = req.query;

    const whereClause = {
      customerId: req.customer.id,
      bundleId
    };

    if (storefrontSlug) {
      const storefront = await prisma.storefront.findUnique({
        where: { slug: storefrontSlug },
        select: { id: true }
      });
      if (storefront) {
        whereClause.storefrontId = storefront.id;
      }
    }

    const deleted = await prisma.customerFavorite.deleteMany({
      where: whereClause
    });

    if (deleted.count === 0) {
      return res.status(404).json({ error: 'Favorite not found' });
    }

    res.json({ message: 'Removed from favorites' });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/store-customer/favorites/check/:bundleId
 * Check if a bundle is favorited
 */
router.get('/favorites/check/:bundleId', authenticateCustomer, async (req, res, next) => {
  try {
    const { bundleId } = req.params;
    const { storefrontSlug } = req.query;

    const whereClause = {
      customerId: req.customer.id,
      bundleId
    };

    if (storefrontSlug) {
      whereClause.storefront = { slug: storefrontSlug };
    }

    const favorite = await prisma.customerFavorite.findFirst({
      where: whereClause
    });

    res.json({ isFavorite: !!favorite });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
