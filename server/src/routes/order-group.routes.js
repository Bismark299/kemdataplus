/**
 * ============================================================
 * ORDER GROUP ROUTES - Bank-Grade Order API
 * ============================================================
 * 
 * Endpoints for the new batch-aware order system:
 * 
 * POST   /api/order-groups          - Create order (single or batch)
 * GET    /api/order-groups          - Get user's orders (paginated)
 * GET    /api/order-groups/:id      - Get order details
 * POST   /api/order-groups/:id/cancel - Cancel order
 * 
 * Admin endpoints:
 * GET    /api/admin/order-groups          - Get all orders
 * GET    /api/admin/order-groups/:id      - Get order details (admin view)
 * POST   /api/admin/order-groups/:id/process - Manually process order
 * POST   /api/admin/order-groups/:id/release - Release DUPLICATE_HOLD order for processing
 * POST   /api/admin/order-groups/:id/reject  - Reject DUPLICATE_HOLD order and refund
 */

const express = require('express');
const router = express.Router();
const { authenticate, authorize } = require('../middleware/auth');
const orderGroupService = require('../services/order-group.service');
const walletService = require('../services/wallet.service');
const prisma = require('../lib/prisma');

// ============================================================
// CLIENT ROUTES
// ============================================================

/**
 * POST /api/order-groups
 * Create a new order (single or batch)
 * 
 * Body:
 * {
 *   items: [
 *     { bundleId: "uuid", recipientPhone: "0551234567", quantity: 1 },
 *     { bundleId: "uuid", recipientPhone: "0241234567", quantity: 1 }
 *   ],
 *   idempotencyKey: "unique-key-from-client" (optional but recommended)
 * }
 */
router.post('/', authenticate, async (req, res, next) => {
  try {
    const { items, idempotencyKey } = req.body;
    const userId = req.user.id;
    const tenantId = req.user.tenantId;

    // Validate items
    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        error: 'At least one order item is required',
        code: 'INVALID_REQUEST'
      });
    }

    // Validate each item
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (!item.bundleId) {
        return res.status(400).json({
          error: `Item ${i + 1}: bundleId is required`,
          code: 'INVALID_ITEM'
        });
      }
      if (!item.recipientPhone) {
        return res.status(400).json({
          error: `Item ${i + 1}: recipientPhone is required`,
          code: 'INVALID_ITEM'
        });
      }
    }

    // Create order
    const result = await orderGroupService.createOrder({
      userId,
      tenantId,
      items,
      idempotencyKey: idempotencyKey || `${userId}-${Date.now()}`
    });

    if (result.duplicate) {
      return res.status(200).json({
        message: 'Order already exists (duplicate request)',
        duplicate: true,
        order: {
          orderId: result.orderGroup.displayId,
          itemCount: result.orderGroup.itemCount,
          totalAmount: result.orderGroup.totalAmount,
          status: result.orderGroup.summaryStatus
        }
      });
    }

    // Check if order is held for duplicate review - don't auto-process
    if (result.duplicateHold) {
      return res.status(201).json({
        message: result.message,
        duplicateHold: true,
        duplicateInfo: result.duplicateInfo,
        order: {
          orderId: result.orderGroup.displayId,
          itemCount: result.orderGroup.itemCount,
          isBatch: result.orderGroup.itemCount > 1,
          totalAmount: result.orderGroup.totalAmount,
          status: 'DUPLICATE_HOLD',
          items: result.orderGroup.items.map(item => ({
            itemNumber: item.itemIndex,
            reference: item.reference,
            bundle: item.bundleName,
            recipientPhone: item.recipientPhone,
            totalPrice: item.totalPrice
          }))
        }
      });
    }

    // Auto-process order via API inline (not setImmediate) so errors are caught
    let processResult = null;
    try {
      processResult = await orderGroupService.processOrderItems(result.orderGroup.id);
    } catch (err) {
      console.error(`[OrderGroup] Auto-process error:`, err.message);
    }

    res.status(201).json({
      message: result.message,
      order: {
        orderId: result.orderGroup.displayId,
        itemCount: result.orderGroup.itemCount,
        isBatch: result.orderGroup.itemCount > 1,
        totalAmount: result.orderGroup.totalAmount,
        status: processResult?.processed > 0 ? 'PROCESSING' : 'PENDING',
        items: result.orderGroup.items.map(item => ({
          itemNumber: item.itemIndex,
          reference: item.reference,
          bundle: item.bundleName,
          recipientPhone: item.recipientPhone,
          totalPrice: item.totalPrice
        }))
      }
    });

  } catch (error) {
    // Handle specific errors
    if (error.message.startsWith('INSUFFICIENT_BALANCE')) {
      const [, required, available] = error.message.split(':');
      return res.status(400).json({
        error: 'Insufficient wallet balance',
        code: 'INSUFFICIENT_BALANCE',
        required: parseFloat(required),
        available: parseFloat(available)
      });
    }

    if (error.message === 'WALLET_NOT_FOUND') {
      return res.status(400).json({
        error: 'Wallet not found. Please contact support.',
        code: 'WALLET_NOT_FOUND'
      });
    }

    if (error.message === 'WALLET_FROZEN') {
      return res.status(403).json({
        error: 'Your wallet is frozen. Please contact support.',
        code: 'WALLET_FROZEN'
      });
    }

    if (error.message.includes('not found')) {
      return res.status(404).json({
        error: error.message,
        code: 'NOT_FOUND'
      });
    }

    next(error);
  }
});

