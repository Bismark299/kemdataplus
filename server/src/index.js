require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const path = require('path');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');

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

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: isProduction ? 100 : 1000, // limit each IP
  message: { error: 'Too many requests, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/', limiter);

// Stricter rate limit for auth endpoints
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: isProduction ? 10 : 100,
  message: { error: 'Too many login attempts, please try again later.' }
});
app.use('/api/auth/login', authLimiter);
app.use('/api/store-customer/login', authLimiter); // Also protect store customer login

// Security middleware
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      "script-src": ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com", "https://kit.fontawesome.com", "https://ka-f.fontawesome.com"],
      "script-src-attr": ["'unsafe-inline'"],
      "style-src": ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com", "https://ka-f.fontawesome.com", "https://fonts.googleapis.com"],
      "img-src": ["'self'", "data:", "https://cdnjs.cloudflare.com", "https://ka-f.fontawesome.com"],
      "font-src": ["'self'", "https://ka-f.fontawesome.com", "https://cdnjs.cloudflare.com", "https://fonts.gstatic.com", "data:"],
      "connect-src": ["'self'", "https://ka-f.fontawesome.com"],
    }
  }
}));

// CORS configuration - STRICT in production
const allowedOrigins = isProduction 
  ? [process.env.FRONTEND_URL || 'https://kemdataplus.com'].filter(Boolean)
  : ['http://localhost:8080', 'http://localhost:3000', 'http://127.0.0.1:8080', 'http://127.0.0.1:3000'];

app.use(cors({
  origin: function(origin, callback) {
    // Allow requests with no origin (same-origin, mobile apps, server-to-server)
    if (!origin) return callback(null, true);
    
    // In development, allow all origins
    if (!isProduction) {
      return callback(null, true);
    }
    
    // In production, strictly check allowed origins
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

// Logging
app.use(morgan(isProduction ? 'combined' : 'dev'));

// Body parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Serve static files (frontend)
// Serve client/public files at root level for main dashboard
app.use('/css', express.static(path.join(__dirname, '../../client/public/css')));
app.use('/js', express.static(path.join(__dirname, '../../client/public/js')));
app.use('/img', express.static(path.join(__dirname, '../../client/public/img')));
app.use('/public', express.static(path.join(__dirname, '../../client/public')));
app.use('/pages', express.static(path.join(__dirname, '../../client/pages')));
app.use('/admin', express.static(path.join(__dirname, '../../client/admin')));

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/wallet', walletRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/bundles', bundleRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/tenants', tenantRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/storefronts', storefrontRoutes);
app.use('/api/momo', momoRoutes);
app.use('/api/store-customer', storeCustomerRoutes);

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
  res.sendFile(path.join(__dirname, `../../client/pages/${page}`));
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
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully...');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

module.exports = app;
