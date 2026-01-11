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
const walletService = require('../services/wallet.service');
const auditService = require('../services/audit.service');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

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
        status: o.order?.status || o.status,
        paymentStatus: o.paymentStatus,
        paymentMethod: o.paymentMethod || 'MOMO',
        profitCredited: o.profitCredited,
        profitCreditedAt: o.profitCreditedAt,
        paystackReference: o.paystackReference,
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
        order: true,
        storefrontProduct: true
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
      // Uncredited profits (orders completed but profit not credited)
      prisma.storefrontOrder.findMany({
        where: {
          profitCredited: false,
          order: { status: 'COMPLETED' }
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

    const result = await financialOrderService.processCompletedStorefrontOrder(req.params.orderId);

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

module.exports = router;
