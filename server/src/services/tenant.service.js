/**
 * TENANT SERVICE
 * ===============
 * Handles tenant creation, hierarchy management, and tenant resolution.
 * 
 * NON-NEGOTIABLE RULES:
 * 1. Tenants form a strict tree - no circular relationships
 * 2. Child tenants cannot affect parent data
 * 3. Tenant resolution is server-side only
 * 4. All tenant operations are audited
 */

const { PrismaClient } = require('@prisma/client');
const { v4: uuidv4 } = require('uuid');

const prisma = new PrismaClient();

const tenantService = {
  /**
   * Create root tenant (for initial setup)
   */
  async createRootTenant(data) {
    const existing = await prisma.tenant.findFirst({ where: { isRoot: true } });
    if (existing) {
      throw new Error('Root tenant already exists');
    }

    const tenant = await prisma.tenant.create({
      data: {
        id: uuidv4(),
        name: data.name || 'KemDataplus',
        slug: data.slug || 'root',
        isRoot: true,
        hierarchyLevel: 0,
        hierarchyPath: '/',
        canCreateSubTenant: true,
        maxSubTenants: 999,
        maxUsers: 99999,
        status: 'ACTIVE',
      }
    });

    return tenant;
  },

  /**
   * Get or create root tenant
   */
  async getRootTenant() {
    let root = await prisma.tenant.findFirst({ where: { isRoot: true } });
    if (!root) {
      root = await this.createRootTenant({ name: 'KemDataplus', slug: 'root' });
    }
    return root;
  },

  /**
   * Create sub-tenant under a parent
   * @param {Object} data - Tenant data
   * @param {string} parentId - Parent tenant ID
   * @param {string} createdById - User creating the tenant
   */
  async createSubTenant(data, parentId, createdById) {
    // Validate parent exists and can create sub-tenants
    const parent = await prisma.tenant.findUnique({
      where: { id: parentId },
      include: { children: true }
    });

    if (!parent) {
      throw new Error('Parent tenant not found');
    }

    if (!parent.canCreateSubTenant) {
      throw new Error('Parent tenant cannot create sub-tenants');
    }

    if (parent.children.length >= parent.maxSubTenants) {
      throw new Error('Parent tenant has reached maximum sub-tenants limit');
    }

    if (parent.status !== 'ACTIVE') {
      throw new Error('Parent tenant is not active');
    }

    // Validate slug uniqueness
    const existingSlug = await prisma.tenant.findUnique({
      where: { slug: data.slug }
    });
    if (existingSlug) {
      throw new Error('Tenant slug already exists');
    }

    // Validate domain uniqueness if provided
    if (data.domain) {
      const existingDomain = await prisma.tenant.findUnique({
        where: { domain: data.domain }
      });
      if (existingDomain) {
        throw new Error('Domain already mapped to another tenant');
      }
    }

    // Calculate hierarchy path
    const hierarchyPath = parent.hierarchyPath === '/' 
      ? `/${parent.id}/` 
      : `${parent.hierarchyPath}${parent.id}/`;

    // Create tenant
    const tenant = await prisma.tenant.create({
      data: {
        id: uuidv4(),
        name: data.name,
        slug: data.slug,
        domain: data.domain || null,
        parentId: parentId,
        hierarchyLevel: parent.hierarchyLevel + 1,
        hierarchyPath: hierarchyPath,
        brandName: data.brandName || data.name,
        logoUrl: data.logoUrl || null,
        primaryColor: data.primaryColor || parent.primaryColor,
        secondaryColor: data.secondaryColor || parent.secondaryColor,
        canCreateSubTenant: data.canCreateSubTenant || false,
        maxSubTenants: data.maxSubTenants || 0,
        maxUsers: data.maxUsers || 50,
        dailyTransactionCap: data.dailyTransactionCap || parent.dailyTransactionCap,
        monthlyTransactionCap: data.monthlyTransactionCap || parent.monthlyTransactionCap,
        minProfitMargin: data.minProfitMargin || 0,
        status: 'ACTIVE',
        isRoot: false,
        createdById: createdById,
      }
    });

    // Log audit
    await this.logAudit({
      userId: createdById,
      tenantId: tenant.id,
      action: 'TENANT_CREATE',
      entityType: 'Tenant',
      entityId: tenant.id,
      newValues: tenant,
    });

    return tenant;
  },

  /**
   * Resolve tenant from request (subdomain, domain, or identifier)
   * @param {Object} req - Express request object
   */
  async resolveTenant(req) {
    let tenant = null;

    // 1. Check for custom domain
    const host = req.hostname || req.headers.host?.split(':')[0];
    if (host && !host.includes('localhost') && !host.includes('127.0.0.1')) {
      tenant = await prisma.tenant.findUnique({
        where: { domain: host }
      });
      if (tenant) return tenant;
    }

    // 2. Check for subdomain
    if (host) {
      const parts = host.split('.');
      if (parts.length >= 2) {
        const subdomain = parts[0];
        if (subdomain !== 'www' && subdomain !== 'api') {
          tenant = await prisma.tenant.findUnique({
            where: { slug: subdomain }
          });
          if (tenant) return tenant;
        }
      }
    }

    // 3. Check for tenant identifier in header
    const tenantId = req.headers['x-tenant-id'];
    if (tenantId) {
      tenant = await prisma.tenant.findUnique({
        where: { id: tenantId }
      });
      if (tenant) return tenant;
    }

    // 4. Check for tenant slug in query/body
    const slug = req.query?.tenant || req.body?.tenant;
    if (slug) {
      tenant = await prisma.tenant.findUnique({
        where: { slug: slug }
      });
      if (tenant) return tenant;
    }

    // 5. Return root tenant as default
    return await this.getRootTenant();
  },

  /**
   * Get tenant by ID with validation
   */
  async getTenantById(tenantId) {
    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
      include: {
        parent: true,
        children: {
          where: { status: 'ACTIVE' }
        }
      }
    });
    return tenant;
  },

  /**
   * Get full tenant hierarchy (ancestors)
   */
  async getTenantAncestors(tenantId) {
    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId }
    });

    if (!tenant || tenant.isRoot) {
      return [];
    }

    // Parse hierarchy path to get ancestor IDs
    const ancestorIds = tenant.hierarchyPath
      .split('/')
      .filter(id => id && id !== tenant.id);

    const ancestors = await prisma.tenant.findMany({
      where: { id: { in: ancestorIds } },
      orderBy: { hierarchyLevel: 'asc' }
    });

    return ancestors;
  },

  /**
   * Get all descendants of a tenant
   */
  async getTenantDescendants(tenantId) {
    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId }
    });

    if (!tenant) return [];

    // Find all tenants whose path contains this tenant's ID
    const pathPattern = tenant.hierarchyPath === '/'
      ? `/${tenantId}/`
      : `${tenant.hierarchyPath}${tenantId}/`;

    const descendants = await prisma.tenant.findMany({
      where: {
        hierarchyPath: { startsWith: pathPattern }
      },
      orderBy: { hierarchyLevel: 'asc' }
    });

    return descendants;
  },

  /**
   * Check if tenant A is ancestor of tenant B
   */
  async isAncestorOf(ancestorId, descendantId) {
    const descendant = await prisma.tenant.findUnique({
      where: { id: descendantId }
    });

    if (!descendant) return false;
    return descendant.hierarchyPath.includes(`/${ancestorId}/`);
  },

  /**
   * Suspend tenant and all descendants
   */
  async suspendTenant(tenantId, reason, suspendedById) {
    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId }
    });

    if (!tenant) throw new Error('Tenant not found');
    if (tenant.isRoot) throw new Error('Cannot suspend root tenant');

    // Get all descendants
    const descendants = await this.getTenantDescendants(tenantId);
    const allIds = [tenantId, ...descendants.map(d => d.id)];

    // Suspend all
    await prisma.tenant.updateMany({
      where: { id: { in: allIds } },
      data: { status: 'SUSPENDED' }
    });

    // Log audit
    await this.logAudit({
      userId: suspendedById,
      tenantId: tenantId,
      action: 'TENANT_SUSPEND',
      entityType: 'Tenant',
      entityId: tenantId,
      metadata: { reason, affectedTenants: allIds.length },
    });

    return { suspended: allIds.length };
  },

  /**
   * Validate tenant can perform action
   */
  async validateTenantAction(tenantId, action, userId = null) {
    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId }
    });

    if (!tenant) {
      return { valid: false, error: 'Tenant not found' };
    }

    if (tenant.status !== 'ACTIVE') {
      return { valid: false, error: `Tenant is ${tenant.status.toLowerCase()}` };
    }

    // Check user count for user creation
    if (action === 'CREATE_USER') {
      const userCount = await prisma.user.count({
        where: { tenantId: tenantId }
      });
      if (userCount >= tenant.maxUsers) {
        return { valid: false, error: 'Tenant has reached maximum users limit' };
      }
    }

    // Check sub-tenant creation
    if (action === 'CREATE_SUBTENANT') {
      if (!tenant.canCreateSubTenant) {
        return { valid: false, error: 'Tenant cannot create sub-tenants' };
      }
      const subCount = await prisma.tenant.count({
        where: { parentId: tenantId }
      });
      if (subCount >= tenant.maxSubTenants) {
        return { valid: false, error: 'Tenant has reached maximum sub-tenants limit' };
      }
    }

    return { valid: true };
  },

  /**
   * Log audit entry
   */
  async logAudit(data) {
    try {
      await prisma.auditLog.create({
        data: {
          id: uuidv4(),
          userId: data.userId,
          tenantId: data.tenantId,
          ipAddress: data.ipAddress,
          userAgent: data.userAgent,
          action: data.action,
          entityType: data.entityType,
          entityId: data.entityId,
          oldValues: data.oldValues,
          newValues: data.newValues,
          metadata: data.metadata,
        }
      });
    } catch (error) {
      console.error('Failed to log audit:', error);
    }
  },

  /**
   * Get tenant statistics
   */
  async getTenantStats(tenantId) {
    const [userCount, orderCount, descendantCount, totalRevenue] = await Promise.all([
      prisma.user.count({ where: { tenantId } }),
      prisma.order.count({ where: { tenantId } }),
      prisma.tenant.count({ 
        where: { 
          hierarchyPath: { contains: `/${tenantId}/` }
        }
      }),
      prisma.order.aggregate({
        where: { tenantId, status: 'COMPLETED' },
        _sum: { totalPrice: true }
      })
    ]);

    return {
      users: userCount,
      orders: orderCount,
      subTenants: descendantCount,
      revenue: totalRevenue._sum.totalPrice || 0
    };
  }
};

module.exports = tenantService;
