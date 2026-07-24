require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const path = require('path');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');

// ==================================================
// SECURITY: Validate critical secrets at startup
// ==================================================
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('FATAL: JWT_SECRET environment variable is not set');
  process.exit(1);
}
if (JWT_SECRET.length < 32) {
  console.error('FATAL: JWT_SECRET must be at least 32 characters');
  process.exit(1);
}
if (JWT_SECRET === 'your-super-secret-key' || JWT_SECRET === 'secret' || JWT_SECRET === 'changeme') {
  console.error('FATAL: JWT_SECRET is using a default/insecure value. Please set a strong secret.');
  process.exit(1);
}

// Import routes
const authRoutes = require('./routes/auth.routes');
const userRoutes = require('./routes/user.routes');
const walletRoutes = require('./routes/wallet.routes');
const orderRoutes = require('./routes/order.routes');
const bundleRoutes = require('./routes/bundle.routes');
const settingsRoutes = require('./routes/settings.routes');
const tenantRoutes = require('./routes/tenant.routes');
const adminRoutes = require('./routes/admin.routes');
const storefrontRoutes = require('./routes/storefront.routes');
const momoRoutes = require('./routes/momo.routes');
const storeCustomerRoutes = require('./routes/store-customer.routes');
const datahubRoutes = require('./routes/datahub.routes');
const ckgodswayRoutes = require('./routes/ckgodsway.routes');
const instantdataghRoutes = require('./routes/instantdatagh.routes');
const dataGatekeeperRoutes = require('./routes/datagatekeeper.routes');
const paystackRoutes = require('./routes/paystack.routes');
const profitPayoutRoutes = require('./routes/profit-payout.routes');
const topupghRoutes     = require('./routes/topupgh.routes');

// Import middleware
const errorHandler = require('./middleware/errorHandler');
const { resolveTenant, buildTenantFilter } = require('./middleware/tenant.middleware');

const app = express();
const PORT = process.env.PORT || 3000;
const isProduction = process.env.NODE_ENV === 'production';

// Trust proxy for services like Render, Railway, etc.
if (isProduction) {
  app.set('trust proxy', 1);
}

// HTTPS redirect in production
if (isProduction) {
  app.use((req, res, next) => {
    if (req.header('x-forwarded-proto') !== 'https') {
      return res.redirect(301, `https://${req.header('host')}${req.url}`);
    }
    next();
  });
}

// Compression middleware
app.use(compression());

// Rate limiting - Tiered by user role for scalability
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: (req) => {
    // Check if user is authenticated (token decoded by auth middleware later)
    // For now, use generous limit - auth routes have separate stricter limits
    if (!isProduction) return 2000; // Development: very high limit
    
    // Production limits based on endpoint patterns
    // Admin endpoints get higher limits
    if (req.path.includes('/admin')) return 500;
    
    // Default for all other API calls
    return 300; // Increased from 100 for growing client base
  },
  message: { error: 'Too many requests, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  // Use IP + User-Agent for better identification
  keyGenerator: (req) => {
    return req.ip + '-' + (req.headers['user-agent'] || 'unknown').substring(0, 50);
  }
});
app.use('/api/', limiter);

// Stricter rate limit for auth endpoints
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: isProduction ? 5 : 100, // Only 5 login attempts per 15 min in production
  message: { error: 'Too many login attempts, please try again in 15 minutes.' },
  skipSuccessfulRequests: true // Don't count successful logins
});
app.use('/api/auth/login', authLimiter);
app.use('/api/store-customer/login', authLimiter); // Also protect store customer login

// Security middleware with enhanced headers
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      "script-src": ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com", "https://kit.fontawesome.com", "https://ka-f.fontawesome.com", "https://js.paystack.co"],
      "script-src-attr": ["'unsafe-inline'"],
      "style-src": ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com", "https://ka-f.fontawesome.com", "https://fonts.googleapis.com", "https://paystack.com"],
      "img-src": ["'self'", "data:", "https://cdnjs.cloudflare.com", "https://ka-f.fontawesome.com"],
      "font-src": ["'self'", "https://ka-f.fontawesome.com", "https://cdnjs.cloudflare.com", "https://fonts.gstatic.com", "data:"],
      "connect-src": ["'self'", "https://ka-f.fontawesome.com", "https://api.paystack.co"],
      "frame-src": ["'self'", "https://checkout.paystack.com"],
    }
  },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  hsts: {
    maxAge: 31536000, // 1 year
    includeSubDomains: true,
    preload: true
  },
  noSniff: true,
  xssFilter: true,
  hidePoweredBy: true
}));