/**
 * GET /api/order-groups
 * Get user's orders (paginated)
 * 
 * Query params:
 * - page: number (default 1)
 * - limit: number (default 20, max 100)
 */
router.get('/', authenticate, async (req, res, next) => {
  try {
    const userId = req.user.id;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));

    const result = await orderGroupService.getOrdersForClient(userId, { page, limit });

    res.json({
      orders: result.orders,
      pagination: result.pagination
    });

  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/order-groups/last-delivery
 * Get the last 5 completed deliveries across the entire tenant (for live ticker)
 */
router.get('/last-delivery', authenticate, async (req, res, next) => {
  try {
    const tenantId = req.user.tenantId;

    // Find the 5 most recently completed MTN OrderItems in the tenant
    const lastItems = await prisma.orderItem.findMany({
      where: {
        status: 'COMPLETED',
        orderGroup: { tenantId: tenantId || undefined },
        bundle: { network: 'MTN' }
      },
      orderBy: { updatedAt: 'desc' },
      take: 5,
      include: {
        bundle: { select: { name: true, network: true, dataAmount: true } },
        orderGroup: { select: { displayId: true, createdAt: true } }
      }
    });

    if (!lastItems.length) {
      return res.json({ deliveries: [] });
    }

    res.json({
      deliveries: lastItems.map(item => ({
        orderId: item.orderGroup?.displayId || item.reference,
        recipientPhone: item.recipientPhone,
        bundle: item.bundle?.name || 'Unknown',
        network: item.bundle?.network || 'MTN',
        dataAmount: item.bundle?.dataAmount || '',
        deliveredAt: item.updatedAt,
        createdAt: item.orderGroup?.createdAt || item.createdAt
      }))
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/order-groups/:id
 * Get single order details
 */
router.get('/:id', authenticate, async (req, res, next) => {
  try {
    const userId = req.user.id;
    const orderId = req.params.id;

    const order = await orderGroupService.getOrderForClient(orderId, userId);

    if (!order) {
      return res.status(404).json({
        error: 'Order not found',
        code: 'NOT_FOUND'
      });
    }

    res.json({ order });

  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/order-groups/:id/cancel
 * Cancel an order (only if all items are PENDING)
 */
router.post('/:id/cancel', authenticate, async (req, res, next) => {
  try {
    const userId = req.user.id;
    const orderId = req.params.id;

    const result = await orderGroupService.cancelOrder(orderId, userId);

    res.json(result);

  } catch (error) {
    if (error.message.includes('not found')) {
      return res.status(404).json({
        error: error.message,
        code: 'NOT_FOUND'
      });
    }

    if (error.message.includes('Cannot cancel')) {
      return res.status(400).json({
        error: error.message,
        code: 'CANNOT_CANCEL'
      });
    }

    next(error);
  }
});

// ============================================================
// ADMIN ROUTES
// ============================================================

/**
 * GET /api/admin/order-groups
 * Get all orders (admin) - Returns flat list compatible with admin dashboard
 * Combines OrderGroup items with legacy Order table
 */
router.get('/admin/all', authenticate, authorize('ADMIN'), async (req, res, next) => {
  try {
    const limit = Math.max(1, Math.min(parseInt(req.query.limit) || 500, 100000));
    const compact = req.query.compact === 'true';

    // Server-side filters
    const dateParam  = req.query.date   || '';   // YYYY-MM-DD
    const status     = req.query.status || '';
    const network    = req.query.network || '';
    const phone      = req.query.phone  || '';
    const search     = req.query.search || '';   // agent code / name / order no

    // Build date range filter
    const dateWhere = {};
    if (dateParam) {
      const start = new Date(dateParam + 'T00:00:00.000Z');
      const end   = new Date(dateParam + 'T23:59:59.999Z');
      dateWhere.createdAt = { gte: start, lte: end };
    }

    // Build OrderGroup where clause
    const ogWhere = { ...dateWhere };
    if (search) {
      ogWhere.user = {
        OR: [
          { name:      { contains: search, mode: 'insensitive' } },
          { agentCode: { contains: search, mode: 'insensitive' } }
        ]
      };
    }

    // Build legacy Order where clause
    const orderWhere = { ...dateWhere };
    if (status)  orderWhere.status = status;
    if (phone)   orderWhere.recipientPhone = { contains: phone };
    if (network) orderWhere.bundle = { network: { contains: network, mode: 'insensitive' } };
    if (search)  {
      orderWhere.user = {
        OR: [
          { name:      { contains: search, mode: 'insensitive' } },
          { agentCode: { contains: search, mode: 'insensitive' } }
        ]
      };
    }

    console.log(`[OrderGroup] Admin fetching orders (limit: ${limit}, date: ${dateParam || 'all'}, status: ${status || 'all'}, network: ${network || 'all'})`);

    // Fetch both OrderGroups AND legacy Orders
    const [orderGroups, legacyOrders] = await Promise.all([
      prisma.orderGroup.findMany({
        where: ogWhere,
        include: {
          user: {
            select: { id: true, name: true, email: true, phone: true, role: true, agentCode: true }
          },
          items: {
            where: status ? { status } : undefined,
            include: {
              bundle: {
                select: { id: true, name: true, network: true, dataAmount: true }
              }
            },
            orderBy: { itemIndex: 'asc' }
          }
        },
        orderBy: { createdAt: 'desc' },
        take: limit
      }),
      // Fetch legacy orders
      prisma.order.findMany({
        where: orderWhere,
        include: {
          user: {
            select: { id: true, name: true, email: true, phone: true, role: true, agentCode: true }
          },
          bundle: {
            select: { id: true, name: true, network: true, dataAmount: true }
          }
        },
        orderBy: { createdAt: 'desc' },
        take: limit
      })
    ]);
    
    console.log(`[OrderGroup] Fetched ${orderGroups.length} order groups, ${legacyOrders.length} legacy orders`);

    // Flatten OrderGroups into individual order items for dashboard compatibility
    const orders = [];
    
    // Track displayIds from OrderGroups to avoid duplicates
    const orderGroupDisplayIds = new Set();
    
    // Add OrderGroup items
    orderGroups.forEach(group => {
      if (group.displayId) {
        orderGroupDisplayIds.add(group.displayId);
      }
      group.items.forEach(item => {
        orders.push({
          // Use item ID as primary ID for dashboard
          id: item.id,
          orderGroupId: group.id,
          displayId: group.displayId,
          reference: item.reference,
          
          // Customer info
          userId: group.userId,
          user: group.user,
          customerName: group.user?.name || 'N/A',
          customerEmail: group.user?.email || 'N/A',
          customerPhone: group.user?.phone || 'N/A',
          
          // Bundle info (compatible with old format)
          bundleId: item.bundleId,
          bundle: item.bundle ? {
            id: item.bundle.id,
            name: item.bundle.name,
            network: item.bundle.network,
            dataAmount: item.bundle.dataAmount
          } : null,
          network: item.bundle?.network || 'MTN',
          dataAmount: item.bundle?.dataAmount || '1GB',
          
          // Order details
          recipientPhone: item.recipientPhone,
          phone: item.recipientPhone,
          quantity: 1,
          totalPrice: item.totalPrice || item.unitPrice || 0,
          total: item.totalPrice || item.unitPrice || 0,
          status: item.status,
          
          // Timestamps
          createdAt: group.createdAt,
          updatedAt: group.updatedAt,
          
          // Additional fields for display
          isBatchItem: group.itemCount > 1,
          batchSize: group.itemCount,
          failureReason: item.failureReason,
          externalReference: item.externalReference,
          isLegacy: false
        });
      });
    });

    // Add legacy orders (skip if already in OrderGroup to avoid duplicates)
    legacyOrders.forEach(order => {
      // Skip if this order's reference matches an OrderGroup displayId (duplicate)
      if (order.reference && orderGroupDisplayIds.has(order.reference)) {
        return; // Skip duplicate
      }
      
      orders.push({
        id: order.id,
        orderGroupId: null,
        displayId: order.reference,
        reference: order.reference,
        
        // Customer info
        userId: order.userId,
        user: order.user,
        customerName: order.user?.name || 'N/A',
        customerEmail: order.user?.email || 'N/A',
        customerPhone: order.user?.phone || 'N/A',
        
        // Bundle info
        bundleId: order.bundleId,
        bundle: order.bundle ? {
          id: order.bundle.id,
          name: order.bundle.name,
          network: order.bundle.network,
          dataAmount: order.bundle.dataAmount
        } : null,
        network: order.bundle?.network || 'MTN',
        dataAmount: order.bundle?.dataAmount || '1GB',
        
        // Order details
        recipientPhone: order.recipientPhone,
        phone: order.recipientPhone,
        quantity: order.quantity || 1,
        totalPrice: order.totalPrice || 0,
        total: order.totalPrice || 0,
        status: order.status,
        
        // Timestamps
        createdAt: order.createdAt,
        updatedAt: order.updatedAt,
        
        // Additional fields
        isBatchItem: false,
        batchSize: 1,
        failureReason: order.failureReason,
        externalReference: order.externalReference,
        isLegacy: true
      });
    });

    // Sort all orders by date (newest first) and apply limit
    orders.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    const limitedOrders = orders.slice(0, limit);

    res.json({
      orders: limitedOrders,
      total: limitedOrders.length,
      filtered: !!(dateParam || status || network || phone || search)
    });

  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/admin/order-groups/:id
 * Get order details (admin view)
 */
router.get('/admin/:id', authenticate, authorize('ADMIN'), async (req, res, next) => {
  try {
    const orderId = req.params.id;
    const order = await orderGroupService.getOrderForAdmin(orderId);

    if (!order) {
      return res.status(404).json({
        error: 'Order not found',
        code: 'NOT_FOUND'
      });
    }

    res.json({ order });

  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/admin/order-groups/:id/process
 * Manually process order items (admin)
 */
router.post('/admin/:id/process', authenticate, authorize('ADMIN'), async (req, res, next) => {
  try {
    const orderId = req.params.id;

    // Get order group
    const orderGroup = await prisma.orderGroup.findFirst({
      where: {
        OR: [
          { id: orderId },
          { displayId: orderId }
        ]
      }
    });

    if (!orderGroup) {
      return res.status(404).json({
        error: 'Order not found',
        code: 'NOT_FOUND'
      });
    }

    const result = await orderGroupService.processOrderItems(orderGroup.id);

    res.json({
      message: `Processed ${result.processed} items`,
      ...result
    });

  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/admin/order-groups/:id/release
 * Release a DUPLICATE_HOLD order for processing (admin)
 * Changes status from DUPLICATE_HOLD to PENDING and triggers processing
 */
router.post('/admin/:id/release', authenticate, authorize('ADMIN'), async (req, res, next) => {
  try {
    const orderId = req.params.id;

    // Get order group
    const orderGroup = await prisma.orderGroup.findFirst({
      where: {
        OR: [
          { id: orderId },
          { displayId: orderId }
        ]
      },
      include: {
        items: true
      }
    });

    if (!orderGroup) {
      return res.status(404).json({
        error: 'Order not found',
        code: 'NOT_FOUND'
      });
    }

    // Check if order is in DUPLICATE_HOLD status
    if (orderGroup.status !== 'DUPLICATE_HOLD') {
      return res.status(400).json({
        error: `Order is not on hold. Current status: ${orderGroup.status}`,
        code: 'INVALID_STATUS'
      });
    }

    // Update order group status to PENDING
    await prisma.orderGroup.update({
      where: { id: orderGroup.id },
      data: {
        status: 'PENDING',
        summaryStatus: 'PENDING'
      }
    });

    // Update all items to PENDING
    await prisma.orderItem.updateMany({
      where: { orderGroupId: orderGroup.id },
      data: { status: 'PENDING' }
    });

    console.log(`[Admin] Released DUPLICATE_HOLD order ${orderGroup.displayId} for processing`);

    // Create audit log
    await prisma.auditLog.create({
      data: {
        userId: req.user.id,
        tenantId: orderGroup.tenantId,
        action: 'ORDER_DUPLICATE_RELEASE',
        entityType: 'OrderGroup',
        entityId: orderGroup.id,
        newValues: {
          displayId: orderGroup.displayId,
          releasedBy: req.user.email,
          previousStatus: 'DUPLICATE_HOLD',
          newStatus: 'PENDING'
        }
      }
    });

    // Now process the order
    const result = await orderGroupService.processOrderItems(orderGroup.id);

    res.json({
      message: `Order ${orderGroup.displayId} released and processing started`,
      orderId: orderGroup.displayId,
      processed: result.processed,
      success: result.success,
      failed: result.failed
    });

  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/admin/order-groups/:id/reject
 * Reject a DUPLICATE_HOLD order and refund (admin)
 * Changes status to CANCELLED and refunds wallet
 */
router.post('/admin/:id/reject', authenticate, authorize('ADMIN'), async (req, res, next) => {
  try {
    const orderId = req.params.id;
    const { reason } = req.body;

    // Get order group
    const orderGroup = await prisma.orderGroup.findFirst({
      where: {
        OR: [
          { id: orderId },
          { displayId: orderId }
        ]
      },
      include: {
        items: true
      }
    });

    if (!orderGroup) {
      return res.status(404).json({
        error: 'Order not found',
        code: 'NOT_FOUND'
      });
    }

    // Check if order is in DUPLICATE_HOLD status
    if (orderGroup.status !== 'DUPLICATE_HOLD') {
      return res.status(400).json({
        error: `Order is not on hold. Current status: ${orderGroup.status}`,
        code: 'INVALID_STATUS'
      });
    }

    // Refund wallet via walletService (writes to walletLedger, idempotent, always COMPLETED)
    let refunded = false;
    if (orderGroup.walletDeducted) {
      try {
        await walletService.creditWallet(
          orderGroup.userId,
          orderGroup.totalAmount,
          `Duplicate order refund - ${orderGroup.displayId}${reason ? ` (Reason: ${reason})` : ''}`,
          `REFUND-${orderGroup.displayId}`,
          { entryType: 'REFUND', orderId: orderGroup.id }
        );
        refunded = true;
        console.log(`[Admin] Refunded ${orderGroup.totalAmount} for rejected duplicate order ${orderGroup.displayId}`);
      } catch (refundErr) {
        if (refundErr.message === 'Duplicate transaction reference') {
          refunded = true; // Already refunded on a prior call
          console.log(`[Admin] Refund already exists for order ${orderGroup.displayId}`);
        } else {
          console.error(`[Admin] Failed to refund order ${orderGroup.displayId}:`, refundErr.message);
        }
      }
    }

    // Update order group status to CANCELLED
    await prisma.orderGroup.update({
      where: { id: orderGroup.id },
      data: {
        status: 'CANCELLED',
        summaryStatus: 'CANCELLED'
      }
    });

    // Update all items to CANCELLED
    await prisma.orderItem.updateMany({
      where: { orderGroupId: orderGroup.id },
      data: { status: 'CANCELLED' }
    });

    console.log(`[Admin] Rejected DUPLICATE_HOLD order ${orderGroup.displayId}`);

    // Create audit log
    await prisma.auditLog.create({
      data: {
        userId: req.user.id,
        tenantId: orderGroup.tenantId,
        action: 'ORDER_DUPLICATE_REJECT',
        entityType: 'OrderGroup',
        entityId: orderGroup.id,
        newValues: {
          displayId: orderGroup.displayId,
          rejectedBy: req.user.email,
          reason: reason || 'Duplicate order',
          refundAmount: refunded ? orderGroup.totalAmount : 0
        }
      }
    });

    res.json({
      message: `Order ${orderGroup.displayId} rejected and ${refunded ? 'refunded' : 'cancelled'}`,
      orderId: orderGroup.displayId,
      refunded: refunded,
      refundAmount: refunded ? orderGroup.totalAmount : 0
    });

  } catch (error) {
    next(error);
  }
});

/**
 * PUT /api/order-groups/admin/item/:itemId/status
 * Update individual order item status (admin)
 * Supports both OrderItem and legacy Order tables
 */
router.put('/admin/item/:itemId/status', authenticate, authorize('ADMIN'), async (req, res, next) => {
  try {
    const { itemId } = req.params;
    const { status } = req.body;
    
    // Validate status
    const validStatuses = ['PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({
        error: `Invalid status. Must be one of: ${validStatuses.join(', ')}`,
        code: 'INVALID_STATUS'
      });
    }
    
    // Try to update OrderItem first
    try {
      const item = await prisma.orderItem.update({
        where: { id: itemId },
        data: { 
          status,
          processedAt: status === 'COMPLETED' ? new Date() : undefined
        },
        include: {
          orderGroup: { select: { displayId: true } }
        }
      });
      
      // SYNC: Update related Order and StorefrontOrder
      // OrderItem reference is like ORD-000013-01, Order reference is ORD-000013
      const orderRef = item.reference?.replace(/-\d+$/, ''); // Remove trailing -01, -02 etc
      if (orderRef) {
        const order = await prisma.order.findFirst({ where: { reference: orderRef } });
        if (order) {
          // Update Order status
          await prisma.order.update({
            where: { id: order.id },
            data: { 
              status,
              processedAt: status === 'COMPLETED' ? new Date() : undefined
            }
          });
          console.log(`[Admin] Synced Order ${order.reference} to ${status}`);
          
          // Update StorefrontOrder if exists
          if (order.storefrontOrderId) {
            await prisma.storefrontOrder.update({
              where: { id: order.storefrontOrderId },
              data: { status }
            });
            console.log(`[Admin] Synced StorefrontOrder ${order.storefrontOrderId} to ${status}`);
            
            // Credit profit when manually completing
            if (status === 'COMPLETED') {
              try {
                const financialOrderService = require('../services/financial-order.service');
                const profitResult = await financialOrderService.creditAgentProfit(order.storefrontOrderId);
                console.log(`[Admin] Status update profit credit:`, profitResult);
              } catch (profitErr) {
                console.error(`[Admin] Status update profit credit failed:`, profitErr.message);
              }
            }
          }
        }
      }
      
      console.log(`[Admin] Updated OrderItem ${itemId} status to ${status}`);
      
      return res.json({
        success: true,
        message: `Item status updated to ${status}`,
        item: {
          id: item.id,
          status: item.status,
          displayId: item.orderGroup.displayId
        }
      });
    } catch (itemError) {
      // If OrderItem not found, try legacy Order table
      if (itemError.code === 'P2025') {
        try {
          const order = await prisma.order.update({
            where: { id: itemId },
            data: { 
              status,
              processedAt: status === 'COMPLETED' ? new Date() : undefined
            }
          });
          
          console.log(`[Admin] Updated legacy Order ${itemId} status to ${status}`);
          
          return res.json({
            success: true,
            message: `Order status updated to ${status}`,
            item: {
              id: order.id,
              status: order.status,
              displayId: order.displayId || order.id.substring(0, 8).toUpperCase()
            }
          });
        } catch (orderError) {
          if (orderError.code === 'P2025') {
            return res.status(404).json({
              error: 'Order not found in either OrderItem or Order table',
              code: 'NOT_FOUND'
            });
          }
          throw orderError;
        }
      }
      throw itemError;
    }
    
  } catch (error) {
    console.error('[Admin] Status update error:', error);
    next(error);
  }
});

/**
 * POST /api/order-groups/admin/item/:itemId/complete
 * Complete individual order item (admin)
 * Supports both new OrderItem (from OrderGroup) and legacy Order records
 */
router.post('/admin/item/:itemId/complete', authenticate, authorize('ADMIN'), async (req, res, next) => {
  try {
    const { itemId } = req.params;
    
    // Try to find as OrderItem first (new system)
    let item = await prisma.orderItem.findUnique({
      where: { id: itemId },
      include: {
        orderGroup: {
          include: { items: true }
        }
      }
    });
    
    let isLegacyOrder = false;
    let legacyOrder = null;
    
    // If not found as OrderItem, try legacy Order table
    if (!item) {
      legacyOrder = await prisma.order.findUnique({
        where: { id: itemId }
      });
      
      if (legacyOrder) {
        isLegacyOrder = true;
      }
    }
    
    if (!item && !legacyOrder) {
      return res.status(404).json({
        error: 'Order item not found',
        code: 'NOT_FOUND'
      });
    }
    
    // Handle LEGACY ORDER completion
    if (isLegacyOrder) {
      const prevStatus = legacyOrder.status;
      await prisma.order.update({
        where: { id: itemId },
        data: { 
          status: 'COMPLETED',
          processedAt: new Date()
        }
      });
      
      // Credit storefront profit if completing for the first time
      if (prevStatus !== 'COMPLETED') {
        try {
          const storefrontOrder = await prisma.storefrontOrder.findFirst({ where: { orderId: itemId } });
          if (storefrontOrder) {
            await prisma.storefrontOrder.update({ where: { id: storefrontOrder.id }, data: { status: 'COMPLETED' } });
            const financialOrderService = require('../services/financial-order.service');
            const profitResult = await financialOrderService.creditAgentProfit(storefrontOrder.id);
            console.log(`[Admin] Legacy order profit credit:`, profitResult);
          }
        } catch (profitErr) {
          console.error(`[Admin] Legacy order profit credit failed:`, profitErr.message);
        }
      }
      
      console.log(`[Admin] Completed legacy order ${itemId}`);
      
      return res.json({
        success: true,
        message: 'Order marked as completed'
      });
    }
    
    // Handle NEW OrderItem completion
    await prisma.$transaction(async (tx) => {
      // Update item status
      await tx.orderItem.update({
        where: { id: itemId },
        data: { 
          status: 'COMPLETED',
          processedAt: new Date()
        }
      });
      
      // Update group summary status
      const allItems = item.orderGroup.items;
      const updatedStatuses = allItems.map(i => i.id === itemId ? 'COMPLETED' : i.status);
      
      let newStatus = 'PENDING';
      if (updatedStatuses.every(s => s === 'COMPLETED')) newStatus = 'COMPLETED';
      else if (updatedStatuses.some(s => s === 'COMPLETED' || s === 'PROCESSING')) newStatus = 'PROCESSING';
      else if (updatedStatuses.every(s => s === 'FAILED')) newStatus = 'FAILED';
      else if (updatedStatuses.every(s => s === 'CANCELLED')) newStatus = 'CANCELLED';
      
      await tx.orderGroup.update({
        where: { id: item.orderGroupId },
        data: { 
          summaryStatus: newStatus,
          status: newStatus
        }
      });
    });
    
    console.log(`[Admin] Completed item ${itemId}`);
    
    // Credit storefront profit for the completed item
    try {
      const orderRef = item.reference?.replace(/-\d+$/, '');
      if (orderRef) {
        const order = await prisma.order.findFirst({ where: { reference: orderRef } });
        if (order?.storefrontOrderId) {
          await prisma.storefrontOrder.update({ where: { id: order.storefrontOrderId }, data: { status: 'COMPLETED' } });
          const financialOrderService = require('../services/financial-order.service');
          const profitResult = await financialOrderService.creditAgentProfit(order.storefrontOrderId);
          console.log(`[Admin] Item complete profit credit:`, profitResult);
        }
      }
    } catch (profitErr) {
      console.error(`[Admin] Item complete profit credit failed:`, profitErr.message);
    }
    
    res.json({
      success: true,
      message: 'Order item marked as completed'
    });
    
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/order-groups/admin/item/:itemId/cancel
 * Cancel individual order item and refund (admin)
 * Supports both new OrderItem (from OrderGroup) and legacy Order records
 */
router.post('/admin/item/:itemId/cancel', authenticate, authorize('ADMIN'), async (req, res, next) => {
  try {
    const { itemId } = req.params;
    
    // Try to find as OrderItem first (new system)
    let item = await prisma.orderItem.findUnique({
      where: { id: itemId },
      include: {
        orderGroup: {
          include: { 
            user: true,
            items: true // Get all items to check group status
          }
        }
      }
    });
    
    let isLegacyOrder = false;
    let legacyOrder = null;
    
    // If not found as OrderItem, try legacy Order table
    if (!item) {
      legacyOrder = await prisma.order.findUnique({
        where: { id: itemId },
        include: { user: true }
      });
      
      if (legacyOrder) {
        isLegacyOrder = true;
      }
    }
    
    if (!item && !legacyOrder) {
      return res.status(404).json({
        error: 'Order item not found',
        code: 'NOT_FOUND'
      });
    }
    
    // Handle LEGACY ORDER cancellation
    if (isLegacyOrder) {
      if (legacyOrder.status === 'CANCELLED') {
        return res.status(400).json({
          error: 'Order already cancelled',
          code: 'ALREADY_CANCELLED'
        });
      }
      
      if (legacyOrder.status === 'COMPLETED') {
        return res.status(400).json({
          error: 'Cannot cancel completed order',
          code: 'CANNOT_CANCEL_COMPLETED'
        });
      }
      
      const refundAmount = legacyOrder.totalPrice || legacyOrder.unitPrice || 0;
      
      // Cancel the order atomically
      await prisma.order.update({
        where: { id: itemId },
        data: { status: 'CANCELLED' }
      });

      // Refund to wallet via walletService (writes to walletLedger, idempotent)
      if (refundAmount > 0) {
        try {
          await walletService.creditWallet(
            legacyOrder.userId,
            refundAmount,
            `Refund for cancelled order ${legacyOrder.reference}`,
            `REFUND-${legacyOrder.reference}`,
            { entryType: 'REFUND' }
          );
        } catch (refundErr) {
          if (refundErr.message !== 'Duplicate transaction reference') {
            console.error(`[Admin] Refund failed for legacy order ${legacyOrder.reference}:`, refundErr.message);
          }
        }
      }
      
      console.log(`[Admin] Cancelled legacy order ${itemId}, refunded ${refundAmount}`);
      
      return res.json({
        success: true,
        message: `Order cancelled and GHS ${refundAmount.toFixed(2)} refunded`,
        refundAmount
      });
    }
    
    // Handle NEW OrderItem cancellation
    if (item.status === 'CANCELLED') {
      return res.status(400).json({
        error: 'Item already cancelled',
        code: 'ALREADY_CANCELLED'
      });
    }
    
    if (item.status === 'COMPLETED') {
      return res.status(400).json({
        error: 'Cannot cancel completed item',
        code: 'CANNOT_CANCEL_COMPLETED'
      });
    }
    
    const refundAmount = item.totalPrice || item.unitPrice || 0;
    
    // Transaction: Update item + update group status + refund wallet
    await prisma.$transaction(async (tx) => {
      // Update item status
      await tx.orderItem.update({
        where: { id: itemId },
        data: { status: 'CANCELLED' }
      });
      
      // Check if ALL items in the group are now cancelled - update group status
      const allItems = item.orderGroup.items;
      const otherItems = allItems.filter(i => i.id !== itemId);
      const allOthersCancelled = otherItems.every(i => i.status === 'CANCELLED');
      
      if (allOthersCancelled || allItems.length === 1) {
        // All items cancelled, update group status
        await tx.orderGroup.update({
          where: { id: item.orderGroupId },
          data: { 
            status: 'CANCELLED',
            summaryStatus: 'CANCELLED'
          }
        });
      } else {
        // Calculate new summary status
        const remainingStatuses = otherItems.map(i => i.status);
        let newSummary = 'PENDING';
        if (remainingStatuses.every(s => s === 'COMPLETED')) newSummary = 'COMPLETED';
        else if (remainingStatuses.some(s => s === 'COMPLETED' || s === 'PROCESSING')) newSummary = 'PROCESSING';
        else if (remainingStatuses.every(s => s === 'CANCELLED' || s === 'FAILED')) newSummary = 'CANCELLED';
        
        await tx.orderGroup.update({
          where: { id: item.orderGroupId },
          data: { summaryStatus: newSummary }
        });
      }
      
      // Wallet credit is handled after the transaction via walletService
    });

    // Refund to wallet via walletService (writes to walletLedger, idempotent, always COMPLETED)
    if (refundAmount > 0) {
      try {
        await walletService.creditWallet(
          item.orderGroup.userId,
          refundAmount,
          `Refund for cancelled item ${item.reference}`,
          `REFUND-${item.reference}`,
          { entryType: 'REFUND', orderId: item.orderGroupId }
        );
      } catch (refundErr) {
        if (refundErr.message !== 'Duplicate transaction reference') {
          console.error(`[Admin] Refund failed for item ${item.reference}:`, refundErr.message);
        }
      }
    }
    
    console.log(`[Admin] Cancelled item ${itemId}, refunded ${refundAmount}`);
    
    res.json({
      success: true,
      message: `Item cancelled and GHS ${refundAmount.toFixed(2)} refunded`,
      refundAmount
    });
    
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/order-groups/admin/complete-all-processing
 * Complete ALL orders with PROCESSING status (admin)
 * Works with both OrderItem (new system) and legacy Order records
 * Accepts optional date filter to only complete orders from a specific date
 */
router.post('/admin/complete-all-processing', authenticate, authorize('ADMIN'), async (req, res, next) => {
  try {
    const { date } = req.body; // Optional date filter (YYYY-MM-DD format)
    
    // Build date filter condition
    let dateCondition = {};
    if (date) {
      const startOfDay = new Date(date + 'T00:00:00.000Z');
      const endOfDay = new Date(date + 'T23:59:59.999Z');
      dateCondition = {
        createdAt: {
          gte: startOfDay,
          lte: endOfDay
        }
      };
      console.log(`[Admin] Completing PROCESSING orders for date: ${date}`);
    }
    
    // Update all PROCESSING OrderItems to COMPLETED (with optional date filter)
    const orderItemsResult = await prisma.orderItem.updateMany({
      where: { 
        status: 'PROCESSING',
        ...dateCondition
      },
      data: { 
        status: 'COMPLETED',
        processedAt: new Date()
      }
    });
    
    // Update all PROCESSING legacy Orders to COMPLETED (with optional date filter)
    const legacyOrdersResult = await prisma.order.updateMany({
      where: { 
        status: 'PROCESSING',
        ...dateCondition
      },
      data: { 
        status: 'COMPLETED',
        processedAt: new Date()
      }
    });
    
    // Update OrderGroup summaryStatus for affected groups
    const processingGroups = await prisma.orderGroup.findMany({
      where: { 
        summaryStatus: 'PROCESSING',
        ...dateCondition
      },
      include: { items: true }
    });
    
    for (const group of processingGroups) {
      const statuses = group.items.map(i => i.status);
      let newStatus = 'PENDING';
      if (statuses.every(s => s === 'COMPLETED')) newStatus = 'COMPLETED';
      else if (statuses.every(s => s === 'FAILED')) newStatus = 'FAILED';
      else if (statuses.every(s => s === 'CANCELLED')) newStatus = 'CANCELLED';
      else if (statuses.some(s => s === 'COMPLETED' || s === 'PROCESSING')) newStatus = 'PROCESSING';
      
      await prisma.orderGroup.update({
        where: { id: group.id },
        data: { 
          summaryStatus: newStatus,
          status: newStatus
        }
      });
    }
    
    const totalCompleted = orderItemsResult.count + legacyOrdersResult.count;
    
    // Credit profits for all newly completed storefront orders
    let profitsCredited = 0;
    try {
      const financialOrderService = require('../services/financial-order.service');
      // Find storefront orders linked to the just-completed orders
      const completedOrders = await prisma.order.findMany({
        where: {
          status: 'COMPLETED',
          storefrontOrderId: { not: null },
          ...dateCondition
        },
        select: { storefrontOrderId: true }
      });
      for (const order of completedOrders) {
        try {
          // Sync storefront order status
          await prisma.storefrontOrder.update({
            where: { id: order.storefrontOrderId },
            data: { status: 'COMPLETED' }
          });
          const result = await financialOrderService.creditAgentProfit(order.storefrontOrderId);
          if (result.credited) profitsCredited++;
        } catch (e) {
          // creditAgentProfit handles duplicates, just log
          console.error(`[Admin] Bulk profit credit failed for ${order.storefrontOrderId}:`, e.message);
        }
      }
      console.log(`[Admin] Credited profits for ${profitsCredited} orders`);
    } catch (profitErr) {
      console.error(`[Admin] Bulk profit credit error:`, profitErr.message);
    }
    
    console.log(`[Admin] Completed ${totalCompleted} processing orders (${orderItemsResult.count} items, ${legacyOrdersResult.count} legacy)${date ? ` for ${date}` : ''}`);
    
    res.json({
      success: true,
      message: `${totalCompleted} order(s) marked as completed${date ? ` for ${date}` : ''}`,
      profitsCredited,
      count: totalCompleted,
      orderItems: orderItemsResult.count,
      legacyOrders: legacyOrdersResult.count,
      dateFilter: date || null
    });
    
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/order-groups/admin/item/:itemId/retry
 * Retry a FAILED order item that was never received by the provider (MCBIS 404).
 * Resets the item to PENDING and re-queues it for sending.
 */
router.post('/admin/item/:itemId/retry', authenticate, authorize('ADMIN'), async (req, res, next) => {
  try {
    const { itemId } = req.params;
    const orderGroupService = require('../services/order-group.service');

    const item = await prisma.orderItem.findUnique({
      where: { id: itemId },
      include: { orderGroup: true }
    });

    if (!item) {
      return res.status(404).json({ error: 'Order item not found' });
    }

    if (item.status !== 'FAILED') {
      return res.status(400).json({ error: 'Only FAILED orders can be retried' });
    }

    // Safety: only allow retry if the item was never confirmed received by provider.
    // externalReference is only set on success, so FAILED items with no externalReference
    // are safe to retry (order never made it to the provider).
    const safeToRetry = !item.externalReference;

    if (!safeToRetry) {
      return res.status(400).json({
        error: 'This order cannot be retried — it was confirmed received by the provider. Cancel and refund instead.',
        failureReason: item.failureReason
      });
    }

    // Reset item to PENDING so processOrderItems will pick it up
    await prisma.orderItem.update({
      where: { id: itemId },
      data: {
        status: 'PENDING',
        failureReason: null,
        apiSentAt: null,
        externalReference: null
      }
    });

    // Also reset the parent group status if it was FAILED
    if (item.orderGroup && item.orderGroup.status === 'FAILED') {
      await prisma.orderGroup.update({
        where: { id: item.orderGroup.id },
        data: { status: 'PENDING' }
      });
    }

    // Trigger processing immediately
    try {
      await orderGroupService.processOrderItems(item.orderGroup.id);
    } catch (processErr) {
      console.error('[RetryItem] processOrderItems error:', processErr.message);
      // Non-fatal — auto-sync will pick it up within 1 minute
    }

    res.json({ success: true, message: 'Order re-queued for sending' });

  } catch (error) {
    next(error);
  }
});

module.exports = router;
