/**
 * TENANT ROUTES
 * ==============
 * API endpoints for tenant management.
 */

const express = require('express');
const router = express.Router();
const { authenticate, authorize } = require('../middleware/auth');
const tenantService = require('../services/tenant.service');
const pricingEngine = require('../services/pricing.service');
const { v4: uuidv4 } = require('uuid');

/**
 * GET /api/tenants/current
 * Get current tenant info (based on resolution)
 */
router.get('/current', async (req, res, next) => {
  try {
    const tenant = req.tenant;
    if (!tenant) {
      return res.status(404).json({ error: 'Tenant not found' });
    }

    res.json({
      id: tenant.id,
      name: tenant.name,
      brandName: tenant.brandName,
      slug: tenant.slug,
      primaryColor: tenant.primaryColor,
      secondaryColor: tenant.secondaryColor,
      logoUrl: tenant.logoUrl,
      isRoot: tenant.isRoot
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/tenants/:id
 * Get tenant by ID (admin only)
 */
router.get('/:id', authenticate, authorize('ADMIN', 'PARTNER'), async (req, res, next) => {
  try {
    const tenant = await tenantService.getTenantById(req.params.id);
    if (!tenant) {
      return res.status(404).json({ error: 'Tenant not found' });
    }

    // Check access
    if (req.user.role !== 'ADMIN') {
      const hasAccess = await tenantService.isAncestorOf(req.user.tenantId, tenant.id) ||
                       req.user.tenantId === tenant.id;
      if (!hasAccess) {
        return res.status(403).json({ error: 'Access denied' });
      }
    }

    const stats = await tenantService.getTenantStats(tenant.id);

    res.json({ ...tenant, stats });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/tenants
 * Create sub-tenant (requires permission)
 */
router.post('/', authenticate, authorize('ADMIN', 'PARTNER', 'SUPER_DEALER'), async (req, res, next) => {
  try {
    const { name, slug, domain, brandName, canCreateSubTenant, maxSubTenants, maxUsers } = req.body;

    if (!name || !slug) {
      return res.status(400).json({ error: 'Name and slug are required' });
    }

    // Validate slug format
    if (!/^[a-z0-9-]+$/.test(slug)) {
      return res.status(400).json({ error: 'Slug must be lowercase alphanumeric with hyphens only' });
    }

    // Determine parent tenant
    let parentId;
    if (req.user.role === 'ADMIN' && req.body.parentId) {
      parentId = req.body.parentId;
    } else {
      parentId = req.user.tenantId || (await tenantService.getRootTenant()).id;
    }

    // Validate parent can create sub-tenant
    const validation = await tenantService.validateTenantAction(parentId, 'CREATE_SUBTENANT', req.user.id);
    if (!validation.valid) {
      return res.status(403).json({ error: validation.error });
    }

    const tenant = await tenantService.createSubTenant(
      {
        name,
        slug,
        domain,
        brandName,
        canCreateSubTenant: canCreateSubTenant || false,
        maxSubTenants: maxSubTenants || 0,
        maxUsers: maxUsers || 50
      },
      parentId,
      req.user.id
    );

    res.status(201).json(tenant);
  } catch (error) {
    next(error);
  }
});

/**
 * PUT /api/tenants/:id
 * Update tenant (admin or tenant owner)
 */
router.put('/:id', authenticate, authorize('ADMIN', 'PARTNER'), async (req, res, next) => {
  try {
    const tenant = await tenantService.getTenantById(req.params.id);
    if (!tenant) {
      return res.status(404).json({ error: 'Tenant not found' });
    }

    // Check permission
    if (req.user.role !== 'ADMIN' && req.user.tenantId !== tenant.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const { PrismaClient } = require('@prisma/client');
    const prisma = new PrismaClient();

    const allowedUpdates = ['name', 'brandName', 'logoUrl', 'primaryColor', 'secondaryColor'];
    const adminOnlyUpdates = ['canCreateSubTenant', 'maxSubTenants', 'maxUsers', 'dailyTransactionCap', 'status'];

    const updateData = {};
    for (const field of allowedUpdates) {
      if (req.body[field] !== undefined) {
        updateData[field] = req.body[field];
      }
    }

    if (req.user.role === 'ADMIN') {
      for (const field of adminOnlyUpdates) {
        if (req.body[field] !== undefined) {
          updateData[field] = req.body[field];
        }
      }
    }

    const updated = await prisma.tenant.update({
      where: { id: req.params.id },
      data: updateData
    });

    // Log audit
    await tenantService.logAudit({
      userId: req.user.id,
      tenantId: tenant.id,
      action: 'UPDATE',
      entityType: 'Tenant',
      entityId: tenant.id,
      oldValues: tenant,
      newValues: updated
    });

    res.json(updated);
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/tenants/:id/suspend
 * Suspend tenant (admin only)
 */
router.post('/:id/suspend', authenticate, authorize('ADMIN'), async (req, res, next) => {
  try {
    const { reason } = req.body;
    if (!reason) {
      return res.status(400).json({ error: 'Suspension reason is required' });
    }

    const result = await tenantService.suspendTenant(req.params.id, reason, req.user.id);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/tenants/:id/activate
 * Activate suspended tenant (admin only)
 */
router.post('/:id/activate', authenticate, authorize('ADMIN'), async (req, res, next) => {
  try {
    const { PrismaClient } = require('@prisma/client');
    const prisma = new PrismaClient();

    const tenant = await prisma.tenant.update({
      where: { id: req.params.id },
      data: { status: 'ACTIVE' }
    });

    await tenantService.logAudit({
      userId: req.user.id,
      tenantId: tenant.id,
      action: 'UPDATE',
      entityType: 'Tenant',
      entityId: tenant.id,
      metadata: { action: 'ACTIVATE' }
    });

    res.json(tenant);
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/tenants/:id/hierarchy
 * Get tenant hierarchy (ancestors and descendants)
 */
router.get('/:id/hierarchy', authenticate, async (req, res, next) => {
  try {
    const [ancestors, descendants] = await Promise.all([
      tenantService.getTenantAncestors(req.params.id),
      tenantService.getTenantDescendants(req.params.id)
    ]);

    res.json({ ancestors, descendants });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/tenants/:id/prices
 * Get tenant's price ladder for all bundles
 */
router.get('/:id/prices', authenticate, async (req, res, next) => {
  try {
    const { PrismaClient } = require('@prisma/client');
    const prisma = new PrismaClient();

    const bundles = await prisma.bundle.findMany({
      where: { isActive: true },
      include: {
        tenantPrices: {
          where: { tenantId: req.params.id }
        }
      }
    });

    const priceLadders = await Promise.all(
      bundles.map(b => pricingEngine.getPriceLadder(b.id, req.params.id))
    );

    res.json(priceLadders);
  } catch (error) {
    next(error);
  }
});

/**
 * PUT /api/tenants/:id/prices
 * Set tenant prices (with validation)
 */
router.put('/:id/prices', authenticate, authorize('ADMIN', 'PARTNER', 'SUPER_DEALER'), async (req, res, next) => {
  try {
    const { bundleId, role, price } = req.body;

    if (!bundleId || !role || price === undefined) {
      return res.status(400).json({ error: 'bundleId, role, and price are required' });
    }

    // Check permission
    if (req.user.role !== 'ADMIN') {
      const tenant = await tenantService.getTenantById(req.params.id);
      if (!tenant || tenant.id !== req.user.tenantId) {
        return res.status(403).json({ error: 'Can only set prices for your own tenant' });
      }
    }

    const result = await pricingEngine.setTenantPrice(
      req.params.id,
      bundleId,
      role,
      parseFloat(price),
      req.user.id
    );

    res.json(result);
  } catch (error) {
    if (error.message.includes('cannot be below')) {
      return res.status(400).json({ error: error.message });
    }
    next(error);
  }
});

/**
 * GET /api/tenants/:id/stats
 * Get tenant statistics
 */
router.get('/:id/stats', authenticate, async (req, res, next) => {
  try {
    const stats = await tenantService.getTenantStats(req.params.id);
    res.json(stats);
  } catch (error) {
    next(error);
  }
});

module.exports = router;
