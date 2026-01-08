/**
 * PRICING ENGINE SERVICE
 * ======================
 * Handles price resolution with tenant hierarchy inheritance.
 * 
 * NON-NEGOTIABLE RULES:
 * 1. Price is ALWAYS resolved server-side
 * 2. No tenant can price below parent's price
 * 3. No tenant can price below system base cost
 * 4. All price changes are versioned and logged
 * 5. Frontend NEVER sends price - always ignored
 */

const { PrismaClient } = require('@prisma/client');
const { v4: uuidv4 } = require('uuid');
const tenantService = require('./tenant.service');

const prisma = new PrismaClient();

const pricingEngine = {
  /**
   * CORE PRICE RESOLUTION
   * Resolves the effective price for a bundle based on:
   * 1. User's role
   * 2. User's tenant hierarchy
   * 3. System base prices
   * 
   * @param {string} bundleId - Bundle ID
   * @param {string} userId - User ID
   * @returns {Object} { price, source, bundleInfo }
   */
  async resolvePrice(bundleId, userId) {
    // Get user with tenant info
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { tenant: true }
    });

    if (!user) {
      throw new Error('User not found');
    }

    // Get bundle with base info
    const bundle = await prisma.bundle.findUnique({
      where: { id: bundleId },
      include: {
        prices: true,
        tenantPrices: true
      }
    });

    if (!bundle) {
      throw new Error('Bundle not found');
    }

    if (!bundle.isActive) {
      throw new Error('Bundle is not active');
    }

    const userRole = user.role;
    let resolvedPrice = null;
    let priceSource = null;

    // RESOLUTION ORDER:
    // 1. Check tenant-specific price for this role
    // 2. Walk up tenant hierarchy for prices
    // 3. Fall back to system role-based price
    // 4. Fall back to bundle base price

    if (user.tenantId) {
      // Check current tenant's price
      const tenantPrice = await this.getTenantPrice(user.tenantId, bundleId, userRole);
      if (tenantPrice) {
        resolvedPrice = tenantPrice.price;
        priceSource = `tenant:${user.tenantId}`;
      }

      // Walk up hierarchy if no price found
      if (!resolvedPrice) {
        const ancestors = await tenantService.getTenantAncestors(user.tenantId);
        for (const ancestor of ancestors.reverse()) {
          const ancestorPrice = await this.getTenantPrice(ancestor.id, bundleId, userRole);
          if (ancestorPrice) {
            resolvedPrice = ancestorPrice.price;
            priceSource = `tenant:${ancestor.id}`;
            break;
          }
        }
      }
    }

    // Fall back to system role price
    if (!resolvedPrice) {
      const rolePrice = bundle.prices.find(p => p.role === userRole);
      if (rolePrice) {
        resolvedPrice = rolePrice.price;
        priceSource = `role:${userRole}`;
      }
    }

    // Fall back to base price
    if (!resolvedPrice) {
      resolvedPrice = bundle.basePrice;
      priceSource = 'base';
    }

    // CRITICAL VALIDATION: Price must never be below base cost
    if (resolvedPrice < bundle.baseCost) {
      throw new Error(`Invalid price configuration: price (${resolvedPrice}) is below base cost (${bundle.baseCost})`);
    }

    return {
      price: resolvedPrice,
      baseCost: bundle.baseCost,
      source: priceSource,
      bundleInfo: {
        id: bundle.id,
        name: bundle.name,
        network: bundle.network,
        dataAmount: bundle.dataAmount,
        validity: bundle.validity
      }
    };
  },

  /**
   * Get tenant-specific price
   */
  async getTenantPrice(tenantId, bundleId, role) {
    const price = await prisma.tenantBundlePrice.findUnique({
      where: {
        tenantId_bundleId_role: {
          tenantId,
          bundleId,
          role
        }
      }
    });

    // Only return if valid
    if (price && price.isValid) {
      return price;
    }
    return null;
  },

  /**
   * Set tenant price with validation
   * @param {string} tenantId - Tenant setting the price
   * @param {string} bundleId - Bundle ID
   * @param {string} role - Role
   * @param {number} price - New price
   * @param {string} setById - User making the change
   */
  async setTenantPrice(tenantId, bundleId, role, price, setById) {
    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
      include: { parent: true }
    });

    if (!tenant) {
      throw new Error('Tenant not found');
    }

    const bundle = await prisma.bundle.findUnique({
      where: { id: bundleId }
    });

    if (!bundle) {
      throw new Error('Bundle not found');
    }

    // VALIDATION 1: Cannot be below bundle base cost
    if (price < bundle.baseCost) {
      throw new Error(`Price cannot be below base cost (GH₵ ${bundle.baseCost})`);
    }

    // VALIDATION 2: Cannot be below parent tenant's price (if not root)
    let parentPrice = bundle.basePrice;
    if (tenant.parentId) {
      const parentTenantPrice = await this.getTenantPrice(tenant.parentId, bundleId, role);
      if (parentTenantPrice) {
        parentPrice = parentTenantPrice.price;
      } else {
        // Get parent's resolved price
        const parentPriceInfo = await this.getParentEffectivePrice(tenant.parentId, bundleId, role);
        parentPrice = parentPriceInfo.price;
      }

      if (price < parentPrice) {
        throw new Error(`Price cannot be below parent tenant's price (GH₵ ${parentPrice})`);
      }
    }

    // Get current price for history
    const currentPrice = await prisma.tenantBundlePrice.findUnique({
      where: {
        tenantId_bundleId_role: { tenantId, bundleId, role }
      }
    });

    // Create/Update price
    const newPrice = await prisma.tenantBundlePrice.upsert({
      where: {
        tenantId_bundleId_role: { tenantId, bundleId, role }
      },
      update: {
        price,
        parentPriceAtCreation: parentPrice,
        isValid: true,
        updatedAt: new Date(),
        createdBy: setById
      },
      create: {
        id: uuidv4(),
        tenantId,
        bundleId,
        role,
        price,
        parentPriceAtCreation: parentPrice,
        isValid: true,
        createdBy: setById
      }
    });

    // Log price history
    await prisma.bundlePriceHistory.create({
      data: {
        id: uuidv4(),
        bundleId,
        tenantId,
        role,
        oldPrice: currentPrice?.price || 0,
        newPrice: price,
        changedBy: setById,
        changeReason: currentPrice ? 'Price update' : 'Initial price set'
      }
    });

    // Invalidate child tenant prices if they're now below this price
    await this.invalidateChildPrices(tenantId, bundleId, role, price);

    // Log audit
    await tenantService.logAudit({
      userId: setById,
      tenantId,
      action: 'PRICE_CHANGE',
      entityType: 'TenantBundlePrice',
      entityId: newPrice.id,
      oldValues: currentPrice,
      newValues: newPrice
    });

    return newPrice;
  },

  /**
   * Get parent's effective price for a bundle/role
   */
  async getParentEffectivePrice(parentTenantId, bundleId, role) {
    // Check if parent has specific price
    const parentPrice = await this.getTenantPrice(parentTenantId, bundleId, role);
    if (parentPrice) {
      return { price: parentPrice.price, source: `tenant:${parentTenantId}` };
    }

    // Get parent's ancestors
    const ancestors = await tenantService.getTenantAncestors(parentTenantId);
    for (const ancestor of ancestors.reverse()) {
      const ancestorPrice = await this.getTenantPrice(ancestor.id, bundleId, role);
      if (ancestorPrice) {
        return { price: ancestorPrice.price, source: `tenant:${ancestor.id}` };
      }
    }

    // Fall back to role price
    const rolePrice = await prisma.bundlePrice.findUnique({
      where: { bundleId_role: { bundleId, role } }
    });
    if (rolePrice) {
      return { price: rolePrice.price, source: `role:${role}` };
    }

    // Fall back to base price
    const bundle = await prisma.bundle.findUnique({ where: { id: bundleId } });
    return { price: bundle.basePrice, source: 'base' };
  },

  /**
   * Invalidate child tenant prices that are now below parent's new price
   */
  async invalidateChildPrices(parentTenantId, bundleId, role, newParentPrice) {
    // Get all descendants
    const descendants = await tenantService.getTenantDescendants(parentTenantId);
    const descendantIds = descendants.map(d => d.id);

    if (descendantIds.length === 0) return;

    // Find all child prices for this bundle/role that are below the new price
    const invalidPrices = await prisma.tenantBundlePrice.updateMany({
      where: {
        tenantId: { in: descendantIds },
        bundleId,
        role,
        price: { lt: newParentPrice }
      },
      data: { isValid: false }
    });

    if (invalidPrices.count > 0) {
      console.log(`Invalidated ${invalidPrices.count} child tenant prices below new parent price`);
    }
  },

  /**
   * Validate order price (called before order creation)
   * This is the final gatekeeper - NO order processes without valid price
   */
  async validateOrderPrice(bundleId, userId, quantity = 1) {
    const priceInfo = await this.resolvePrice(bundleId, userId);
    
    const totalPrice = priceInfo.price * quantity;
    const totalCost = priceInfo.baseCost * quantity;
    const margin = totalPrice - totalCost;

    if (margin < 0) {
      throw new Error('Invalid price: order would result in loss');
    }

    return {
      unitPrice: priceInfo.price,
      totalPrice,
      baseCost: priceInfo.baseCost,
      totalCost,
      margin,
      marginPercent: ((margin / totalCost) * 100).toFixed(2),
      source: priceInfo.source,
      bundle: priceInfo.bundleInfo
    };
  },

  /**
   * Get price ladder for a bundle (all roles)
   */
  async getPriceLadder(bundleId, tenantId = null) {
    const bundle = await prisma.bundle.findUnique({
      where: { id: bundleId },
      include: {
        prices: true,
        tenantPrices: tenantId ? {
          where: { tenantId }
        } : false
      }
    });

    if (!bundle) {
      throw new Error('Bundle not found');
    }

    const roles = ['ADMIN', 'PARTNER', 'SUPER_DEALER', 'DEALER', 'SUPER_AGENT', 'AGENT'];
    const ladder = [];

    for (const role of roles) {
      const rolePrice = bundle.prices.find(p => p.role === role);
      let tenantPrice = null;

      if (tenantId && bundle.tenantPrices) {
        tenantPrice = bundle.tenantPrices.find(p => p.role === role);
      }

      ladder.push({
        role,
        systemPrice: rolePrice?.price || bundle.basePrice,
        tenantPrice: tenantPrice?.price || null,
        effectivePrice: tenantPrice?.price || rolePrice?.price || bundle.basePrice,
        baseCost: bundle.baseCost
      });
    }

    return {
      bundle: {
        id: bundle.id,
        name: bundle.name,
        network: bundle.network,
        baseCost: bundle.baseCost,
        basePrice: bundle.basePrice
      },
      ladder
    };
  },

  /**
   * Bulk update role prices (admin only)
   */
  async updateSystemRolePrices(bundleId, prices, updatedById) {
    const bundle = await prisma.bundle.findUnique({
      where: { id: bundleId }
    });

    if (!bundle) {
      throw new Error('Bundle not found');
    }

    const results = [];

    for (const [role, price] of Object.entries(prices)) {
      if (price < bundle.baseCost) {
        throw new Error(`Price for ${role} cannot be below base cost`);
      }

      // Get current price
      const current = await prisma.bundlePrice.findUnique({
        where: { bundleId_role: { bundleId, role } }
      });

      // Update/Create
      const updated = await prisma.bundlePrice.upsert({
        where: { bundleId_role: { bundleId, role } },
        update: { price },
        create: {
          id: uuidv4(),
          bundleId,
          role,
          price
        }
      });

      // Log history
      await prisma.bundlePriceHistory.create({
        data: {
          id: uuidv4(),
          bundleId,
          tenantId: null,
          role,
          oldPrice: current?.price || 0,
          newPrice: price,
          changedBy: updatedById,
          changeReason: 'System role price update'
        }
      });

      results.push(updated);
    }

    return results;
  }
};

module.exports = pricingEngine;
