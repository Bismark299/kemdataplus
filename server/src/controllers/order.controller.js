const { PrismaClient } = require('@prisma/client');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');

const prisma = new PrismaClient();

// Import multi-tenant services (optional - graceful fallback if not available)
let pricingEngine, profitService, walletService, auditService, datahubService, settingsController;
try {
  pricingEngine = require('../services/pricing.service');
  profitService = require('../services/profit.service');
  walletService = require('../services/wallet.service');
  auditService = require('../services/audit.service');
  datahubService = require('../services/datahub.service');
  settingsController = require('./settings.controller');
} catch (e) {
  console.log('Multi-tenant services not available, using legacy mode');
}

// Helper to check if Mcbis API is enabled (uses in-memory cache)
function isMcbisEnabled() {
  // Use the settings controller cache if available
  if (settingsController && settingsController.getSiteSettings) {
    const siteSettings = settingsController.getSiteSettings();
    return siteSettings.mcbisAPI === true;
  }
  
  // Fallback to file read
  try {
    const settingsPath = path.join(__dirname, '../../settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    return settings.siteSettings?.mcbisAPI === true;
  } catch (e) {
    return false;
  }
}

/**
 * STRICT ORDER RULES - DO NOT MODIFY
 * ===================================
 * 1. Order price is ALWAYS fetched from bundle_prices table
 * 2. Frontend CANNOT send price - any price in request is IGNORED
 * 3. If no price exists for user's role → order is REJECTED
 * 4. Wallet deduction uses SERVER price only
 * 5. Order record stores the SERVER price
 * 
 * MULTI-TENANT EXTENSION:
 * 6. Price resolution uses tenant hierarchy if available
 * 7. Profit distribution occurs on order completion
 * 8. All operations are audited
 */

const orderController = {
  // Get user's orders
  async getOrders(req, res, next) {
    try {
      const page = parseInt(req.query.page) || 1;
      const limit = parseInt(req.query.limit) || 20;
      const skip = (page - 1) * limit;

      const [orders, total] = await Promise.all([
        prisma.order.findMany({
          where: { userId: req.user.id },
          skip,
          take: limit,
          include: {
            bundle: {
              select: {
                name: true,
                network: true,
                dataAmount: true
              }
            }
          },
          orderBy: { createdAt: 'desc' }
        }),
        prisma.order.count({
          where: { userId: req.user.id }
        })
      ]);

      res.json({
        orders,
        pagination: {
          page,
          limit,
          total,
          pages: Math.ceil(total / limit)
        }
      });
    } catch (error) {
      next(error);
    }
  },

  // Get order by ID
  async getOrderById(req, res, next) {
    try {
      // Build where clause - admins can see any order, users only their own
      const whereClause = { id: req.params.id };
      if (req.user.role !== 'ADMIN') {
        whereClause.userId = req.user.id;
      }
      
      const order = await prisma.order.findFirst({
        where: whereClause,
        include: {
          bundle: true,
          user: {
            select: {
              id: true,
              email: true,
              name: true
            }
          }
        }
      });

      if (!order) {
        return res.status(404).json({ error: 'Order not found' });
      }

      res.json(order);
    } catch (error) {
      next(error);
    }
  },

  /**
   * Create new order
   * STRICT RULES:
   * - Price is fetched from bundle_prices table, NOT from request
   * - If no price exists for role → reject order
   * - Frontend price is IGNORED completely
   * MULTI-TENANT: Uses pricing engine if available
   */
  async createOrder(req, res, next) {
    try {
      // ONLY accept bundle_id and phone_number from frontend
      // ANY price field is IGNORED
      const { bundleId, recipientPhone, quantity = 1 } = req.body;
      const userRole = req.user.role;
      const userId = req.user.id;
      const tenantId = req.user.tenantId || req.tenantId; // Multi-tenant support

      if (!bundleId || !recipientPhone) {
        return res.status(400).json({ error: 'bundleId and recipientPhone are required' });
      }

      // Get bundle with role-based prices from DATABASE
      const bundle = await prisma.bundle.findUnique({
        where: { id: bundleId },
        include: { prices: true }
      });

      if (!bundle) {
        return res.status(404).json({ error: 'Bundle not found' });
      }

      if (!bundle.isActive) {
        return res.status(400).json({ error: 'Bundle is not available' });
      }

      // PRICE RESOLUTION: Use pricing engine if available (multi-tenant)
      let unitPrice, baseCost;
      
      if (pricingEngine && tenantId) {
        // Multi-tenant pricing engine
        const priceResult = await pricingEngine.resolvePrice(bundleId, tenantId, userRole);
        if (!priceResult.success) {
          return res.status(403).json({ 
            error: 'This bundle is not available for your role',
            code: 'PRICE_NOT_SET'
          });
        }
        unitPrice = priceResult.price;
        baseCost = bundle.baseCost || 0;
      } else {
        // Legacy: Get price for user's role from DATABASE
        const rolePrice = bundle.prices.find(p => p.role === userRole);
        
        // STRICT: If no price exists for this role → REJECT ORDER
        if (!rolePrice) {
          return res.status(403).json({ 
            error: 'This bundle is not available for your role',
            code: 'PRICE_NOT_SET'
          });
        }
        unitPrice = rolePrice.price;
        baseCost = bundle.baseCost || 0;
      }

      // Use SERVER price ONLY - never trust frontend
      const totalPrice = Number((unitPrice * quantity).toFixed(2));
      const totalCost = Number((baseCost * quantity).toFixed(2));
      const orderReference = `ORD-${uuidv4().slice(0, 8).toUpperCase()}`;

      // RACE CONDITION FIX: Use serializable transaction with atomic balance check
      // This prevents double-spend by ensuring balance check and deduction are atomic
      let order;
      try {
        order = await prisma.$transaction(async (tx) => {
          // Get wallet with lock (inside transaction)
          const wallet = await tx.wallet.findUnique({
            where: { userId }
          });

          if (!wallet) {
            throw new Error('WALLET_NOT_FOUND');
          }

          // Check if wallet is frozen
          if (wallet.isFrozen) {
            throw new Error('WALLET_FROZEN');
          }

          // Check balance INSIDE transaction
          if (wallet.balance < totalPrice) {
            throw new Error('INSUFFICIENT_BALANCE');
          }

          // Atomic balance deduction - will fail if concurrent update changed balance
          const updatedWallet = await tx.wallet.update({
            where: { 
              id: wallet.id,
              // Optimistic lock: ensure balance hasn't changed
              balance: { gte: totalPrice }
            },
            data: {
              balance: { decrement: totalPrice }
            }
          });

          if (!updatedWallet) {
            throw new Error('INSUFFICIENT_BALANCE');
          }

          // Create order
          const newOrder = await tx.order.create({
          data: {
            userId,
            bundleId,
            recipientPhone,
            quantity,
            totalPrice, // SERVER PRICE ONLY
            unitPrice,  // Store unit price for profit calculation
            baseCost: totalCost, // Store base cost for profit tracking
            tenantId, // Multi-tenant support
            reference: orderReference,
            status: 'PENDING',
            paymentStatus: 'COMPLETED'
          },
          include: {
            bundle: {
              select: {
                name: true,
                network: true,
                dataAmount: true
              }
            }
          }
          });

          // Create transaction record
          await tx.transaction.create({
            data: {
              walletId: wallet.id,
              type: 'PURCHASE',
              amount: -totalPrice,
              status: 'COMPLETED',
              reference: orderReference,
              description: `Purchase: ${bundle.name} x${quantity}`
            }
          });

          return newOrder;
        }, {
          // Serializable isolation level prevents concurrent modifications
          isolationLevel: 'Serializable',
          timeout: 10000 // 10 second timeout
        });
      } catch (txError) {
        // Handle specific transaction errors
        if (txError.message === 'WALLET_NOT_FOUND') {
          return res.status(400).json({ error: 'Wallet not found' });
        }
        if (txError.message === 'WALLET_FROZEN') {
          return res.status(403).json({ 
            error: 'Your wallet is frozen. Please contact support.',
            code: 'WALLET_FROZEN'
          });
        }
        if (txError.message === 'INSUFFICIENT_BALANCE') {
          return res.status(400).json({ 
            error: 'Insufficient balance',
            required: totalPrice
          });
        }
        throw txError; // Re-throw unexpected errors
      }

      // Audit logging (multi-tenant)
      if (auditService) {
        await auditService.log({
          userId,
          tenantId,
          action: 'CREATE',
          entityType: 'Order',
          entityId: order.id,
          newValues: { bundleId, recipientPhone, quantity, totalPrice, unitPrice },
          ipAddress: req.ip
        });
      }

      // AUTO-PROCESS via Mcbis API if enabled
      let apiResult = null;
      if (isMcbisEnabled() && datahubService) {
        try {
          console.log(`[Mcbis] Auto-processing order ${order.id}`);
          apiResult = await datahubService.processOrder(order.id);
          console.log(`[Mcbis] Order ${order.id} result:`, apiResult);
        } catch (apiError) {
          console.error(`[Mcbis] Auto-process failed for ${order.id}:`, apiError.message);
          // Don't fail the order - just log the error
        }
      }

      res.status(201).json({
        message: 'Order created successfully',
        order,
        apiProcessed: apiResult?.success || false,
        apiReference: apiResult?.apiReference || null
      });
    } catch (error) {
      next(error);
    }
  },

  // Cancel order
  async cancelOrder(req, res, next) {
    try {
      const order = await prisma.order.findFirst({
        where: {
          id: req.params.id,
          userId: req.user.id,
          status: 'PENDING'
        }
      });

      if (!order) {
        return res.status(404).json({ error: 'Order not found or cannot be cancelled' });
      }

      const wallet = await prisma.wallet.findUnique({
        where: { userId: req.user.id }
      });

      // Refund and cancel order - updates both status and paymentStatus
      await prisma.$transaction([
        prisma.order.update({
          where: { id: order.id },
          data: { 
            status: 'CANCELLED',
            paymentStatus: 'REFUNDED'
          }
        }),
        prisma.wallet.update({
          where: { id: wallet.id },
          data: {
            balance: { increment: order.totalPrice }
          }
        }),
        prisma.transaction.create({
          data: {
            walletId: wallet.id,
            type: 'REFUND',
            amount: order.totalPrice,
            status: 'COMPLETED',
            reference: `REF-${order.reference}`,
            description: `Refund for cancelled order ${order.reference}`
          }
        })
      ]);

      res.json({ message: 'Order cancelled and refunded' });
    } catch (error) {
      next(error);
    }
  },

  // Get all orders (admin)
  // Supports ?compact=true for minimal response size
  async getAllOrders(req, res, next) {
    try {
      const page = parseInt(req.query.page) || 1;
      // Cap limit at 200 to prevent response size issues
      const requestedLimit = parseInt(req.query.limit) || 20;
      const limit = Math.min(requestedLimit, 200);
      const skip = (page - 1) * limit;
      const { status, userId, compact } = req.query;

      const where = {};
      if (status) where.status = status;
      if (userId) where.userId = userId;

      // Compact mode returns minimal fields for better performance
      const isCompact = compact === 'true' || compact === '1';
      
      const selectFields = isCompact ? {
        id: true,
        reference: true,
        recipientPhone: true,
        totalPrice: true,
        status: true,
        paymentStatus: true,
        createdAt: true,
        bundle: { select: { name: true, network: true, dataAmount: true } },
        user: { select: { name: true, id: true } }
      } : undefined;

      const includeFields = isCompact ? undefined : {
        bundle: { select: { name: true, network: true, dataAmount: true } },
        user: { select: { email: true, name: true, id: true, role: true } }
      };

      const [orders, total] = await Promise.all([
        prisma.order.findMany({
          where,
          skip,
          take: limit,
          ...(isCompact ? { select: selectFields } : { include: includeFields }),
          orderBy: { createdAt: 'desc' }
        }),
        prisma.order.count({ where })
      ]);

      res.json({
        orders,
        pagination: {
          page,
          limit,
          total,
          pages: Math.ceil(total / limit)
        }
      });
    } catch (error) {
      next(error);
    }
  },

  // Update order status (admin) - ONLY updates order_status, NOT payment_status
  // MULTI-TENANT: Triggers profit distribution on COMPLETED
  async updateOrderStatus(req, res, next) {
    try {
      const { status } = req.body;
      const validStatuses = ['PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED'];

      if (!validStatuses.includes(status)) {
        return res.status(400).json({ error: 'Invalid status' });
      }

      // Get current order state for comparison
      const existingOrder = await prisma.order.findUnique({
        where: { id: req.params.id }
      });

      if (!existingOrder) {
        return res.status(404).json({ error: 'Order not found' });
      }

      // IMPORTANT: Only update order status, payment status remains unchanged
      const order = await prisma.order.update({
        where: { id: req.params.id },
        data: { status }  // Only status field, never paymentStatus
      });

      // MULTI-TENANT: Trigger profit distribution when order completes
      if (status === 'COMPLETED' && existingOrder.status !== 'COMPLETED' && profitService) {
        try {
          await profitService.distributeOrderProfits(order.id);
        } catch (profitError) {
          console.error('Profit distribution failed:', profitError);
          // Don't fail the order update, just log
        }
      }

      // Audit logging
      if (auditService) {
        await auditService.log({
          userId: req.user.id,
          tenantId: order.tenantId,
          action: 'UPDATE',
          entityType: 'Order',
          entityId: order.id,
          previousValues: { status: existingOrder.status },
          newValues: { status },
          ipAddress: req.ip
        });
      }

      res.json({
        message: 'Order status updated',
        order
      });
    } catch (error) {
      next(error);
    }
  },

  // Admin refund order - updates both paymentStatus to REFUNDED and status to CANCELLED
  async adminRefundOrder(req, res, next) {
    try {
      const order = await prisma.order.findUnique({
        where: { id: req.params.id },
        include: { user: true }
      });

      if (!order) {
        return res.status(404).json({ error: 'Order not found' });
      }

      // Check if already refunded
      if (order.paymentStatus === 'REFUNDED') {
        return res.status(400).json({ error: 'Order has already been refunded' });
      }

      // Get user's wallet
      const wallet = await prisma.wallet.findUnique({
        where: { userId: order.userId }
      });

      if (!wallet) {
        return res.status(404).json({ error: 'User wallet not found' });
      }

      // Refund the order - update both statuses and credit wallet
      await prisma.$transaction([
        prisma.order.update({
          where: { id: order.id },
          data: { 
            status: 'CANCELLED',
            paymentStatus: 'REFUNDED'
          }
        }),
        prisma.wallet.update({
          where: { id: wallet.id },
          data: {
            balance: { increment: order.totalPrice }
          }
        }),
        prisma.transaction.create({
          data: {
            walletId: wallet.id,
            type: 'REFUND',
            amount: order.totalPrice,
            status: 'COMPLETED',
            reference: `REF-${order.reference}`,
            description: `Admin refund for order ${order.reference}`
          }
        })
      ]);

      res.json({ 
        message: 'Order refunded successfully',
        refundedAmount: order.totalPrice
      });
    } catch (error) {
      next(error);
    }
  }
};

module.exports = orderController;
