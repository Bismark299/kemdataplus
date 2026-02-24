const { v4: uuidv4 } = require('uuid');
const { Prisma } = require('@prisma/client');
const fs = require('fs');
const path = require('path');

const prisma = require('../lib/prisma');

// Import multi-tenant services (optional - graceful fallback if not available)
let pricingEngine, profitService, walletService, auditService, datahubService, easyDataService, settingsController, financialOrderService;
try {
  pricingEngine = require('../services/pricing.service');
  profitService = require('../services/profit.service');
  walletService = require('../services/wallet.service');
  auditService = require('../services/audit.service');
  datahubService = require('../services/datahub.service');
  easyDataService = require('../services/easydata.service');
  settingsController = require('./settings.controller');
  financialOrderService = require('../services/financial-order.service');
} catch (e) {
  console.log('Multi-tenant services not available, using legacy mode');
}

// Helper to get site settings (use settingsController's cached version if available)
function getSiteSettings() {
  if (settingsController && settingsController.getSiteSettings) {
    const settings = settingsController.getSiteSettings();
    console.log(`[getSiteSettings] Using settingsController cache:`, JSON.stringify(settings));
    return settings;
  }
  try {
    const settingsPath = path.join(__dirname, '../../settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    console.log(`[getSiteSettings] Using file:`, JSON.stringify(settings.siteSettings));
    return settings.siteSettings || {};
  } catch (e) {
    console.log(`[getSiteSettings] Error:`, e.message);
    return {};
  }
}

// Either/Or API Provider Selection
// masterAPI ON → EasyDataGH, mcbisAPI ON → MCBIS, Both OFF → null
function getApiProvider() {
  const siteSettings = getSiteSettings();
  
  // Debug log to see what settings we have
  console.log(`[API] Settings check - masterAPI: ${siteSettings.masterAPI}, mcbisAPI: ${siteSettings.mcbisAPI}`);
  
  // Check masterAPI (accepts true, "true", 1)
  if (siteSettings.masterAPI === true || siteSettings.masterAPI === 'true' || siteSettings.masterAPI === 1) {
    console.log(`[API] Using EasyDataGH provider`);
    return { name: 'EASYDATA', service: easyDataService };
  }
  
  // Check mcbisAPI (accepts true, "true", 1)
  if (siteSettings.mcbisAPI === true || siteSettings.mcbisAPI === 'true' || siteSettings.mcbisAPI === 1) {
    console.log(`[API] Using MCBIS provider`);
    return { name: 'MCBIS', service: datahubService };
  }
  
  console.log(`[API] No API provider enabled`);
  return null;
}

// Helper to check if API is enabled for a specific network
// Provider-specific toggles: easydata_mtnAPI, mcbis_mtnAPI, etc.
function isNetworkApiEnabled(network) {
  const siteSettings = getSiteSettings();
  const provider = getApiProvider();
  
  // No provider enabled
  if (!provider) {
    console.log(`[API] No API provider enabled (masterAPI and mcbisAPI both OFF)`);
    return false;
  }
  
  const networkLower = (network || '').toLowerCase();
  const providerPrefix = provider.name === 'EASYDATA' ? 'easydata' : 'mcbis';
  
  // Check provider-specific network toggle
  if (networkLower === 'mtn') {
    const toggleKey = `${providerPrefix}_mtnAPI`;
    const enabled = siteSettings[toggleKey] !== false;
    console.log(`[API:${provider.name}] MTN API check: ${toggleKey}=${siteSettings[toggleKey]}, enabled=${enabled}`);
    return enabled;
  }
  if (networkLower === 'telecel' || networkLower === 'vodafone') {
    const toggleKey = `${providerPrefix}_telecelAPI`;
    const enabled = siteSettings[toggleKey] !== false;
    console.log(`[API:${provider.name}] Telecel API check: ${toggleKey}=${siteSettings[toggleKey]}, enabled=${enabled}`);
    return enabled;
  }
  if (networkLower === 'airteltigo' || networkLower === 'at') {
    const toggleKey = `${providerPrefix}_airteltigoAPI`;
    const enabled = siteSettings[toggleKey] !== false;
    console.log(`[API:${provider.name}] AirtelTigo API check: ${toggleKey}=${siteSettings[toggleKey]}, enabled=${enabled}`);
    return enabled;
  }
  
  // Unknown network - allow by default if provider is enabled
  console.log(`[API:${provider.name}] Network '${network}' - allowing (provider enabled)`);
  return true;
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

          // Check balance INSIDE transaction (round to 2 decimals to avoid float precision issues)
          const availableBalance = Math.round(wallet.balance * 100) / 100;
          const requiredAmount = Math.round(totalPrice * 100) / 100;
          if (availableBalance < requiredAmount) {
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

      // AUTO-PROCESS via API (Either/Or: masterAPI → EasyData, mcbisAPI → MCBIS)
      let apiResult = null;
      const orderNetwork = order.bundle?.network || bundle.network;
      const apiProvider = getApiProvider();
      
      console.log(`[API] Order ${order.id} - Network: ${orderNetwork}, Provider: ${apiProvider?.name || 'NONE'}`);
      
      if (apiProvider && isNetworkApiEnabled(orderNetwork)) {
        try {
          // ============ ATOMIC LOCK: Claim this order BEFORE calling API ============
          const claimResult = await prisma.order.updateMany({
            where: {
              id: order.id,
              apiSentAt: null,  // Only claim if not already claimed!
              status: 'PENDING',
              externalReference: null
            },
            data: {
              apiSentAt: new Date()  // Mark as claimed
            }
          });
          
          // If count is 0, another request already claimed this order
          if (claimResult.count === 0) {
            console.log(`[API] ATOMIC LOCK: Order ${order.id} already claimed by another request`);
          } else {
            console.log(`[API:${apiProvider.name}] ATOMIC LOCK: Claimed order ${order.id} for processing`);
            
            // Extract data amount
            let dataAmount = 1;
            if (bundle.dataAmount) {
              const match = bundle.dataAmount.match(/(\d+)/);
              if (match) dataAmount = parseInt(match[1]);
            }
            
            // Place order via selected API
            const result = await apiProvider.service.placeOrder({
              network: orderNetwork,
              phone: order.recipientPhone,
              amount: dataAmount,
              orderId: order.id
            });
            
            // Update order with result
            // PROCESSING = API accepted, waiting for delivery confirmation
            await prisma.order.update({
              where: { id: order.id },
              data: {
                status: result.success ? 'PROCESSING' : 'PENDING',
                externalReference: result.reference || null,
                // apiSentAt already set by atomic lock
              }
            });
            
            // If failed, clear apiSentAt so it can be retried
            if (!result.success) {
              await prisma.order.update({
                where: { id: order.id },
                data: { apiSentAt: null }
              });
            }
            
            apiResult = result;
            console.log(`[API:${apiProvider.name}] Order ${order.id} result:`, result.success ? 'SUCCESS' : result.error);
          }
        } catch (apiError) {
          console.error(`[API] Auto-process failed for ${order.id}:`, apiError.message);
          // Clear apiSentAt on error so order can be retried
          await prisma.order.update({
            where: { id: order.id },
            data: { apiSentAt: null }
          }).catch(() => {});
        }
      } else {
        console.log(`[API] Not processing order ${order.id} - ${apiProvider ? `${orderNetwork} API disabled` : 'No provider enabled'}`);
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

  // Cancel order - HARDENED: Serializable transaction with atomic status re-check
  async cancelOrder(req, res, next) {
    try {
      const result = await prisma.$transaction(async (tx) => {
        // Re-check order status INSIDE transaction to prevent double-refund
        const order = await tx.order.findFirst({
          where: {
            id: req.params.id,
            userId: req.user.id,
            status: 'PENDING' // Only cancel PENDING orders
          }
        });

        if (!order) {
          throw new Error('ORDER_NOT_FOUND_OR_NOT_CANCELLABLE');
        }

        const wallet = await tx.wallet.findUnique({
          where: { userId: req.user.id }
        });

        if (!wallet) {
          throw new Error('WALLET_NOT_FOUND');
        }

        // Atomic status transition
        await tx.order.update({
          where: { id: order.id },
          data: { 
            status: 'CANCELLED',
            paymentStatus: 'REFUNDED'
          }
        });

        // Refund wallet
        await tx.wallet.update({
          where: { id: wallet.id },
          data: {
            balance: { increment: order.totalPrice }
          }
        });

        // Create refund transaction
        await tx.transaction.create({
          data: {
            walletId: wallet.id,
            type: 'REFUND',
            amount: order.totalPrice,
            status: 'COMPLETED',
            reference: `REF-${order.reference}`,
            description: `Refund for cancelled order ${order.reference}`
          }
        });

        // Audit log
        await tx.auditLog.create({
          data: {
            userId: req.user.id,
            action: 'ORDER_CANCEL_REFUND',
            entityType: 'Order',
            entityId: order.id,
            newValues: {
              refundAmount: order.totalPrice,
              reference: order.reference
            }
          }
        });

        return order;
      }, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        timeout: 10000
      });

      res.json({ message: 'Order cancelled and refunded' });
    } catch (error) {
      if (error.message === 'ORDER_NOT_FOUND_OR_NOT_CANCELLABLE') {
        return res.status(404).json({ error: 'Order not found or cannot be cancelled' });
      }
      if (error.message === 'WALLET_NOT_FOUND') {
        return res.status(400).json({ error: 'Wallet not found' });
      }
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
  // HARDENED: State machine enforcement prevents invalid transitions
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

      // STRICT STATE MACHINE: Only allow valid forward transitions
      const ALLOWED_TRANSITIONS = {
        'PENDING':    ['PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED'],
        'PROCESSING': ['COMPLETED', 'FAILED'],
        'COMPLETED':  [],           // Terminal state - NO going back
        'FAILED':     ['PENDING'],  // Allow retry only back to PENDING
        'CANCELLED':  [],           // Terminal state - NO going back
      };

      const allowed = ALLOWED_TRANSITIONS[existingOrder.status] || [];
      if (!allowed.includes(status)) {
        return res.status(400).json({ 
          error: `Cannot transition from ${existingOrder.status} to ${status}`,
          code: 'INVALID_STATE_TRANSITION',
          currentStatus: existingOrder.status,
          allowedTransitions: allowed
        });
      }

      // IMPORTANT: Only update order status, payment status remains unchanged
      const order = await prisma.order.update({
        where: { id: req.params.id },
        data: { status }  // Only status field, never paymentStatus
      });

      // SYNC: Update related StorefrontOrder status if exists
      const storefrontOrder = await prisma.storefrontOrder.findFirst({
        where: { orderId: order.id }
      });
      
      if (storefrontOrder) {
        await prisma.storefrontOrder.update({
          where: { id: storefrontOrder.id },
          data: { status }
        });
        console.log(`[Order] Synced StorefrontOrder ${storefrontOrder.id} to status: ${status}`);
        
        // STOREFRONT PROFIT: Credit agent profit when completing storefront order
        if (status === 'COMPLETED' && existingOrder.status !== 'COMPLETED' && financialOrderService) {
          try {
            const profitResult = await financialOrderService.creditAgentProfit(storefrontOrder.id);
            console.log(`[Order] Storefront profit credit result:`, profitResult);
          } catch (profitError) {
            console.error('[Order] Storefront profit credit failed:', profitError);
            // Don't fail the order update, just log
          }
        }
        
        // CANCEL PENDING PROFIT: If order fails/cancels, cancel any pending profit
        if ((status === 'FAILED' || status === 'CANCELLED') && existingOrder.status !== status) {
          try {
            const profitPayoutService = require('../services/profit-payout.service');
            await profitPayoutService.cancelPendingProfit(storefrontOrder.id, `Order ${status.toLowerCase()}`);
          } catch (cancelError) {
            console.error('[Order] Cancel pending profit failed:', cancelError);
          }
        }
      }

      // MULTI-TENANT: Trigger profit distribution when order completes (regular orders)
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

  // Admin refund order - HARDENED: Serializable transaction with atomic status re-check
  async adminRefundOrder(req, res, next) {
    try {
      const result = await prisma.$transaction(async (tx) => {
        // Re-check paymentStatus INSIDE transaction to prevent double-refund
        const order = await tx.order.findUnique({
          where: { id: req.params.id },
          include: { user: true }
        });

        if (!order) {
          throw new Error('ORDER_NOT_FOUND');
        }

        // Atomic check: if already refunded, abort
        if (order.paymentStatus === 'REFUNDED') {
          throw new Error('ALREADY_REFUNDED');
        }

        // Get user's wallet
        const wallet = await tx.wallet.findUnique({
          where: { userId: order.userId }
        });

        if (!wallet) {
          throw new Error('WALLET_NOT_FOUND');
        }

        // Atomic status transition + refund
        await tx.order.update({
          where: { id: order.id },
          data: { 
            status: 'CANCELLED',
            paymentStatus: 'REFUNDED'
          }
        });

        await tx.wallet.update({
          where: { id: wallet.id },
          data: {
            balance: { increment: order.totalPrice }
          }
        });

        await tx.transaction.create({
          data: {
            walletId: wallet.id,
            type: 'REFUND',
            amount: order.totalPrice,
            status: 'COMPLETED',
            reference: `REF-${order.reference}`,
            description: `Admin refund for order ${order.reference}`
          }
        });

        // Audit log - track WHO performed the refund
        await tx.auditLog.create({
          data: {
            userId: req.user.id,
            action: 'ADMIN_REFUND',
            entityType: 'Order',
            entityId: order.id,
            newValues: {
              refundAmount: order.totalPrice,
              reference: order.reference,
              refundedUserId: order.userId
            }
          }
        });

        return order;
      }, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        timeout: 10000
      });

      res.json({ 
        message: 'Order refunded successfully',
        refundedAmount: result.totalPrice
      });
    } catch (error) {
      if (error.message === 'ORDER_NOT_FOUND') {
        return res.status(404).json({ error: 'Order not found' });
      }
      if (error.message === 'ALREADY_REFUNDED') {
        return res.status(400).json({ error: 'Order has already been refunded' });
      }
      if (error.message === 'WALLET_NOT_FOUND') {
        return res.status(404).json({ error: 'User wallet not found' });
      }
      next(error);
    }
  }
};

module.exports = orderController;
