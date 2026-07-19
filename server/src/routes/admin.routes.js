/**
 * ADMIN CONTROL ROUTES
 * =====================
 * Admin-only endpoints for system oversight and control.
 */

const express = require('express');
const router = express.Router();
const { authenticate, authorize } = require('../middleware/auth');
const tenantService = require('../services/tenant.service');
const pricingEngine = require('../services/pricing.service');
const profitService = require('../services/profit.service');
const profitPayoutService = require('../services/profit-payout.service');
const walletService = require('../services/wallet.service');
const auditService = require('../services/audit.service');
const alertService = require('../services/alert.service');
const jobQueueService = require('../services/job-queue.service');
const smsService = require('../services/sms.service');

const prisma = require('../lib/prisma');

// All routes require ADMIN role
router.use(authenticate);
router.use(authorize('ADMIN'));

/**
 * ========== HIERARCHY OVERVIEW ==========
 */

/**
 * GET /api/admin/hierarchy
 * View full reseller hierarchy
 */
router.get('/hierarchy', async (req, res, next) => {
  try {
    const root = await tenantService.getRootTenant();
    
    // Build full tree
    const buildTree = async (tenantId, level = 0) => {
      const tenant = await prisma.tenant.findUnique({
        where: { id: tenantId },
        include: {
          children: true,
          _count: {
            select: { users: true }
          }
        }
      });

      if (!tenant) return null;

      const children = await Promise.all(
        tenant.children.map(c => buildTree(c.id, level + 1))
      );

      return {
        id: tenant.id,
        name: tenant.name,
        slug: tenant.slug,
        level,
        status: tenant.status,
        userCount: tenant._count.users,
        children: children.filter(c => c !== null)
      };
    };

    const tree = await buildTree(root.id);
    res.json(tree);
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/admin/hierarchy/flat
 * Get flat list of all tenants with hierarchy info
 */
router.get('/hierarchy/flat', async (req, res, next) => {
  try {
    const tenants = await prisma.tenant.findMany({
      include: {
        parent: {
          select: { id: true, name: true }
        },
        _count: {
          select: { users: true, children: true }
        }
      },
      orderBy: { hierarchyLevel: 'asc' }
    });

    res.json(tenants.map(t => ({
      id: t.id,
      name: t.name,
      slug: t.slug,
      level: t.hierarchyLevel,
      parent: t.parent,
      status: t.status,
      userCount: t._count.users,
      subTenantCount: t._count.children
    })));
  } catch (error) {
    next(error);
  }
});

/**
 * ========== PRICE CONTROL ==========
 */

/**
 * GET /api/admin/prices/ladder/:bundleId
 * Inspect price ladder for a bundle across all tenants
 */
router.get('/prices/ladder/:bundleId', async (req, res, next) => {
  try {
    const bundle = await prisma.bundle.findUnique({
      where: { id: req.params.bundleId },
      include: {
        prices: true,
        tenantPrices: {
          include: {
            tenant: {
              select: { id: true, name: true, hierarchyLevel: true }
            }
          }
        }
      }
    });

    if (!bundle) {
      return res.status(404).json({ error: 'Bundle not found' });
    }

    res.json({
      bundle: {
        id: bundle.id,
        name: bundle.name,
        network: bundle.network,
        baseCost: bundle.baseCost,
        basePrice: bundle.basePrice
      },
      systemPrices: bundle.prices,
      tenantPrices: bundle.tenantPrices.map(tp => ({
        tenant: tp.tenant,
        role: tp.role,
        price: tp.price,
        isValid: tp.isValid,
        parentPriceAtCreation: tp.parentPriceAtCreation
      }))
    });
  } catch (error) {
    next(error);
  }
});

/**
 * PUT /api/admin/prices/system
 * Update system-wide role prices
 */
router.put('/prices/system', async (req, res, next) => {
  try {
    const { bundleId, prices } = req.body;

    if (!bundleId || !prices) {
      return res.status(400).json({ error: 'bundleId and prices are required' });
    }

    const result = await pricingEngine.updateSystemRolePrices(bundleId, prices, req.user.id);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/admin/prices/revert/:tenantId
 * Revert tenant prices to parent/system defaults
 */
router.post('/prices/revert/:tenantId', async (req, res, next) => {
  try {
    const { bundleId, role } = req.body;

    await prisma.tenantBundlePrice.deleteMany({
      where: {
        tenantId: req.params.tenantId,
        ...(bundleId && { bundleId }),
        ...(role && { role })
      }
    });

    await auditService.log({
      userId: req.user.id,
      tenantId: req.params.tenantId,
      action: 'ADMIN_OVERRIDE',
      entityType: 'TenantBundlePrice',
      metadata: {
        action: 'REVERT_PRICES',
        bundleId,
        role
      }
    });

    res.json({ success: true, message: 'Prices reverted to defaults' });
  } catch (error) {
    next(error);
  }
});

/**
 * ========== PROFIT OVERSIGHT ==========
 */

/**
 * GET /api/admin/profits/flow/:orderId
 * See profit flow for a specific order
 */
router.get('/profits/flow/:orderId', async (req, res, next) => {
  try {
    const flow = await profitService.getOrderProfitFlow(req.params.orderId);
    res.json(flow);
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/admin/profits/report
 * Get profit report for a tenant/period
 */
router.get('/profits/report', async (req, res, next) => {
  try {
    const { tenantId, startDate, endDate } = req.query;

    if (!startDate || !endDate) {
      return res.status(400).json({ error: 'startDate and endDate are required' });
    }

    const report = await profitService.getTenantProfitReport(
      tenantId || null,
      startDate,
      endDate
    );

    res.json(report);
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/admin/profits/distribute
 * Manually trigger profit distribution for pending orders
 */
router.post('/profits/distribute', async (req, res, next) => {
  try {
    const result = await profitService.creditPendingProfits();

    await auditService.log({
      userId: req.user.id,
      action: 'ADMIN_OVERRIDE',
      entityType: 'ProfitDistribution',
      metadata: { action: 'MANUAL_DISTRIBUTION', result }
    });

    res.json(result);
  } catch (error) {
    next(error);
  }
});

/**
 * ========== WALLET CONTROL ==========
 */

/**
 * POST /api/admin/wallets/:userId/freeze
 * Freeze a user's wallet
 */
router.post('/wallets/:userId/freeze', async (req, res, next) => {
  try {
    const { reason } = req.body;
    if (!reason) {
      return res.status(400).json({ error: 'Reason is required' });
    }

    const wallet = await walletService.freezeWallet(req.params.userId, reason, req.user.id);
    res.json(wallet);
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/admin/wallets/:userId/unfreeze
 * Unfreeze a user's wallet
 */
router.post('/wallets/:userId/unfreeze', async (req, res, next) => {
  try {
    const wallet = await walletService.unfreezeWallet(req.params.userId, req.user.id);
    res.json(wallet);
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/admin/wallets/:userId/adjust
 * Admin adjustment (credit/debit with audit)
 */
router.post('/wallets/:userId/adjust', async (req, res, next) => {
  try {
    const { amount, type, reason } = req.body;

    if (!amount || !type || !reason) {
      return res.status(400).json({ error: 'amount, type, and reason are required' });
    }

    const reference = `ADMIN-ADJ-${Date.now()}`;

    let result;
    if (type === 'credit') {
      result = await walletService.creditWallet(
        req.params.userId,
        parseFloat(amount),
        `Admin adjustment: ${reason}`,
        reference,
        { entryType: 'DEPOSIT', adjustedBy: req.user.id }
      );
    } else {
      result = await walletService.debitWallet(
        req.params.userId,
        parseFloat(amount),
        `Admin adjustment: ${reason}`,
        reference,
        { entryType: 'WITHDRAWAL', adjustedBy: req.user.id }
      );
    }

    await auditService.logAdminOverride({
      adminId: req.user.id,
      entityType: 'Wallet',
      entityId: req.params.userId,
      overrideType: 'WALLET_ADJUSTMENT',
      reason,
      newValues: { amount, type }
    });

    res.json(result);
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/admin/wallets/:walletId/verify
 * Verify wallet ledger integrity
 */
router.get('/wallets/:walletId/verify', async (req, res, next) => {
  try {
    const result = await walletService.verifyLedgerIntegrity(req.params.walletId);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

/**
 * ========== TENANT CONTROL ==========
 */

/**
 * POST /api/admin/tenants/:id/disable-subsite
 * Instantly disable sub-site generation for a tenant
 */
router.post('/tenants/:id/disable-subsite', async (req, res, next) => {
  try {
    const tenant = await prisma.tenant.update({
      where: { id: req.params.id },
      data: {
        canCreateSubTenant: false,
        maxSubTenants: 0
      }
    });

    await auditService.log({
      userId: req.user.id,
      tenantId: tenant.id,
      action: 'ADMIN_OVERRIDE',
      entityType: 'Tenant',
      entityId: tenant.id,
      metadata: { action: 'DISABLE_SUBSITE_CREATION' }
    });

    res.json({ success: true, tenant });
  } catch (error) {
    next(error);
  }
});

/**
 * ========== AUDIT & COMPLIANCE ==========
 */

/**
 * GET /api/admin/audit/logs
 * Query audit logs
 */
router.get('/audit/logs', async (req, res, next) => {
  try {
    const { userId, tenantId, action, entityType, startDate, endDate, page, limit } = req.query;

    const result = await auditService.queryLogs(
      {
        userId,
        tenantId,
        action,
        entityType,
        startDate,
        endDate
      },
      {
        page: parseInt(page) || 1,
        limit: parseInt(limit) || 50
      }
    );

    res.json(result);
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/admin/audit/entity/:type/:id
 * Get audit trail for specific entity
 */
router.get('/audit/entity/:type/:id', async (req, res, next) => {
  try {
    const trail = await auditService.getEntityAuditTrail(req.params.type, req.params.id);
    res.json(trail);
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/admin/audit/security-alerts
 * Get security alerts
 */
router.get('/audit/security-alerts', async (req, res, next) => {
  try {
    const { tenantId, hours } = req.query;
    const alerts = await auditService.getSecurityAlerts(tenantId, parseInt(hours) || 24);
    res.json(alerts);
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/admin/audit/compliance-report
 * Generate compliance report
 */
router.get('/audit/compliance-report', async (req, res, next) => {
  try {
    const { tenantId, startDate, endDate } = req.query;

    if (!startDate || !endDate) {
      return res.status(400).json({ error: 'startDate and endDate are required' });
    }

    const report = await auditService.generateComplianceReport(tenantId, startDate, endDate);
    res.json(report);
  } catch (error) {
    next(error);
  }
});

/**
 * ========== FEATURE FLAGS ==========
 */

/**
 * GET /api/admin/features
 * List all feature flags
 */
router.get('/features', async (req, res, next) => {
  try {
    const features = await prisma.featureFlag.findMany();
    res.json(features);
  } catch (error) {
    next(error);
  }
});

/**
 * PUT /api/admin/features/:name
 * Update feature flag
 */
router.put('/features/:name', async (req, res, next) => {
  try {
    const { isEnabled, tenantIds, roleAccess } = req.body;

    const feature = await prisma.featureFlag.upsert({
      where: { name: req.params.name },
      update: {
        isEnabled: isEnabled !== undefined ? isEnabled : undefined,
        tenantIds: tenantIds !== undefined ? tenantIds : undefined,
        roleAccess: roleAccess !== undefined ? roleAccess : undefined
      },
      create: {
        name: req.params.name,
        isEnabled: isEnabled || false,
        tenantIds: tenantIds || [],
        roleAccess: roleAccess || []
      }
    });

    await auditService.log({
      userId: req.user.id,
      action: 'UPDATE',
      entityType: 'FeatureFlag',
      entityId: feature.id,
      newValues: feature
    });

    res.json(feature);
  } catch (error) {
    next(error);
  }
});

/**
 * ========== SYSTEM OVERVIEW ==========
 */

/**
 * GET /api/admin/dashboard
 * Admin dashboard statistics
 */
router.get('/dashboard', async (req, res, next) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const [
      totalUsers,
      totalTenants,
      activeTenants,
      todayOrders,
      todayRevenue,
      pendingProfits,
      frozenWallets
    ] = await Promise.all([
      prisma.user.count(),
      prisma.tenant.count(),
      prisma.tenant.count({ where: { status: 'ACTIVE' } }),
      prisma.order.count({ where: { createdAt: { gte: today } } }),
      prisma.order.aggregate({
        where: { createdAt: { gte: today }, status: 'COMPLETED' },
        _sum: { totalPrice: true }
      }),
      prisma.profitRecord.count({ where: { status: 'PENDING' } }),
      prisma.wallet.count({ where: { isFrozen: true } })
    ]);

    res.json({
      users: totalUsers,
      tenants: {
        total: totalTenants,
        active: activeTenants
      },
      today: {
        orders: todayOrders,
        revenue: todayRevenue._sum.totalPrice || 0
      },
      pendingProfits,
      frozenWallets
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/admin/dashboard-stats
 * Fast aggregated dashboard stats using SQL - replaces heavy client-side computation
 */
router.get('/dashboard-stats', async (req, res, next) => {
  try {
    const dateFilter = req.query.date || null; // YYYY-MM-DD or empty for today

    // Determine the target date range
    let dayStart, dayEnd;
    if (dateFilter) {
      dayStart = new Date(dateFilter + 'T00:00:00.000Z');
      dayEnd = new Date(dateFilter + 'T23:59:59.999Z');
    } else {
      const now = new Date();
      dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0));
      dayEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 59, 59, 999));
    }

    const dateWhere = { createdAt: { gte: dayStart, lte: dayEnd } };

    // Step 1: Get OrderGroup displayIds for deduplication
    // Legacy orders whose reference matches an OrderGroup displayId are duplicates
    const orderGroupDisplayIds = await prisma.orderGroup.findMany({
      where: { createdAt: dateWhere.createdAt, displayId: { not: null } },
      select: { displayId: true }
    });
    const displayIdSet = new Set(orderGroupDisplayIds.map(g => g.displayId));

    // Legacy orders must exclude duplicates (same logic as /admin/all endpoint)
    const legacyDateWhere = {
      ...dateWhere,
      ...(displayIdSet.size > 0 ? { reference: { notIn: Array.from(displayIdSet) } } : {})
    };

    // Run all aggregations in parallel for maximum speed
    const [
      // OrderItem stats by status for the target date
      itemStatusStats,
      // Legacy Order stats by status for the target date (deduplicated)
      legacyStatusStats,
      // Total wallet balance across all users
      walletAgg,
      // Pending OrderItems with bundle info for network counts
      itemPendingByNetwork,
      // Pending legacy orders with bundle info (deduplicated)
      legacyPendingByNetwork,
      // All OrderItems for date - for capacity + per-row cost calc
      allItemsForDate,
      // All legacy orders for date (deduplicated)
      allLegacyForDate
    ] = await Promise.all([
      // OrderItem counts/amounts grouped by status
      prisma.orderItem.groupBy({
        by: ['status'],
        where: { createdAt: dateWhere.createdAt },
        _count: true,
        _sum: { totalPrice: true }
      }),
      // Legacy Order counts/amounts grouped by status (deduplicated)
      prisma.order.groupBy({
        by: ['status'],
        where: legacyDateWhere,
        _count: true,
        _sum: { totalPrice: true }
      }),
      // Wallet balance sum
      prisma.wallet.aggregate({
        _sum: { balance: true }
      }),
      // Pending OrderItems with bundle info for network counts
      prisma.orderItem.findMany({
        where: { ...dateWhere, status: 'PENDING' },
        select: { bundle: { select: { network: true } } }
      }),
      // Pending legacy orders with bundle info (deduplicated)
      prisma.order.findMany({
        where: { ...legacyDateWhere, status: 'PENDING' },
        select: { bundle: { select: { network: true } } }
      }),
      // All OrderItems for date - get data amounts, cost, price for capacity + profit calc
      prisma.orderItem.findMany({
        where: { createdAt: dateWhere.createdAt },
        select: {
          status: true,
          totalPrice: true,
          baseCost: true,
          quantity: true,
          bundle: { select: { dataAmount: true, basePrice: true } }
        }
      }),
      // All legacy orders for date (deduplicated)
      prisma.order.findMany({
        where: legacyDateWhere,
        select: {
          status: true,
          totalPrice: true,
          baseCost: true,
          quantity: true,
          bundle: { select: { dataAmount: true, basePrice: true } }
        }
      })
    ]);

    // Merge status stats from both sources
    const statusMap = { PENDING: { count: 0, amount: 0, capacity: 0 }, PROCESSING: { count: 0, amount: 0, capacity: 0 }, COMPLETED: { count: 0, amount: 0, capacity: 0 }, CANCELLED: { count: 0, amount: 0, capacity: 0 } };

    // Helper to parse data capacity
    const parseCapacity = (dataAmount, qty) => {
      const gb = parseInt(String(dataAmount || '').replace(/\D/g, '')) || 0;
      return gb * (qty || 1);
    };

    // Process OrderItems
    for (const row of itemStatusStats) {
      const key = row.status;
      if (statusMap[key]) {
        statusMap[key].count += row._count;
        statusMap[key].amount += row._sum.totalPrice || 0;
      }
    }
    // Process legacy orders (already deduplicated via legacyDateWhere)
    for (const row of legacyStatusStats) {
      const key = row.status;
      if (statusMap[key]) {
        statusMap[key].count += row._count;
        statusMap[key].amount += row._sum.totalPrice || 0;
      }
    }

    // Calculate capacity and per-row cost from individual items
    let totalSold = 0;
    let totalCost = 0;

    const processItems = (items) => {
      for (const item of items) {
        const key = item.status;
        if (statusMap[key]) {
          statusMap[key].capacity += parseCapacity(item.bundle?.dataAmount, item.quantity);
        }
        // Per-row profit: only count COMPLETED orders
        if (key === 'COMPLETED') {
          const price = item.totalPrice || 0;
          const bundleBasePrice = item.bundle?.basePrice || 0;
          const cost = (item.baseCost && item.baseCost > 0)
            ? item.baseCost
            : (bundleBasePrice > 0 ? bundleBasePrice * (item.quantity || 1) : price * 0.95);
          totalSold += price;
          totalCost += cost;
        }
      }
    };

    processItems(allItemsForDate);
    processItems(allLegacyForDate);

    const totalProfit = totalSold - totalCost;

    // All orders for date
    const totalOrders = Object.values(statusMap).reduce((s, v) => s + v.count, 0);
    const totalAmount = Object.values(statusMap).reduce((s, v) => s + v.amount, 0);
    const totalCapacity = Object.values(statusMap).reduce((s, v) => s + v.capacity, 0);

    // Network pending counts
    const networkPending = { MTN: 0, Telecel: 0, AirtelTigo: 0, 'AT-BigTime': 0 };
    const countNetwork = (items) => {
      for (const item of items) {
        const net = (item.bundle?.network || '').toUpperCase();
        if (net.includes('MTN')) networkPending.MTN++;
        else if (net.includes('TELECEL')) networkPending.Telecel++;
        else if (net.includes('BIG TIME') || net.includes('BIGTIME')) networkPending['AT-BigTime']++;
        else if (net.includes('AIRTELTIGO') || net.includes('AIRTEL')) networkPending.AirtelTigo++;
      }
    };
    countNetwork(itemPendingByNetwork);
    countNetwork(legacyPendingByNetwork);

    res.json({
      totalOrders,
      totalAmount,
      totalCapacity,
      completedAmount: totalSold,
      totalSold,
      totalCost,
      totalProfit,
      walletBalance: walletAgg._sum.balance || 0,
      byStatus: {
        pending: statusMap.PENDING,
        processing: statusMap.PROCESSING,
        completed: statusMap.COMPLETED,
        cancelled: statusMap.CANCELLED
      },
      networkPending
    });
  } catch (error) {
    console.error('[Dashboard Stats] Error:', error);
    next(error);
  }
});

/**
 * ========== STOREFRONT MONITORING ==========
 */

/**
 * GET /api/admin/storefronts
 * Get all storefronts with stats
 */
router.get('/storefronts', async (req, res, next) => {
  try {
    const { page = 1, limit = 20, status, search } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const where = {};
    if (status) where.status = status;
    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { slug: { contains: search, mode: 'insensitive' } },
        { owner: { name: { contains: search, mode: 'insensitive' } } }
      ];
    }

    const [storefronts, total] = await Promise.all([
      prisma.storefront.findMany({
        where,
        include: {
          owner: {
            select: { id: true, name: true, email: true, phone: true, role: true }
          },
          _count: {
            select: { customerOrders: true, products: true }
          }
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: parseInt(limit)
      }),
      prisma.storefront.count({ where })
    ]);

    res.json({
      storefronts: storefronts.map(s => ({
        id: s.id,
        name: s.name,
        slug: s.slug,
        status: s.status,
        paystackEnabled: s.paystackEnabled,
        owner: s.owner,
        totalOrders: s._count.customerOrders,
        totalProducts: s._count.products,
        totalRevenue: s.totalRevenue,
        viewCount: s.viewCount,
        createdAt: s.createdAt
      })),
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit))
      }
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/admin/storefronts/:id
 * Get storefront details
 */
router.get('/storefronts/:id', async (req, res, next) => {
  try {
    const storefront = await prisma.storefront.findUnique({
      where: { id: req.params.id },
      include: {
        owner: {
          select: { id: true, name: true, email: true, phone: true, role: true, wallet: true }
        },
        products: {
          include: { bundle: true }
        },
        customerOrders: {
          take: 10,
          orderBy: { createdAt: 'desc' },
          include: {
            bundle: true,
            order: { select: { status: true } }
          }
        }
      }
    });

    if (!storefront) {
      return res.status(404).json({ error: 'Storefront not found' });
    }

    res.json(storefront);
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/admin/storefront-orders
 * Get all storefront orders across all stores
 */
router.get('/storefront-orders', async (req, res, next) => {
  try {
    const { 
      page = 1, 
      limit = 50, 
      status, 
      paymentMethod, 
      profitStatus,
      storefrontId,
      search,
      dateFrom,
      dateTo 
    } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const where = {};
    if (status) where.status = status;
    if (paymentMethod) where.paymentMethod = paymentMethod;
    if (storefrontId) where.storefrontId = storefrontId;
    if (profitStatus === 'credited') where.profitCredited = true;
    if (profitStatus === 'pending') where.profitCredited = false;
    
    // Date range filter
    if (dateFrom || dateTo) {
      where.createdAt = {};
      if (dateFrom) {
        where.createdAt.gte = new Date(dateFrom);
      }
      if (dateTo) {
        // Add 1 day to include the entire end date
        const endDate = new Date(dateTo);
        endDate.setDate(endDate.getDate() + 1);
        where.createdAt.lte = endDate;
      }
    }
    
    if (search) {
      where.OR = [
        { customerPhone: { contains: search } },
        { customerName: { contains: search, mode: 'insensitive' } },
        { id: { contains: search } }
      ];
    }

    const [orders, total] = await Promise.all([
      prisma.storefrontOrder.findMany({
        where,
        include: {
          storefront: {
            select: { id: true, name: true, slug: true, owner: { select: { name: true } } }
          },
          bundle: {
            select: { name: true, network: true, dataAmount: true }
          },
          order: {
            select: { id: true, status: true, reference: true, externalReference: true }
          }
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: parseInt(limit)
      }),
      prisma.storefrontOrder.count({ where })
    ]);

    res.json({
      orders: orders.map(o => ({
        id: o.id,
        storefront: o.storefront,
        customerPhone: o.customerPhone,
        customerName: o.customerName,
        bundle: o.bundle,
        amount: o.amount,
        ownerCost: o.ownerCost,
        ownerProfit: o.ownerProfit,
        supplierCost: o.supplierCost,
        platformProfit: o.platformProfit,
        // Use storefront order status as primary (matches what vendors see)
        // Fall back to main order status for completed/failed
        status: o.order?.status === 'COMPLETED' || o.order?.status === 'FAILED' 
          ? o.order.status 
          : o.status,
        fulfillmentStatus: o.order?.status || null,  // Main order fulfillment status
        paymentStatus: o.paymentStatus,
        paymentMethod: o.paymentMethod || 'MOMO',
        paymentReference: o.paymentReference,  // MoMo transaction reference
        paymentPhone: o.paymentPhone,          // Phone customer paid from
        paystackReference: o.paystackReference, // Paystack reference
        profitCredited: o.profitCredited,
        profitCreditedAt: o.profitCreditedAt,
        orderId: o.orderId,
        mainOrderRef: o.order?.reference,
        externalRef: o.order?.externalReference,
        createdAt: o.createdAt
      })),
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit))
      }
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/admin/storefront-orders/:id
 * Get detailed storefront order with full financial breakdown
 */
router.get('/storefront-orders/:id', async (req, res, next) => {
  try {
    const order = await prisma.storefrontOrder.findUnique({
      where: { id: req.params.id },
      include: {
        storefront: {
          include: {
            owner: { select: { id: true, name: true, email: true, phone: true, wallet: true } }
          }
        },
        bundle: true,
        order: true
      }
    });

    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    // Build financial breakdown
    const financial = {
      customerPaid: order.amount,
      agentCost: order.ownerCost,
      agentProfit: order.ownerProfit,
      supplierCost: order.supplierCost || order.bundle?.baseCost || 0,
      platformProfit: order.platformProfit || (order.ownerCost - (order.supplierCost || order.bundle?.baseCost || 0)),
      profitCredited: order.profitCredited,
      profitCreditedAt: order.profitCreditedAt
    };

    res.json({
      ...order,
      financial
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/admin/storefront-profits
 * Get profit summary and uncredited profits
 */
router.get('/storefront-profits', async (req, res, next) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const thisMonth = new Date();
    thisMonth.setDate(1);
    thisMonth.setHours(0, 0, 0, 0);

    // Get aggregated stats
    const [
      uncreditedOrders,
      todayStats,
      monthStats,
      totalStats,
      recentCredited
    ] = await Promise.all([
      // Uncredited profits (Paystack orders completed but profit not credited)
      // NOTE: Only PAYSTACK orders need profit crediting - MoMo orders use upfront wallet debit
      // Check BOTH StorefrontOrder.status and linked Order.status for completeness
      prisma.storefrontOrder.findMany({
        where: {
          profitCredited: false,
          paymentMethod: 'PAYSTACK',  // Only Paystack orders need crediting
          OR: [
            { status: 'COMPLETED' },  // StorefrontOrder is completed
            { order: { status: 'COMPLETED' } }  // Or linked Order is completed
          ]
        },
        include: {
          storefront: { select: { name: true, owner: { select: { name: true } } } },
          bundle: { select: { name: true } },
          order: { select: { status: true, updatedAt: true } }
        },
        orderBy: { createdAt: 'desc' }
      }),
      // Today's profits
      prisma.storefrontOrder.aggregate({
        where: {
          createdAt: { gte: today },
          profitCredited: true
        },
        _sum: { ownerProfit: true, platformProfit: true },
        _count: true
      }),
      // This month's profits
      prisma.storefrontOrder.aggregate({
        where: {
          createdAt: { gte: thisMonth },
          profitCredited: true
        },
        _sum: { ownerProfit: true, platformProfit: true },
        _count: true
      }),
      // All time
      prisma.storefrontOrder.aggregate({
        where: { profitCredited: true },
        _sum: { ownerProfit: true, platformProfit: true },
        _count: true
      }),
      // Recent credited
      prisma.storefrontOrder.findMany({
        where: { profitCredited: true },
        orderBy: { profitCreditedAt: 'desc' },
        take: 10,
        include: {
          storefront: { select: { name: true, owner: { select: { name: true } } } }
        }
      })
    ]);

    // Calculate uncredited totals
    const uncreditedTotal = uncreditedOrders.reduce((sum, o) => sum + (o.ownerProfit || 0), 0);
    const uncreditedPlatform = uncreditedOrders.reduce((sum, o) => sum + (o.platformProfit || 0), 0);

    res.json({
      summary: {
        today: {
          agentProfits: todayStats._sum.ownerProfit || 0,
          platformProfits: todayStats._sum.platformProfit || 0,
          count: todayStats._count
        },
        thisMonth: {
          agentProfits: monthStats._sum.ownerProfit || 0,
          platformProfits: monthStats._sum.platformProfit || 0,
          count: monthStats._count
        },
        allTime: {
          agentProfits: totalStats._sum.ownerProfit || 0,
          platformProfits: totalStats._sum.platformProfit || 0,
          count: totalStats._count
        }
      },
      uncredited: {
        count: uncreditedOrders.length,
        totalAgentProfit: uncreditedTotal,
        totalPlatformProfit: uncreditedPlatform,
        orders: uncreditedOrders.map(o => ({
          id: o.id,
          storefront: o.storefront?.name,
          agent: o.storefront?.owner?.name,
          bundle: o.bundle?.name,
          amount: o.amount,
          agentProfit: o.ownerProfit,
          platformProfit: o.platformProfit,
          completedAt: o.order?.updatedAt,
          createdAt: o.createdAt
        }))
      },
      recentCredited: recentCredited.map(o => ({
        id: o.id,
        storefront: o.storefront?.name,
        agent: o.storefront?.owner?.name,
        amount: o.ownerProfit,
        creditedAt: o.profitCreditedAt
      }))
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/admin/storefront-profits/retry
 * Retry crediting uncredited profits
 */
router.post('/storefront-profits/retry', async (req, res, next) => {
  try {
    const financialOrderService = require('../services/financial-order.service');
    const result = await financialOrderService.retryUncreditedProfits();

    await auditService.log({
      userId: req.user.id,
      action: 'ADMIN_OVERRIDE',
      entityType: 'StorefrontProfitRetry',
      metadata: { action: 'RETRY_UNCREDITED', result }
    });

    res.json(result);
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/admin/storefront-profits/credit/:orderId
 * Manually credit profit for a specific order
 * NOTE: Only works for PAYSTACK orders - MoMo orders use upfront wallet debit
 */
router.post('/storefront-profits/credit/:orderId', async (req, res, next) => {
  try {
    const financialOrderService = require('../services/financial-order.service');
    
    // Find the storefront order
    const storefrontOrder = await prisma.storefrontOrder.findFirst({
      where: { orderId: req.params.orderId }
    });

    if (!storefrontOrder) {
      return res.status(404).json({ error: 'Storefront order not found' });
    }

    if (storefrontOrder.profitCredited) {
      return res.status(400).json({ error: 'Profit already credited' });
    }

    // Validate this is a Paystack order
    if (storefrontOrder.paymentMethod !== 'PAYSTACK') {
      return res.status(400).json({ 
        error: 'Only Paystack orders can be credited. MoMo orders use upfront wallet debit.',
        paymentMethod: storefrontOrder.paymentMethod
      });
    }

    // ADMIN OVERRIDE: Ensure StorefrontOrder.status is COMPLETED before crediting
    // This handles cases where linked Order is complete but StorefrontOrder wasn't updated
    if (storefrontOrder.status !== 'COMPLETED') {
      await prisma.storefrontOrder.update({
        where: { id: storefrontOrder.id },
        data: { status: 'COMPLETED' }
      });
    }

    const result = await financialOrderService.processCompletedStorefrontOrder(req.params.orderId);

    // Handle crediting failures
    if (!result.credited && result.reason) {
      return res.status(400).json({ 
        error: result.reason,
        credited: false,
        amount: 0
      });
    }

    await auditService.log({
      userId: req.user.id,
      action: 'ADMIN_OVERRIDE',
      entityType: 'StorefrontProfitCredit',
      entityId: req.params.orderId,
      metadata: { action: 'MANUAL_CREDIT', result }
    });

    res.json(result);
  } catch (error) {
    next(error);
  }
});

/**
 * PATCH /api/admin/storefronts/:id/status
 * Update storefront status (suspend/activate)
 */
router.patch('/storefronts/:id/status', async (req, res, next) => {
  try {
    const { status, reason } = req.body;

    if (!['ACTIVE', 'SUSPENDED', 'INACTIVE'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    const updateData = { status };
    if (status === 'SUSPENDED') {
      updateData.suspendedAt = new Date();
      updateData.suspendedReason = reason || 'Suspended by admin';
      updateData.suspendedBy = req.user.id;
    } else if (status === 'ACTIVE') {
      updateData.suspendedAt = null;
      updateData.suspendedReason = null;
      updateData.suspendedBy = null;
    }

    const storefront = await prisma.storefront.update({
      where: { id: req.params.id },
      data: updateData
    });

    await auditService.log({
      userId: req.user.id,
      action: 'UPDATE',
      entityType: 'Storefront',
      entityId: storefront.id,
      newValues: { status, reason }
    });

    res.json({ success: true, storefront });
  } catch (error) {
    next(error);
  }
});

/**
 * ========== AUDIT & RECONCILIATION REPORT ==========
 */

/**
 * GET /api/admin/audit-report
 * Generate comprehensive audit and reconciliation report
 * Query params: startDate, endDate
 */
router.get('/audit-report', async (req, res, next) => {
  try {
    const { startDate, endDate } = req.query;
    
    // Parse dates
    const start = startDate ? new Date(startDate) : new Date(new Date().setHours(0, 0, 0, 0));
    const end = endDate ? new Date(endDate) : new Date(new Date().setHours(23, 59, 59, 999));
    end.setHours(23, 59, 59, 999); // Ensure end of day
    
    const dateFilter = {
      gte: start,
      lte: end
    };
    
    // 1. DEPOSITS SUMMARY
    // Get all completed deposits (DEPOSIT transactions with status COMPLETED)
    const deposits = await prisma.transaction.findMany({
      where: {
        type: 'DEPOSIT',
        status: 'COMPLETED',
        createdAt: dateFilter
      },
      include: {
        wallet: {
          include: {
            user: { select: { id: true, name: true } }
          }
        }
      }
    });
    
    // Separate Paystack agent deposits vs MoMo deposits
    // Identify Paystack by: paymentMethod='PAYSTACK' OR reference starts with 'PS_'
    let agentPaystackDeposits = { count: 0, amount: 0 };
    let momoDeposits = { count: 0, amount: 0 };
    
    deposits.forEach(d => {
      const method = (d.paymentMethod || '').toUpperCase();
      const ref = (d.reference || '').toUpperCase();
      const isPaystack = method.includes('PAYSTACK') || ref.startsWith('PS_');
      
      if (isPaystack) {
        agentPaystackDeposits.count++;
        agentPaystackDeposits.amount += d.amount;
      } else {
        momoDeposits.count++;
        momoDeposits.amount += d.amount;
      }
    });
    
    // Store Paystack payments (from StorefrontOrder with Paystack)
    const storePaystackOrders = await prisma.storefrontOrder.findMany({
      where: {
        paymentMethod: 'PAYSTACK',
        paymentStatus: 'PAID',
        createdAt: dateFilter
      }
    });
    let storePaystackPayments = { count: storePaystackOrders.length, amount: 0 };
    storePaystackOrders.forEach(o => {
      storePaystackPayments.amount += o.amount || 0;
    });
    
    const totalDeposits = {
      count: deposits.length + storePaystackPayments.count,
      amount: agentPaystackDeposits.amount + storePaystackPayments.amount + momoDeposits.amount
    };
    
    // 2. ORDERS SUMMARY
    // Get all completed orders
    const orderItems = await prisma.orderItem.findMany({
      where: {
        status: 'COMPLETED',
        createdAt: dateFilter
      },
      include: {
        bundle: true,
        orderGroup: {
          select: { id: true, idempotencyKey: true, user: { select: { id: true, name: true, role: true } } }
        }
      }
    });
    
    // 3. STOREFRONT ORDERS (for store profit tracking)
    const storefrontOrders = await prisma.storefrontOrder.findMany({
      where: {
        status: 'COMPLETED',
        createdAt: dateFilter
      },
      include: {
        storefront: {
          include: {
            owner: { select: { id: true, name: true } }
          }
        },
        bundle: true
      }
    });
    
    // Calculate system orders (non-storefront) and store orders
    let systemOrders = { count: 0, revenue: 0, cost: 0, profit: 0 };
    let storeOrdersSummary = { count: 0, revenue: 0, ownerCost: 0, ownerProfit: 0, platformProfit: 0 };
    
    // Network breakdown
    const networkStats = {};
    
    // Agent breakdown (for store orders)
    const agentStats = {};
    
    // Process order items - separate system (direct) vs storefront-originated
    orderItems.forEach(item => {
      const network = item.bundle?.network || 'Unknown';
      const revenue = item.totalPrice || 0;
      const cost = item.baseCost || 0;
      const profit = revenue - cost;
      
      // Check if this order came from a storefront (idempotencyKey starts with 'STORE-')
      const isStoreOrder = item.orderGroup?.idempotencyKey?.startsWith('STORE-');
      
      // Only count non-store orders as system (direct) orders
      if (!isStoreOrder) {
        systemOrders.count++;
        systemOrders.revenue += revenue;
        systemOrders.cost += cost;
        systemOrders.profit += profit;
      }
      
      // Network breakdown (all orders)
      if (!networkStats[network]) {
        networkStats[network] = { orders: 0, revenue: 0, cost: 0, profit: 0 };
      }
      networkStats[network].orders++;
      networkStats[network].revenue += revenue;
      networkStats[network].cost += cost;
      networkStats[network].profit += profit;
    });
    
    // Process storefront orders for agent profits
    storefrontOrders.forEach(order => {
      const agentId = order.storefront?.owner?.id;
      const agentName = order.storefront?.owner?.name || 'Unknown';
      
      const storeRevenue = order.amount || 0;        // What customer paid (e.g., 5.0)
      const ownerCost = order.ownerCost || 0;         // What agent pays (e.g., 4.5)
      const ownerProfit = order.ownerProfit || 0;     // Agent's cut (e.g., 0.5)
      const supplierCost = order.supplierCost || 0;   // Platform's cost (e.g., 4.2)
      const platformProfit = order.platformProfit || (ownerCost - supplierCost); // Platform cut (e.g., 0.3)
      
      storeOrdersSummary.count++;
      storeOrdersSummary.revenue += storeRevenue;
      storeOrdersSummary.ownerCost += ownerCost;
      storeOrdersSummary.ownerProfit += ownerProfit;
      storeOrdersSummary.platformProfit += Math.max(0, platformProfit);
      
      // Agent breakdown
      if (agentId) {
        if (!agentStats[agentId]) {
          agentStats[agentId] = { 
            name: agentName, 
            orders: 0, 
            storeRevenue: 0, 
            agentProfit: 0, 
            platformProfit: 0 
          };
        }
        agentStats[agentId].orders++;
        agentStats[agentId].storeRevenue += storeRevenue;
        agentStats[agentId].agentProfit += ownerProfit;
        agentStats[agentId].platformProfit += Math.max(0, platformProfit);
      }
    });
    
    // 4. REFUNDS
    const refunds = await prisma.walletLedger.findMany({
      where: {
        entryType: 'REFUND',
        createdAt: dateFilter
      }
    });
    const totalRefunds = {
      count: refunds.length,
      amount: refunds.reduce((sum, r) => sum + Math.abs(r.amount), 0)
    };
    
    // 5. FAILED & CANCELLED ORDERS
    const failedOrders = await prisma.orderItem.count({
      where: {
        status: { in: ['FAILED', 'CANCELLED'] },
        createdAt: dateFilter
      }
    });
    
    // 6. CURRENT WALLET BALANCES
    const walletBalances = await prisma.wallet.aggregate({
      _sum: { balance: true },
      _count: true
    });
    
    // 7. FINAL PROFIT SUMMARY
    // System gross profit = revenue - cost from direct orders
    const systemGrossProfit = systemOrders.profit;
    // System net profit = gross profit (no fee deduction)
    const systemNetProfit = systemGrossProfit;
    
    // Store profit breakdown
    const storeGrossProfit = storeOrdersSummary.ownerProfit + storeOrdersSummary.platformProfit;
    const agentEarnings = storeOrdersSummary.ownerProfit;
    const platformCutFromStore = storeOrdersSummary.platformProfit;
    
    // Total platform profit
    const totalPlatformProfit = systemNetProfit + platformCutFromStore;
    
    // Total Paystack = agent deposits + store payments
    const totalPaystack = agentPaystackDeposits.amount + storePaystackPayments.amount;
    
    // Format agent stats as array
    const agentBreakdown = Object.entries(agentStats).map(([id, stats]) => ({
      id,
      ...stats
    })).sort((a, b) => b.orders - a.orders);
    
    // Format network stats as array
    const networkBreakdown = Object.entries(networkStats).map(([network, stats]) => ({
      network,
      ...stats
    })).sort((a, b) => b.orders - a.orders);
    
    res.json({
      period: {
        start: start.toISOString(),
        end: end.toISOString()
      },
      deposits: {
        agentPaystack: {
          count: agentPaystackDeposits.count,
          amount: agentPaystackDeposits.amount
        },
        storePaystack: {
          count: storePaystackPayments.count,
          amount: storePaystackPayments.amount
        },
        momo: {
          count: momoDeposits.count,
          amount: momoDeposits.amount
        },
        total: totalDeposits
      },
      orders: {
        system: {
          count: systemOrders.count,
          revenue: systemOrders.revenue,
          cost: systemOrders.cost,
          grossProfit: systemOrders.profit
        },
        store: {
          count: storeOrdersSummary.count,
          revenue: storeOrdersSummary.revenue,
          ownerCost: storeOrdersSummary.ownerCost,
          agentProfit: storeOrdersSummary.ownerProfit,
          platformProfit: storeOrdersSummary.platformProfit
        }
      },
      byNetwork: networkBreakdown,
      byAgent: agentBreakdown,
      refunds: totalRefunds,
      failedOrders: failedOrders,
      walletBalances: {
        total: walletBalances._sum.balance || 0,
        count: walletBalances._count || 0
      },
      summary: {
        totalDeposits: totalPaystack,
        totalOrderRevenue: systemOrders.revenue + storeOrdersSummary.revenue,
        systemGrossProfit: systemGrossProfit,
        systemNetProfit: systemNetProfit,
        storeGrossProfit: storeGrossProfit,
        agentEarnings: agentEarnings,
        platformCutFromStore: platformCutFromStore,
        totalPlatformProfit: totalPlatformProfit
      }
    });
  } catch (error) {
    console.error('Audit report error:', error);
    next(error);
  }
});

/**
 * ========== ADMIN ALERTS ==========
 */

/**
 * GET /api/admin/alerts
 * Get all alerts with filters
 */
router.get('/alerts', async (req, res, next) => {
  try {
    const { type, severity, isRead, page = 1, limit = 20 } = req.query;
    const result = await alertService.getAll({
      type,
      severity,
      isRead: isRead === 'true' ? true : isRead === 'false' ? false : undefined,
      page: parseInt(page),
      limit: parseInt(limit)
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/admin/alerts/unread
 * Get unread alerts (for notification badge)
 */
router.get('/alerts/unread', async (req, res, next) => {
  try {
    const alerts = await alertService.getUnread({ limit: 10 });
    const counts = await alertService.getCounts();
    res.json({ alerts, counts });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/admin/alerts/counts
 * Get alert counts by type and severity
 */
router.get('/alerts/counts', async (req, res, next) => {
  try {
    const counts = await alertService.getCounts();
    res.json(counts);
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/admin/alerts/:id/read
 * Mark alert as read
 */
router.post('/alerts/:id/read', async (req, res, next) => {
  try {
    const alert = await alertService.markRead(req.params.id, req.user.id);
    res.json({ success: true, alert });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/admin/alerts/mark-many-read
 * Mark multiple alerts as read
 */
router.post('/alerts/mark-many-read', async (req, res, next) => {
  try {
    const { alertIds } = req.body;
    if (!alertIds || !Array.isArray(alertIds)) {
      return res.status(400).json({ error: 'alertIds array required' });
    }
    await alertService.markManyRead(alertIds, req.user.id);
    res.json({ success: true, marked: alertIds.length });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/admin/alerts/:id/dismiss
 * Dismiss an alert
 */
router.post('/alerts/:id/dismiss', async (req, res, next) => {
  try {
    const alert = await alertService.dismiss(req.params.id, req.user.id);
    res.json({ success: true, alert });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/admin/alerts/check-stuck-payouts
 * Manually trigger check for stuck payouts
 */
router.post('/alerts/check-stuck-payouts', async (req, res, next) => {
  try {
    const stuckCount = await alertService.checkStuckPayouts(6); // 6 hours threshold
    res.json({ success: true, stuckPayouts: stuckCount });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/admin/payout-audit/:payoutId
 * Get full audit trail for a specific payout
 */
router.get('/payout-audit/:payoutId', async (req, res, next) => {
  try {
    const trail = await auditService.getPayoutAuditTrail(req.params.payoutId);
    res.json({ trail });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/admin/payout-audit-summary
 * Get payout audit summary for a period
 */
router.get('/payout-audit-summary', async (req, res, next) => {
  try {
    const { startDate, endDate } = req.query;
    
    const start = startDate ? new Date(startDate) : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const end = endDate ? new Date(endDate) : new Date();
    
    const summary = await auditService.getPayoutAuditSummary(start, end);
    res.json(summary);
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/admin/payouts/:payoutId/manual-complete
 * Manually complete a payout (admin pays externally via cash/bank/MoMo)
 * Used when Paystack is unavailable
 */
router.post('/payouts/:payoutId/manual-complete', async (req, res, next) => {
  try {
    const { payoutId } = req.params;
    const { paymentMethod, externalReference, note } = req.body;
    
    // Validate payment method
    const validMethods = ['cash', 'bank_transfer', 'manual_momo', 'other'];
    if (!paymentMethod || !validMethods.includes(paymentMethod)) {
      return res.status(400).json({ 
        error: `Invalid payment method. Must be one of: ${validMethods.join(', ')}` 
      });
    }
    
    const result = await profitPayoutService.manualComplete({
      payoutId,
      paymentMethod,
      externalReference: externalReference || null,
      note: note || null,
      adminId: req.user.id
    });
    
    res.json(result);
  } catch (error) {
    console.error('[Admin] Manual payout completion error:', error.message);
    next(error);
  }
});

/**
 * ========== JOB QUEUE (BATCH PAYOUTS) ==========
 */

/**
 * GET /api/admin/job-queue/status
 * Get current job queue status
 */
router.get('/job-queue/status', async (req, res, next) => {
  try {
    const status = jobQueueService.getStatus();
    res.json(status);
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/admin/job-queue/history
 * Get recent job history
 */
router.get('/job-queue/history', async (req, res, next) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const history = jobQueueService.getHistory(limit);
    res.json({ history });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/admin/job-queue/job/:jobId
 * Get specific job details
 */
router.get('/job-queue/job/:jobId', async (req, res, next) => {
  try {
    const job = jobQueueService.getJob(req.params.jobId);
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }
    res.json({ job });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/admin/job-queue/batch/:batchId
 * Get batch status
 */
router.get('/job-queue/batch/:batchId', async (req, res, next) => {
  try {
    const status = jobQueueService.getBatchStatus(req.params.batchId);
    if (!status) {
      return res.status(404).json({ error: 'Batch not found' });
    }
    res.json(status);
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/admin/job-queue/add
 * Add a single payout job to the queue
 */
router.post('/job-queue/add', async (req, res, next) => {
  try {
    const { payoutId, otp, priority } = req.body;
    
    if (!payoutId) {
      return res.status(400).json({ error: 'payoutId is required' });
    }
    
    // Verify payout exists and is pending
    const payout = await prisma.payoutRequest.findUnique({
      where: { id: payoutId }
    });
    
    if (!payout) {
      return res.status(404).json({ error: 'Payout not found' });
    }
    
    if (payout.status !== 'PENDING') {
      return res.status(400).json({ error: `Payout is ${payout.status}, not PENDING` });
    }
    
    const job = jobQueueService.addJob(payoutId, req.user.id, { otp, priority });
    
    // Log audit
    await auditService.log({
      action: 'PAYOUT_PROCESS',
      userId: req.user.id,
      targetId: payoutId,
      targetType: 'PayoutRequest',
      details: { source: 'job_queue_manual', jobId: job.id }
    });
    
    res.json({ 
      success: true, 
      message: 'Job added to queue',
      job: { id: job.id, status: job.status }
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/admin/job-queue/batch
 * Add multiple pending payouts to the queue
 */
router.post('/job-queue/batch', async (req, res, next) => {
  try {
    const { payoutIds, otp, priority } = req.body;
    
    if (!payoutIds || !Array.isArray(payoutIds) || payoutIds.length === 0) {
      return res.status(400).json({ error: 'payoutIds array is required' });
    }
    
    // Verify all payouts exist and are pending
    const payouts = await prisma.payoutRequest.findMany({
      where: { 
        id: { in: payoutIds },
        status: 'PENDING'
      }
    });
    
    if (payouts.length === 0) {
      return res.status(400).json({ error: 'No valid pending payouts found' });
    }
    
    const validIds = payouts.map(p => p.id);
    const batch = jobQueueService.addBatch(validIds, req.user.id, { otp, priority });
    
    // Log audit
    await auditService.log({
      action: 'PAYOUT_PROCESS',
      userId: req.user.id,
      targetType: 'PayoutRequest',
      details: { 
        source: 'job_queue_batch', 
        batchId: batch.batchId,
        jobCount: batch.jobCount
      }
    });
    
    res.json({ 
      success: true, 
      message: `Added ${batch.jobCount} jobs to queue`,
      batchId: batch.batchId,
      jobCount: batch.jobCount,
      skipped: payoutIds.length - batch.jobCount
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/admin/job-queue/cancel/:jobId
 * Cancel a pending job
 */
router.post('/job-queue/cancel/:jobId', async (req, res, next) => {
  try {
    const result = jobQueueService.cancelJob(req.params.jobId);
    
    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }
    
    res.json({ success: true, message: 'Job cancelled' });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/admin/job-queue/cleanup
 * Clean up old completed/failed jobs
 */
router.post('/job-queue/cleanup', async (req, res, next) => {
  try {
    const result = jobQueueService.cleanup();
    res.json({ success: true, cleaned: result.cleaned });
  } catch (error) {
    next(error);
  }
});

/**
 * ========== SMS (mNotify) ==========
 */

/**
 * GET /api/admin/sms/status
 * Get SMS service status and balance
 */
router.get('/sms/status', async (req, res, next) => {
  try {
    const isEnabled = smsService.isEnabled();
    const balance = await smsService.getBalance();
    
    res.json({
      enabled: isEnabled,
      configured: !!process.env.MNOTIFY_API_KEY,
      senderId: process.env.MNOTIFY_SENDER_ID || 'KemPlusData',
      balance: balance.success ? {
        sms: balance.balance,
        bonus: balance.bonus
      } : null,
      error: balance.error
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/admin/sms/test
 * Send a test SMS
 */
router.post('/sms/test', async (req, res, next) => {
  try {
    const { phone, message } = req.body;
    
    if (!phone) {
      return res.status(400).json({ error: 'Phone number is required' });
    }
    
    const testMessage = message || `Test SMS from KemDataplus Admin Dashboard. Time: ${new Date().toLocaleString('en-GH')}`;
    
    const result = await smsService.sendSMS(phone, testMessage);
    
    if (result.success) {
      res.json({ 
        success: true, 
        message: 'Test SMS sent successfully',
        messageId: result.messageId,
        balance: result.balance
      });
    } else {
      res.status(400).json({ 
        success: false, 
        error: result.error || result.reason 
      });
    }
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/admin/sms/send-payout-notification
 * Manually send payout notification SMS
 */
router.post('/sms/send-payout-notification', async (req, res, next) => {
  try {
    const { payoutId } = req.body;
    
    if (!payoutId) {
      return res.status(400).json({ error: 'payoutId is required' });
    }
    
    // Get payout with user details
    const payout = await prisma.agentPayout.findUnique({
      where: { id: payoutId },
      include: { user: { select: { name: true, phone: true, momoNumber: true } } }
    });
    
    if (!payout) {
      return res.status(404).json({ error: 'Payout not found' });
    }
    
    const phone = payout.user?.momoNumber || payout.user?.phone;
    if (!phone) {
      return res.status(400).json({ error: 'No phone number found for agent' });
    }
    
    let result;
    if (payout.status === 'COMPLETED') {
      result = await smsService.sendPayoutCompletedSMS(
        phone,
        payout.user?.name,
        payout.netAmount,
        payout.reference
      );
    } else if (payout.status === 'FAILED') {
      result = await smsService.sendPayoutFailedSMS(
        phone,
        payout.user?.name,
        payout.amount,
        payout.failureReason || 'Payout failed'
      );
    } else {
      return res.status(400).json({ error: `Cannot send notification for ${payout.status} payout` });
    }
    
    if (result.success) {
      res.json({ success: true, message: 'SMS notification sent' });
    } else {
      res.status(400).json({ success: false, error: result.error || result.reason });
    }
  } catch (error) {
    next(error);
  }
});

module.exports = router;
