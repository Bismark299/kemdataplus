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
const { authenticateToken, requireAdmin } = require('../middleware/auth');
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
router.post('/', authenticateToken, async (req, res, next) => {
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
router.get('/', authenticateToken, async (req, res, next) => {
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
router.get('/:id', authenticateToken, async (req, res, next) => {
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
router.post('/:id/cancel', authenticateToken, async (req, res, next) => {
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
 * Get all orders (admin)
 */
router.get('/admin/all', authenticateToken, requireAdmin, async (req, res, next) => {
  try {
    const { PrismaClient } = require('@prisma/client');
    const prisma = new PrismaClient();

    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const skip = (page - 1) * limit;

    const [orders, total] = await Promise.all([
      prisma.orderGroup.findMany({
        include: {
          user: {
            select: { id: true, name: true, email: true, role: true }
          },
          items: {
            include: {
              bundle: { select: { name: true, network: true } }
            },
            orderBy: { itemIndex: 'asc' }
          }
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit
      }),
      prisma.orderGroup.count()
    ]);

    res.json({
      orders: orders.map(order => ({
        id: order.id,
        displayId: order.displayId,
        customer: order.user,
        itemCount: order.itemCount,
        totalAmount: order.totalAmount,
        status: order.summaryStatus,
        createdAt: order.createdAt,
        items: order.items.map(i => ({
          reference: i.reference,
          bundle: i.bundle?.name,
          phone: i.recipientPhone,
          status: i.status
        }))
      })),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit)
      }
    });

  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/admin/order-groups/:id
 * Get order details (admin view)
 */
router.get('/admin/:id', authenticateToken, requireAdmin, async (req, res, next) => {
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
router.post('/admin/:id/process', authenticateToken, requireAdmin, async (req, res, next) => {
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

module.exports = router;
