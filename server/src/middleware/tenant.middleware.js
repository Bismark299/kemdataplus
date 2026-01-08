/**
 * TENANT RESOLUTION MIDDLEWARE
 * =============================
 * Resolves tenant context for every request.
 * Enforces tenant data isolation.
 * 
 * SECURITY RULES:
 * 1. Tenant is resolved server-side only
 * 2. User can only access their own tenant's data
 * 3. Parent tenants can view (not modify) child data
 * 4. Suspended tenants are blocked
 */

const tenantService = require('../services/tenant.service');
const auditService = require('../services/audit.service');

/**
 * Resolve tenant from request and attach to req object
 */
const resolveTenant = async (req, res, next) => {
  try {
    const tenant = await tenantService.resolveTenant(req);
    
    if (!tenant) {
      // Create root tenant if none exists (first-time setup)
      req.tenant = await tenantService.getRootTenant();
    } else {
      req.tenant = tenant;
    }

    // Check tenant status
    if (req.tenant.status === 'SUSPENDED') {
      return res.status(403).json({
        error: 'Tenant suspended',
        message: 'This reseller portal has been suspended. Please contact support.'
      });
    }

    if (req.tenant.status === 'DISABLED') {
      return res.status(403).json({
        error: 'Tenant disabled',
        message: 'This reseller portal has been disabled.'
      });
    }

    next();
  } catch (error) {
    console.error('Tenant resolution error:', error);
    next(error);
  }
};

/**
 * Validate user belongs to resolved tenant
 * Must be used AFTER auth middleware
 */
const validateTenantAccess = async (req, res, next) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    // Admin users can access any tenant
    if (req.user.role === 'ADMIN') {
      return next();
    }

    // User must belong to the resolved tenant or a child tenant
    if (!req.tenant) {
      return res.status(403).json({ error: 'Tenant context not available' });
    }

    // Check if user's tenant matches or is descendant of resolved tenant
    if (req.user.tenantId) {
      const userTenant = req.user.tenantId;
      const requestTenant = req.tenant.id;

      if (userTenant === requestTenant) {
        return next();
      }

      // Check if user's tenant is a descendant of request tenant
      const isDescendant = await tenantService.isAncestorOf(requestTenant, userTenant);
      if (isDescendant) {
        return next();
      }

      // Check if request tenant is a descendant of user's tenant (parent accessing child)
      const isAncestor = await tenantService.isAncestorOf(userTenant, requestTenant);
      if (isAncestor) {
        // Parent can view child tenant data (read-only enforced elsewhere)
        req.isParentAccess = true;
        return next();
      }

      return res.status(403).json({
        error: 'Access denied',
        message: 'You do not have access to this tenant\'s data'
      });
    }

    // User without tenant can only access root tenant
    if (!req.tenant.isRoot) {
      return res.status(403).json({
        error: 'Access denied',
        message: 'User must be assigned to a tenant'
      });
    }

    next();
  } catch (error) {
    console.error('Tenant access validation error:', error);
    next(error);
  }
};

/**
 * Enforce tenant scope on queries
 * Adds tenantId filter to req.query for use in controllers
 */
const enforceTenantScope = (req, res, next) => {
  if (!req.tenant) {
    return next();
  }

  // Admin can override tenant scope
  if (req.user?.role === 'ADMIN' && req.query.allTenants === 'true') {
    req.tenantScope = null; // No scope restriction
    return next();
  }

  // Set tenant scope
  req.tenantScope = req.tenant.id;

  // For parent accessing child, expand scope to include descendants
  if (req.isParentAccess || req.query.includeDescendants === 'true') {
    req.tenantScopeIncludesDescendants = true;
  }

  next();
};

/**
 * Block write operations for parent tenant accessing child
 */
const blockParentWrites = (req, res, next) => {
  if (req.isParentAccess && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    return res.status(403).json({
      error: 'Read-only access',
      message: 'Parent tenants can only view child tenant data, not modify it'
    });
  }
  next();
};

/**
 * Log tenant-related requests
 */
const auditTenantAccess = async (req, res, next) => {
  // Log after response
  res.on('finish', async () => {
    // Only log significant operations
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
      try {
        await auditService.log({
          userId: req.user?.id,
          tenantId: req.tenant?.id,
          ipAddress: req.ip || req.connection?.remoteAddress,
          userAgent: req.headers['user-agent'],
          action: 'UPDATE', // Generic action, specific logging done in controllers
          entityType: 'Request',
          entityId: null,
          metadata: {
            method: req.method,
            path: req.path,
            statusCode: res.statusCode
          }
        });
      } catch (error) {
        console.error('Audit logging error:', error);
      }
    }
  });

  next();
};

/**
 * Middleware to get tenant branding/config for frontend
 */
const getTenantConfig = async (req, res, next) => {
  if (!req.tenant) {
    return next();
  }

  req.tenantConfig = {
    name: req.tenant.brandName || req.tenant.name,
    logo: req.tenant.logoUrl,
    primaryColor: req.tenant.primaryColor,
    secondaryColor: req.tenant.secondaryColor,
    slug: req.tenant.slug
  };

  next();
};

/**
 * Helper to build tenant-scoped query filter
 */
const buildTenantFilter = async (req) => {
  if (!req.tenantScope) {
    return {}; // No scope restriction
  }

  if (req.tenantScopeIncludesDescendants) {
    // Get all descendant tenant IDs
    const descendants = await tenantService.getTenantDescendants(req.tenantScope);
    const tenantIds = [req.tenantScope, ...descendants.map(d => d.id)];
    return { tenantId: { in: tenantIds } };
  }

  return { tenantId: req.tenantScope };
};

module.exports = {
  resolveTenant,
  validateTenantAccess,
  enforceTenantScope,
  blockParentWrites,
  auditTenantAccess,
  getTenantConfig,
  buildTenantFilter
};
