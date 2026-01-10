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
 */

const express = require('express');
const router = express.Router();
const { authenticate, authorize } = require('../middleware/auth');
const orderGroupService = require('../services/order-group.service');

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

    // Auto-process order via API if enabled
    // This happens in the background - don't wait for it
    setImmediate(async () => {
      try {
        await orderGroupService.processOrderItems(result.orderGroup.id);
      } catch (err) {
        console.error(`[OrderGroup] Auto-process error:`, err.message);
      }
    });

    res.status(201).json({
      message: result.message,
      order: {
        orderId: result.orderGroup.displayId,
        itemCount: result.orderGroup.itemCount,
        isBatch: result.orderGroup.itemCount > 1,
        totalAmount: result.orderGroup.totalAmount,
        status: 'PENDING',
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
    const { PrismaClient } = require('@prisma/client');
    const prisma = new PrismaClient();

    const limit = Math.min(1000, Math.max(1, parseInt(req.query.limit) || 200));
    const compact = req.query.compact === 'true';

    // Fetch both OrderGroups AND legacy Orders
    const [orderGroups, legacyOrders] = await Promise.all([
      prisma.orderGroup.findMany({
        include: {
          user: {
            select: { id: true, name: true, email: true, phone: true, role: true }
          },
          items: {
            include: {
              bundle: {
                select: { id: true, name: true, network: true, dataAmount: true }
              }
            },
            orderBy: { itemIndex: 'asc' }
          }
        },
        orderBy: { createdAt: 'desc' }
      }),
      prisma.order.findMany({
        include: {
          user: {
            select: { id: true, name: true, email: true, phone: true, role: true }
          },
          bundle: {
            select: { id: true, name: true, network: true, dataAmount: true }
          }
        },
        orderBy: { createdAt: 'desc' }
      })
    ]);

    // Flatten OrderGroups into individual order items for dashboard compatibility
    const orders = [];
    
    // Add OrderGroup items
    orderGroups.forEach(group => {
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

    // Add legacy orders
    legacyOrders.forEach(order => {
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
      total: limitedOrders.length
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
    const { PrismaClient } = require('@prisma/client');
    const prisma = new PrismaClient();
    
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
 * PUT /api/order-groups/admin/item/:itemId/status
 * Update individual order item status (admin)
 */
router.put('/admin/item/:itemId/status', authenticate, authorize('ADMIN'), async (req, res, next) => {
  try {
    const { itemId } = req.params;
    const { status } = req.body;
    
    const { PrismaClient } = require('@prisma/client');
    const prisma = new PrismaClient();
    
    // Validate status
    const validStatuses = ['PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({
        error: `Invalid status. Must be one of: ${validStatuses.join(', ')}`,
        code: 'INVALID_STATUS'
      });
    }
    
    // Update item status
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
    
    console.log(`[Admin] Updated item ${itemId} status to ${status}`);
    
    res.json({
      success: true,
      message: `Item status updated to ${status}`,
      item: {
        id: item.id,
        status: item.status,
        displayId: item.orderGroup.displayId
      }
    });
    
  } catch (error) {
    if (error.code === 'P2025') {
      return res.status(404).json({
        error: 'Order item not found',
        code: 'NOT_FOUND'
      });
    }
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
    
    const { PrismaClient } = require('@prisma/client');
    const prisma = new PrismaClient();
    
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
      await prisma.order.update({
        where: { id: itemId },
        data: { 
          status: 'COMPLETED',
          processedAt: new Date()
        }
      });
      
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
    
    const { PrismaClient } = require('@prisma/client');
    const prisma = new PrismaClient();
    
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
      
      await prisma.$transaction(async (tx) => {
        // Update legacy order status
        await tx.order.update({
          where: { id: itemId },
          data: { status: 'CANCELLED' }
        });
        
        // Refund to wallet
        if (refundAmount > 0) {
          const wallet = await tx.wallet.findUnique({ where: { userId: legacyOrder.userId } });
          
          if (wallet) {
            await tx.wallet.update({
              where: { userId: legacyOrder.userId },
              data: { balance: { increment: refundAmount } }
            });
            
            await tx.transaction.create({
              data: {
                walletId: wallet.id,
                amount: refundAmount,
                type: 'REFUND',
                description: `Refund for cancelled order ${legacyOrder.reference}`,
                reference: `REFUND-${legacyOrder.reference}-${Date.now()}`
              }
            });
          }
        }
      });
      
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
      
      // Refund to wallet
      if (refundAmount > 0) {
        const wallet = await tx.wallet.findUnique({ where: { userId: item.orderGroup.userId } });
        
        if (wallet) {
          await tx.wallet.update({
            where: { userId: item.orderGroup.userId },
            data: { balance: { increment: refundAmount } }
          });
          
          await tx.transaction.create({
            data: {
              walletId: wallet.id,
              amount: refundAmount,
              type: 'REFUND',
              description: `Refund for cancelled item ${item.reference}`,
              reference: `REFUND-${item.reference}-${Date.now()}`
            }
          });
        }
      }
    });
    
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
 */
router.post('/admin/complete-all-processing', authenticate, authorize('ADMIN'), async (req, res, next) => {
  try {
    const { PrismaClient } = require('@prisma/client');
    const prisma = new PrismaClient();
    
    // Update all PROCESSING OrderItems to COMPLETED
    const orderItemsResult = await prisma.orderItem.updateMany({
      where: { status: 'PROCESSING' },
      data: { 
        status: 'COMPLETED',
        processedAt: new Date()
      }
    });
    
    // Update all PROCESSING legacy Orders to COMPLETED
    const legacyOrdersResult = await prisma.order.updateMany({
      where: { status: 'PROCESSING' },
      data: { 
        status: 'COMPLETED',
        processedAt: new Date()
      }
    });
    
    // Update OrderGroup summaryStatus for affected groups
    const processingGroups = await prisma.orderGroup.findMany({
      where: { summaryStatus: 'PROCESSING' },
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
    
    console.log(`[Admin] Completed ${totalCompleted} processing orders (${orderItemsResult.count} items, ${legacyOrdersResult.count} legacy)`);
    
    res.json({
      success: true,
      message: `${totalCompleted} order(s) marked as completed`,
      count: totalCompleted,
      orderItems: orderItemsResult.count,
      legacyOrders: legacyOrdersResult.count
    });
    
  } catch (error) {
    next(error);
  }
});

module.exports = router;