// Additional security headers
app.use((req, res, next) => {
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
});

// CORS configuration - STRICT in production
const allowedOrigins = isProduction 
  ? [
      'https://kemdataplus.onrender.com',
      'https://kemdataplus.com',
      'https://www.kemdataplus.com',
      process.env.FRONTEND_URL,
      process.env.STORE_DOMAIN ? `https://${process.env.STORE_DOMAIN}` : null,
      process.env.STORE_DOMAIN ? `https://www.${process.env.STORE_DOMAIN}` : null
    ].filter(Boolean)
  : ['http://localhost:8080', 'http://localhost:3000', 'http://127.0.0.1:8080', 'http://127.0.0.1:3000'];

app.use(cors({
  origin: function(origin, callback) {
    // In development, allow all origins including null
    if (!isProduction) {
      return callback(null, true);
    }
    
    // In production: Allow same-origin requests (origin is undefined for same-origin)
    // But block explicit null origin (can be from file:// or privacy redirects)
    if (origin === undefined) {
      return callback(null, true);
    }
    
    // In production, check allowed origins
    if (allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      console.warn(`CORS blocked request from unauthorized origin: ${origin}`);
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
}));

// Cookie parser (for httpOnly token cookies)
app.use(cookieParser());

// Generate unique request ID for tracing
app.use((req, res, next) => {
  req.requestId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  res.setHeader('X-Request-ID', req.requestId);
  next();
});

// Logging
app.use(morgan(isProduction ? 'combined' : 'dev'));

// IMPORTANT: Paystack webhook needs raw body for signature verification
// Must be mounted BEFORE express.json() middleware
app.use('/api/paystack/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const paystackService = require('./services/paystack.service');
    const profitPayoutService = require('./services/profit-payout.service');
    const signature = req.headers['x-paystack-signature'];
    const rawBody = req.body.toString();
    
    // Verify webhook signature
    if (!paystackService.verifyWebhookSignature(rawBody, signature)) {
      console.error('[Paystack] Invalid webhook signature');
      return res.status(401).json({ error: 'Invalid signature' });
    }
    
    const event = JSON.parse(rawBody);
    console.log(`[Paystack] Webhook received: ${event.event}`);
    
    // Handle transfer webhooks for profit payouts
    if (event.event === 'transfer.success') {
      const result = await profitPayoutService.handleTransferSuccess(event.data);
      console.log(`[Paystack] ✅ Transfer success processed:`, result);
      return res.status(200).json({ received: true, result });
    }
    
    if (event.event === 'transfer.failed') {
      const result = await profitPayoutService.handleTransferFailed(event.data);
      console.log(`[Paystack] ⚠️ Transfer failed processed:`, result);
      return res.status(200).json({ received: true, result });
    }
    
    if (event.event === 'transfer.reversed') {
      const result = await profitPayoutService.handleTransferReversed(event.data);
      console.log(`[Paystack] ↩️ Transfer reversed processed:`, result);
      return res.status(200).json({ received: true, result });
    }
    
    // Process charge webhooks (payments)
    const result = await paystackService.processWebhook(event);
    
    if (result.processed) {
      console.log(`[Paystack] ✅ Webhook processed: ${result.type || 'payment'}`);
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

// Body parsing (AFTER webhook route)
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ── Store domain routing ──────────────────────────────────────────────────────
// Requests arriving on STORE_DOMAIN (e.g. kemplus.store) are handled here.
// /:slug          → rewrite internally to /store/:slug so store.html is served
// /               → serve the landing page
// /admin, /pages  → blocked (404) — admin must stay on the main domain
// Everything else (API calls, static assets) → pass through normally
const STORE_DOMAIN = process.env.STORE_DOMAIN; // e.g. 'kemplus.store'
if (STORE_DOMAIN) {
  app.use((req, res, next) => {
    if (req.hostname !== STORE_DOMAIN) return next();
    const rawPath = req.path;
    // Block admin and pages routes on the store domain
    if (rawPath.startsWith('/admin') || rawPath.startsWith('/pages')) {
      return res.status(404).send('Not found');
    }
    // Pass through API calls and static asset requests unchanged
    if (rawPath.startsWith('/api') || rawPath.match(/\.(css|js|png|jpg|jpeg|ico|svg|gif|webp|woff|woff2|ttf|eot|json|xml|txt|webmanifest)$/i)) {
      return next();
    }
    // Bare domain root → landing page
    if (rawPath === '/' || rawPath === '') {
      return res.sendFile(path.join(__dirname, '../../client/public/store-landing.html'));
    }
    // /:slug → serve store page (rewrite so existing /store/:slug route handles it)
    const parts = rawPath.split('/').filter(Boolean);
    if (parts.length >= 1) {
      req.url = `/store/${parts[0]}`;
    }
    next();
  });
}

// Serve static files (frontend)
// Serve client/public files at root level for main dashboard
app.use('/css', express.static(path.join(__dirname, '../../client/public/css')));
app.use('/js', express.static(path.join(__dirname, '../../client/public/js')));
app.use('/img', express.static(path.join(__dirname, '../../client/public/img')));
app.use('/public', express.static(path.join(__dirname, '../../client/public'), { extensions: ['html'] }));
app.use('/pages', express.static(path.join(__dirname, '../../client/pages'), { extensions: ['html'] }));
app.use('/admin', express.static(path.join(__dirname, '../../client/admin'), { extensions: ['html'] }));
// Serve static files for storefront (e.g., /store/img/favicon.ico)
app.use('/store/img', express.static(path.join(__dirname, '../../client/public/img')));

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/wallet', walletRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/order-groups', require('./routes/order-group.routes'));
app.use('/api/bundles', bundleRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/tenants', tenantRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/storefronts', storefrontRoutes);
app.use('/api/momo', momoRoutes);
app.use('/api/store-customer', storeCustomerRoutes);
app.use('/api/datahub', datahubRoutes);
app.use('/api/ckgodsway', ckgodswayRoutes);
app.use('/api/instantdatagh', instantdataghRoutes);
app.use('/api/datagatekeeper', dataGatekeeperRoutes);
app.use('/api/paystack', paystackRoutes);
app.use('/api/profit-payouts', profitPayoutRoutes);
app.use('/api/complaints', require('./routes/complaint.routes'));
app.use('/api/topupgh',    topupghRoutes);

// Public storefront route (no auth required)
app.use('/api', storefrontRoutes);

// Multi-tenant request resolution (for tenant-scoped routes)
app.use('/api', resolveTenant);

// Health check
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    service: 'KemDataplus API',
    environment: process.env.NODE_ENV || 'development'
  });
});

