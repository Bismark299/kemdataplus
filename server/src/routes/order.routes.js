const express = require('express');
const router = express.Router();
const orderController = require('../controllers/order.controller');
const { authenticate, authorize } = require('../middleware/auth');
const { createOrderValidation, paginationValidation } = require('../middleware/validators');

// GET /api/orders - Get user's orders
router.get('/', authenticate, paginationValidation, orderController.getOrders);

// GET /api/orders/:id - Get order by ID
router.get('/:id', authenticate, orderController.getOrderById);

// POST /api/orders - Create new order
router.post('/', authenticate, createOrderValidation, orderController.createOrder);

// POST /api/orders/:id/cancel - Cancel order
router.post('/:id/cancel', authenticate, orderController.cancelOrder);

// GET /api/orders/all - Get all orders (admin)
router.get('/admin/all', authenticate, authorize('ADMIN'), paginationValidation, orderController.getAllOrders);

// PUT /api/orders/:id/status - Update order status (admin) - ONLY order status, not payment
router.put('/:id/status', authenticate, authorize('ADMIN'), orderController.updateOrderStatus);

// POST /api/orders/:id/refund - Admin refund order (updates paymentStatus to REFUNDED)
router.post('/:id/refund', authenticate, authorize('ADMIN'), orderController.adminRefundOrder);

module.exports = router;
