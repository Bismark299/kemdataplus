/**
 * PROFIT DISTRIBUTION SERVICE
 * ============================
 * Handles automatic profit calculation and distribution up the hierarchy.
 * 
 * NON-NEGOTIABLE RULES:
 * 1. Profit is calculated from price differences between hierarchy levels
 * 2. No manual commission entries - all automated
 * 3. Profit distribution is atomic with order settlement
 * 4. No profit on failed/cancelled orders
 * 5. All profit records are immutable
 * 6. Profit entries must be audited
 */

const { PrismaClient } = require('@prisma/client');
const { v4: uuidv4 } = require('uuid');
const tenantService = require('./tenant.service');
const walletService = require('./wallet.service');

const prisma = new PrismaClient();

const profitService = {
  /**
   * Calculate and distribute profits for a completed order
   * Called ONLY when order status changes to COMPLETED
   * 
   * @param {string} orderId - Order ID
   * @returns {Object} Distribution summary
   */
  async distributeOrderProfits(orderId) {
    // Use transaction for atomicity
    return await prisma.$transaction(async (tx) => {
      // Get order with all related data
      const order = await tx.order.findUnique({
        where: { id: orderId },
        include: {
          user: {
            include: { tenant: true }
          },
          bundle: true
        }
      });

      if (!order) {
        throw new Error('Order not found');
      }

      if (order.status !== 'COMPLETED') {
        throw new Error('Cannot distribute profits for non-completed order');
      }

      if (order.profitDistributed) {
        throw new Error('Profits already distributed for this order');
      }

      const profitRecords = [];
      const totalOrderProfit = order.totalPrice - order.baseCost;

      if (totalOrderProfit <= 0) {
        // No profit to distribute
        await tx.order.update({
          where: { id: orderId },
          data: { profitDistributed: true }
        });
        return { distributed: false, reason: 'No profit margin' };
      }

      // Get hierarchy chain (from order user up to root)
      const hierarchyChain = await this.buildProfitHierarchy(order.user, order);

      let remainingProfit = totalOrderProfit;
      let currentCost = order.baseCost;

      // Distribute profits up the chain
      for (let i = 0; i < hierarchyChain.length; i++) {
        const level = hierarchyChain[i];
        
        if (level.margin <= 0) continue;

        // Create profit record
        const profitRecord = await tx.profitRecord.create({
          data: {
            id: uuidv4(),
            orderId: order.id,
            tenantId: level.tenantId,
            beneficiaryId: level.userId,
            sourceUserId: order.userId,
            amount: level.margin,
            profitType: level.profitType,
            hierarchyLevel: i,
            sellingPrice: level.sellingPrice,
            costPrice: level.costPrice,
            marginPercent: level.marginPercent,
            status: 'PENDING'
          }
        });

        profitRecords.push(profitRecord);
        remainingProfit -= level.margin;
      }

      // Mark order as profit distributed
      await tx.order.update({
        where: { id: orderId },
        data: { profitDistributed: true }
      });

      return {
        distributed: true,
        orderId,
        totalProfit: totalOrderProfit,
        records: profitRecords.length,
        profitRecords
      };
    });
  },

  /**
   * Build profit hierarchy chain for an order
   * Returns array of profit levels from direct seller to root
   */
  async buildProfitHierarchy(orderUser, order) {
    const chain = [];
    
    // Level 0: Direct seller (the user who made the sale)
    // Their profit = their price - their cost (what they pay)
    const directProfit = {
      userId: orderUser.id,
      tenantId: orderUser.tenantId,
      profitType: 'DIRECT_SALE',
      sellingPrice: order.totalPrice,
      costPrice: order.baseCost, // This should be resolved from their parent's price
      margin: 0, // Will calculate
      marginPercent: 0
    };

    // Get user's parent price (what they pay)
    let userCost = order.baseCost;
    if (orderUser.parentUserId) {
      const parentPriceInfo = await this.getUserEffectivePrice(
        orderUser.parentUserId,
        order.bundleId,
        orderUser.role
      );
      userCost = parentPriceInfo * order.quantity;
    } else if (orderUser.tenantId) {
      // Get tenant's cost from parent tenant
      const tenantCost = await this.getTenantCost(
        orderUser.tenantId,
        order.bundleId,
        orderUser.role
      );
      userCost = tenantCost * order.quantity;
    }

    directProfit.costPrice = userCost;
    directProfit.margin = order.totalPrice - userCost;
    directProfit.marginPercent = userCost > 0 
      ? ((directProfit.margin / userCost) * 100) 
      : 0;

    if (directProfit.margin > 0) {
      chain.push(directProfit);
    }

    // Walk up user hierarchy
    let currentUser = orderUser;
    let previousCost = userCost;

    while (currentUser.parentUserId) {
      const parentUser = await prisma.user.findUnique({
        where: { id: currentUser.parentUserId },
        include: { tenant: true }
      });

      if (!parentUser) break;

      // Get parent's cost
      let parentCost = order.baseCost;
      if (parentUser.parentUserId) {
        const grandparentPrice = await this.getUserEffectivePrice(
          parentUser.parentUserId,
          order.bundleId,
          parentUser.role
        );
        parentCost = grandparentPrice * order.quantity;
      } else if (parentUser.tenantId) {
        const tenantCost = await this.getTenantCost(
          parentUser.tenantId,
          order.bundleId,
          parentUser.role
        );
        parentCost = tenantCost * order.quantity;
      }

      const uplineMargin = previousCost - parentCost;

      if (uplineMargin > 0) {
        chain.push({
          userId: parentUser.id,
          tenantId: parentUser.tenantId,
          profitType: 'UPLINE_COMMISSION',
          sellingPrice: previousCost,
          costPrice: parentCost,
          margin: uplineMargin,
          marginPercent: parentCost > 0 ? ((uplineMargin / parentCost) * 100) : 0
        });
      }

      previousCost = parentCost;
      currentUser = parentUser;
    }

    // Walk up tenant hierarchy for tenant margins
    if (orderUser.tenantId) {
      let currentTenant = await prisma.tenant.findUnique({
        where: { id: orderUser.tenantId }
      });

      while (currentTenant && currentTenant.parentId) {
        const parentTenant = await prisma.tenant.findUnique({
          where: { id: currentTenant.parentId }
        });

        if (!parentTenant) break;

        // Get tenant owner (if exists) for profit crediting
        const tenantOwner = await prisma.user.findFirst({
          where: {
            tenantId: currentTenant.id,
            role: { in: ['ADMIN', 'PARTNER', 'SUPER_DEALER'] }
          }
        });

        if (tenantOwner) {
          // Calculate tenant margin
          const currentTenantCost = await this.getTenantCost(
            currentTenant.id,
            order.bundleId,
            'AGENT' // Base role for calculation
          );
          
          const parentTenantCost = await this.getTenantCost(
            parentTenant.id,
            order.bundleId,
            'AGENT'
          );

          const tenantMargin = (currentTenantCost - parentTenantCost) * order.quantity;

          if (tenantMargin > 0) {
            chain.push({
              userId: tenantOwner.id,
              tenantId: currentTenant.id,
              profitType: 'TENANT_MARGIN',
              sellingPrice: currentTenantCost * order.quantity,
              costPrice: parentTenantCost * order.quantity,
              margin: tenantMargin,
              marginPercent: parentTenantCost > 0 
                ? ((tenantMargin / (parentTenantCost * order.quantity)) * 100) 
                : 0
            });
          }
        }

        currentTenant = parentTenant;
      }
    }

    return chain;
  },

  /**
   * Get user's effective price for a bundle
   */
  async getUserEffectivePrice(userId, bundleId, role) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { tenant: true }
    });

    if (!user) return null;

    // Check tenant-specific price
    if (user.tenantId) {
      const tenantPrice = await prisma.tenantBundlePrice.findUnique({
        where: {
          tenantId_bundleId_role: {
            tenantId: user.tenantId,
            bundleId,
            role
          }
        }
      });
      if (tenantPrice && tenantPrice.isValid) {
        return tenantPrice.price;
      }
    }

    // Fall back to role price
    const rolePrice = await prisma.bundlePrice.findUnique({
      where: { bundleId_role: { bundleId, role } }
    });
    if (rolePrice) {
      return rolePrice.price;
    }

    // Fall back to base price
    const bundle = await prisma.bundle.findUnique({ where: { id: bundleId } });
    return bundle?.basePrice || 0;
  },

  /**
   * Get tenant's cost for a bundle
   */
  async getTenantCost(tenantId, bundleId, role) {
    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId }
    });

    if (!tenant || !tenant.parentId) {
      // Root tenant - cost is base cost
      const bundle = await prisma.bundle.findUnique({ where: { id: bundleId } });
      return bundle?.baseCost || 0;
    }

    // Get parent tenant's price (which is this tenant's cost)
    const parentPrice = await prisma.tenantBundlePrice.findUnique({
      where: {
        tenantId_bundleId_role: {
          tenantId: tenant.parentId,
          bundleId,
          role
        }
      }
    });

    if (parentPrice && parentPrice.isValid) {
      return parentPrice.price;
    }

    // Walk up hierarchy
    const ancestors = await tenantService.getTenantAncestors(tenantId);
    for (const ancestor of ancestors.reverse()) {
      const ancestorPrice = await prisma.tenantBundlePrice.findUnique({
        where: {
          tenantId_bundleId_role: {
            tenantId: ancestor.id,
            bundleId,
            role
          }
        }
      });
      if (ancestorPrice && ancestorPrice.isValid) {
        return ancestorPrice.price;
      }
    }

    // Fall back to role price
    const rolePrice = await prisma.bundlePrice.findUnique({
      where: { bundleId_role: { bundleId, role } }
    });
    if (rolePrice) {
      return rolePrice.price;
    }

    const bundle = await prisma.bundle.findUnique({ where: { id: bundleId } });
    return bundle?.baseCost || 0;
  },

  /**
   * Credit pending profits to wallets
   * Called periodically or on-demand
   */
  async creditPendingProfits() {
    const pendingProfits = await prisma.profitRecord.findMany({
      where: { status: 'PENDING' },
      include: {
        beneficiary: true,
        order: true
      }
    });

    const results = {
      processed: 0,
      credited: 0,
      failed: 0,
      totalAmount: 0
    };

    for (const profit of pendingProfits) {
      try {
        // Credit to wallet
        await walletService.creditWallet(
          profit.beneficiaryId,
          profit.amount,
          `Profit from order ${profit.orderId.slice(0, 8)}`,
          `PROFIT-${profit.id}`,
          { profitRecordId: profit.id, profitType: profit.profitType }
        );

        // Update profit record
        await prisma.profitRecord.update({
          where: { id: profit.id },
          data: {
            status: 'COMPLETED',
            creditedAt: new Date()
          }
        });

        results.credited++;
        results.totalAmount += profit.amount;
      } catch (error) {
        console.error(`Failed to credit profit ${profit.id}:`, error);
        
        await prisma.profitRecord.update({
          where: { id: profit.id },
          data: { status: 'FAILED' }
        });
        
        results.failed++;
      }

      results.processed++;
    }

    return results;
  },

  /**
   * Get profit summary for a user
   */
  async getUserProfitSummary(userId, period = 'all') {
    let dateFilter = {};
    const now = new Date();

    switch (period) {
      case 'today':
        dateFilter = {
          createdAt: {
            gte: new Date(now.setHours(0, 0, 0, 0))
          }
        };
        break;
      case 'week':
        dateFilter = {
          createdAt: {
            gte: new Date(now.setDate(now.getDate() - 7))
          }
        };
        break;
      case 'month':
        dateFilter = {
          createdAt: {
            gte: new Date(now.setMonth(now.getMonth() - 1))
          }
        };
        break;
    }

    const profits = await prisma.profitRecord.findMany({
      where: {
        beneficiaryId: userId,
        status: 'COMPLETED',
        ...dateFilter
      }
    });

    const summary = {
      totalProfit: 0,
      directSales: 0,
      uplineCommissions: 0,
      tenantMargins: 0,
      orderCount: new Set(),
      byType: {}
    };

    for (const profit of profits) {
      summary.totalProfit += profit.amount;
      summary.orderCount.add(profit.orderId);

      if (!summary.byType[profit.profitType]) {
        summary.byType[profit.profitType] = 0;
      }
      summary.byType[profit.profitType] += profit.amount;

      switch (profit.profitType) {
        case 'DIRECT_SALE':
          summary.directSales += profit.amount;
          break;
        case 'UPLINE_COMMISSION':
          summary.uplineCommissions += profit.amount;
          break;
        case 'TENANT_MARGIN':
          summary.tenantMargins += profit.amount;
          break;
      }
    }

    summary.orderCount = summary.orderCount.size;

    return summary;
  },

  /**
   * Get profit flow for a specific order
   */
  async getOrderProfitFlow(orderId) {
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: {
        user: true,
        bundle: true,
        profitRecords: {
          include: {
            beneficiary: {
              select: { id: true, name: true, email: true, role: true }
            }
          },
          orderBy: { hierarchyLevel: 'asc' }
        }
      }
    });

    if (!order) {
      throw new Error('Order not found');
    }

    return {
      order: {
        id: order.id,
        totalPrice: order.totalPrice,
        baseCost: order.baseCost,
        totalProfit: order.totalPrice - order.baseCost,
        profitDistributed: order.profitDistributed
      },
      flow: order.profitRecords.map(p => ({
        level: p.hierarchyLevel,
        beneficiary: p.beneficiary,
        profitType: p.profitType,
        amount: p.amount,
        marginPercent: p.marginPercent,
        status: p.status
      }))
    };
  },

  /**
   * Get tenant profit report
   */
  async getTenantProfitReport(tenantId, startDate, endDate) {
    const profits = await prisma.profitRecord.findMany({
      where: {
        tenantId,
        createdAt: {
          gte: new Date(startDate),
          lte: new Date(endDate)
        }
      },
      include: {
        order: true,
        beneficiary: {
          select: { id: true, name: true, role: true }
        }
      }
    });

    // Group by day
    const byDay = {};
    const byUser = {};
    let totalProfit = 0;

    for (const profit of profits) {
      const day = profit.createdAt.toISOString().split('T')[0];
      
      if (!byDay[day]) {
        byDay[day] = { count: 0, amount: 0 };
      }
      byDay[day].count++;
      byDay[day].amount += profit.amount;

      if (!byUser[profit.beneficiaryId]) {
        byUser[profit.beneficiaryId] = {
          user: profit.beneficiary,
          count: 0,
          amount: 0
        };
      }
      byUser[profit.beneficiaryId].count++;
      byUser[profit.beneficiaryId].amount += profit.amount;

      totalProfit += profit.amount;
    }

    return {
      tenantId,
      period: { startDate, endDate },
      totalProfit,
      totalRecords: profits.length,
      byDay: Object.entries(byDay).map(([date, data]) => ({ date, ...data })),
      byUser: Object.values(byUser)
    };
  }
};

module.exports = profitService;