// Serve frontend pages
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../../client/public/dashboard.html'));
});

// Public storefront page
app.get('/store/:slug', (req, res) => {
  res.sendFile(path.join(__dirname, '../../client/public/store.html'));
});

app.get('/pages/*', (req, res) => {
  const page = req.params[0];
  // Security: Sanitize path to prevent directory traversal
  const safePage = path.basename(page);
  const safePath = path.join(__dirname, '../../client/pages', safePage);
  const realPath = path.resolve(safePath);
  const allowedDir = path.resolve(__dirname, '../../client/pages');
  
  if (!realPath.startsWith(allowedDir)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  res.sendFile(realPath);
});

// Catch-all for SPA routing - serve index for non-API routes
app.get('*', (req, res, next) => {
  // Skip API routes
  if (req.path.startsWith('/api/')) {
    return next();
  }
  // Check if requesting a specific file
  if (req.path.includes('.')) {
    return next();
  }
  // Serve dashboard for all other routes
  res.sendFile(path.join(__dirname, '../../client/public/dashboard.html'));
});

// 404 handler for API routes
app.use('/api/*', (req, res) => {
  res.status(404).json({ error: 'API endpoint not found' });
});

// Error handling middleware
app.use(errorHandler);

// Start server
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 KemDataplus Server running on port ${PORT}`);
  console.log(`📚 API available at /api`);
  console.log(`🌐 Environment: ${process.env.NODE_ENV || 'development'}`);
  
  // ONE-TIME CLEANUP: Remove database triggers that were causing order processing failures
  // These triggers blocked all order.update({status}) calls in production
  cleanupDatabaseTriggers().catch(err => console.error('Trigger cleanup error:', err.message));

  // Load persisted settings from DB before starting auto-sync
  settingsController.initSettings()
    .then(() => startAutoSync())
    .catch(err => {
      console.error('[Settings] initSettings failed, starting auto-sync with defaults:', err.message);
      startAutoSync();
    });
  
  // Start profit payout scheduler (11:30 PM Ghana time)
  startProfitPayoutScheduler();

  // Start TopUpGH batch queue scheduler
  startTopUpGHScheduler();
});

// ============================================
// ONE-TIME: Clean up database triggers from financial hardening
// These triggers had a bug that blocked ALL order status updates
// ============================================
async function cleanupDatabaseTriggers() {
  const prismaCleanup = require('./lib/prisma');
  const drops = [
    'DROP TRIGGER IF EXISTS enforce_order_state_machine ON orders',
    'DROP TRIGGER IF EXISTS log_order_state_change ON orders',
    'DROP TRIGGER IF EXISTS prevent_wallet_double_deduction ON orders',
    'DROP FUNCTION IF EXISTS validate_order_state_transition() CASCADE',
    'DROP FUNCTION IF EXISTS log_order_state_transition() CASCADE',
    'DROP FUNCTION IF EXISTS prevent_double_wallet_deduction() CASCADE',
  ];
  
  for (const sql of drops) {
    try {
      await prismaCleanup.$executeRawUnsafe(sql);
    } catch (e) {
      // Ignore errors - trigger may not exist
    }
  }
  
  // Clear orphaned orders: reset apiSentAt for PENDING orders with no externalReference
  // ONLY for orders older than 10 minutes — recent orders may still be in-flight!
  // Resetting apiSentAt on in-flight orders causes DUPLICATE deliveries.
  const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
  try {
    const result = await prismaCleanup.order.updateMany({
      where: {
        status: 'PENDING',
        apiSentAt: { not: null },
        externalReference: null,
        updatedAt: { lt: tenMinutesAgo }  // Only reset if stale >10 min
      },
      data: {
        apiSentAt: null,
        failureReason: null
      }
    });
    if (result.count > 0) {
      console.log(`[Cleanup] Reset ${result.count} orphaned PENDING orders (>10min old) for retry`);
    }
  } catch (e) {
    console.warn(`[Cleanup] Order cleanup error: ${e.message}`);
  }
  
  // Same for OrderItems — only reset if stale >10 min
  try {
    const result = await prismaCleanup.orderItem.updateMany({
      where: {
        status: 'PENDING',
        apiSentAt: { not: null },
        externalReference: null,
        updatedAt: { lt: tenMinutesAgo }  // Only reset if stale >10 min
      },
      data: {
        apiSentAt: null,
        failureReason: null
      }
    });
    if (result.count > 0) {
      console.log(`[Cleanup] Reset ${result.count} orphaned PENDING OrderItems (>10min old) for retry`);
    }
  } catch (e) {
    console.warn(`[Cleanup] OrderItem cleanup error: ${e.message}`);
  }
  
  console.log('✅ Database trigger cleanup complete');
}

// ============================================
// AUTO-SYNC: Background job for order status
// ============================================
const settingsController = require('./controllers/settings.controller');
const datahubService = require('./services/datahub.service');
const orderGroupService = require('./services/order-group.service');
const profitScheduler = require('./services/profit-scheduler');
const topupghBatchService = require('./services/topupgh-batch.service');

let autoSyncInterval = null;
const AUTO_SYNC_INTERVAL_MS = 30 * 1000; // 30 seconds
let autoSyncRunning = false; // guard: prevent overlapping cycles

// Start profit payout scheduler
function startProfitPayoutScheduler() {
  try {
    profitScheduler.startScheduler();
  } catch (err) {
    console.error('[Server] Failed to start profit scheduler:', err.message);
  }
}

// Start TopUpGH batch queue + delivery sync scheduler
function startTopUpGHScheduler() {
  try {
    topupghBatchService.startScheduler();
  } catch (err) {
    console.error('[Server] Failed to start TopUpGH scheduler:', err.message);
  }
}

function startAutoSync() {
  // Clear any existing interval
  if (autoSyncInterval) {
    clearInterval(autoSyncInterval);
  }

  const syncState = require('./lib/sync-state');

  // Check settings and start if enabled
  const checkAndSync = async () => {
    // Skip this tick if the previous cycle hasn't finished yet
    if (autoSyncRunning) {
      console.log('[AutoSync] Previous cycle still running — skipping this tick');
      return;
    }
    // Skip this tick if an admin-triggered Sync All is running —
    // both hitting MCBIS at the same time causes rate-limit collisions
    if (syncState.syncAllRunning) {
      console.log('[AutoSync] Sync All in progress — yielding this tick to avoid rate-limit collision');
      return;
    }
    autoSyncRunning = true;
    try {
      const siteSettings = settingsController.getSiteSettings();
      
      // Check which auto-sync toggles are enabled
      const mcbisAutoSyncEnabled = siteSettings.mcbisAutoSync;
      const ckgodswayAutoSyncEnabled = siteSettings.ckgodswayAutoSync;
      
      // Check which APIs are active
      const mcbisActive = siteSettings.mcbisAPI;
      const ckgodswayActive = siteSettings.ckgodswayAPI;
      const datagatekeeperActive = siteSettings.datagatekeeperAPI;
      
      // Skip entirely if no API is enabled at all
      if (!mcbisActive && !ckgodswayActive && !datagatekeeperActive) {
        return; // No API enabled
      }
      
      // If only DGK is active (MCBIS/CKGodsway auto-syncs off), still allow
      // retryStuckPendingOrders to run — skip only the status-sync steps below.
      const anyAutoSyncEnabled = mcbisAutoSyncEnabled || ckgodswayAutoSyncEnabled;
      
      const mcbisShouldSync = mcbisAutoSyncEnabled && mcbisActive;
      const ckgodswayShouldSync = ckgodswayAutoSyncEnabled && ckgodswayActive;
      
      console.log(`[AutoSync] Running... (MCBIS AutoSync: ${mcbisShouldSync ? 'ON' : 'OFF'}, CKGodsway AutoSync: ${ckgodswayShouldSync ? 'ON' : 'OFF'}, DGK: ${datagatekeeperActive ? 'ON' : 'OFF'})`);
      
      let totalSynced = 0;
      let totalCompleted = 0;
      let totalFailed = 0;
      let totalRetried = 0;
      
      // 1. Sync LEGACY Order table (if MCBIS auto-sync is enabled)
      if (mcbisShouldSync) {
        try {
          const legacyResult = await datahubService.syncAllPendingOrders();
          if (legacyResult.synced > 0) {
            console.log(`[AutoSync] Legacy Orders (MCBIS): synced ${legacyResult.synced}`);
            totalSynced += legacyResult.synced;
          }
        } catch (err) {
          console.error(`[AutoSync] Legacy sync error:`, err?.message || err?.toString() || JSON.stringify(err) || 'Unknown error');
        }
      }
      
      // 2. Sync NEW OrderItem table (check per-item which API it belongs to)
      try {
        const itemResult = await orderGroupService.syncAllProcessingItems({
          mcbisEnabled: mcbisShouldSync,
          ckgodswayEnabled: ckgodswayShouldSync,
          datagatekeeperEnabled: true
        });
        if (itemResult.total > 0) {
          console.log(`[AutoSync] OrderItems: ${itemResult.completed} completed, ${itemResult.failed} failed, ${itemResult.unchanged} unchanged`);
          totalCompleted += itemResult.completed;
          totalFailed += itemResult.failed;
        }
      } catch (err) {
        console.error(`[AutoSync] OrderItem sync error:`, err.message);
      }
      
      // 3. Retry stuck PENDING orders (orders that were placed when API was OFF)
      // Only runs if at least one API is enabled
      try {
        const retryResult = await orderGroupService.retryStuckPendingOrders();
        if (retryResult.retried > 0) {
          console.log(`[AutoSync] Retried ${retryResult.retried} stuck orders, ${retryResult.success} had items processed`);
          totalRetried += retryResult.retried;
        }
      } catch (err) {
        console.error(`[AutoSync] Retry stuck orders error:`, err.message);
      }
      
      // Log summary if anything changed
      if (totalCompleted > 0 || totalFailed > 0 || totalRetried > 0) {
        console.log(`[AutoSync] ✅ Summary: ${totalCompleted} completed, ${totalFailed} failed, ${totalRetried} retried`);
      }
      
    } catch (error) {
      console.error(`[AutoSync] Error:`, error.message);
    } finally {
      autoSyncRunning = false;
    }
  };
  
  // Run immediately on startup, then every interval
  setTimeout(checkAndSync, 10000); // First run after 10 seconds
  autoSyncInterval = setInterval(checkAndSync, AUTO_SYNC_INTERVAL_MS);
  
  console.log(`🔄 Auto-sync initialized (every ${AUTO_SYNC_INTERVAL_MS / 1000}s)`);
}

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully...');
  
  // Stop auto-sync
  if (autoSyncInterval) {
    clearInterval(autoSyncInterval);
    console.log('Auto-sync stopped');
  }
  
  // Stop profit scheduler
  profitScheduler.stopScheduler();
  
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

module.exports = app;
