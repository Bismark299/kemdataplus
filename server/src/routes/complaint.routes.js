/**
 * COMPLAINT ROUTES
 * =================
 * API endpoints for support ticket/complaint system
 * 
 * Agent endpoints: /api/complaints
 * Admin endpoints: /api/admin/complaints
 */

const express = require('express');
const router = express.Router();
const { authenticate, authorize } = require('../middleware/auth');
const complaintService = require('../services/complaint.service');
const prisma = require('../lib/prisma');

// ============================================
// AGENT ENDPOINTS
// ============================================

/**
 * GET /api/complaints
 * Get all complaints for logged-in user
 */
router.get('/', authenticate, async (req, res, next) => {
  try {
    const { status, type } = req.query;
    const complaints = await complaintService.getUserComplaints(req.user.id, { status, type });
    res.json(complaints);
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/complaints/orders
 * Get recent orders for complaint form
 */
router.get('/orders', authenticate, async (req, res, next) => {
  try {
    const orders = await complaintService.getRecentOrdersForComplaint(req.user.id);
    res.json(orders);
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/complaints/:id
 * Get single complaint details
 */
router.get('/:id', authenticate, async (req, res, next) => {
  try {
    const complaint = await complaintService.getComplaintById(req.params.id, req.user.id);
    
    if (!complaint) {
      return res.status(404).json({ error: 'Complaint not found' });
    }

    res.json(complaint);
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/complaints
 * Create new complaint
 */
router.post('/', authenticate, async (req, res, next) => {
  try {
    const { type, subject, description, orderId, orderGroupId, affectedPhone, amount, dataSize, txDate, txRef } = req.body;

    if (!type || !subject || !description) {
      return res.status(400).json({ error: 'Type, subject, and description are required' });
    }

    const validTypes = [
      'DATA_NOT_RECEIVED', 'WRONG_DATA_AMOUNT', 'DELAYED_DELIVERY',
      'WRONG_NUMBER', 'DUPLICATE_CHARGE', 'REFUND_REQUEST',
      'TECHNICAL_ISSUE', 'OTHER'
    ];

    if (!validTypes.includes(type)) {
      return res.status(400).json({ error: 'Invalid complaint type' });
    }

    const complaint = await complaintService.createComplaint(req.user.id, {
      type,
      subject,
      description,
      orderId,
      orderGroupId,
      affectedPhone,
      amount: amount ? parseFloat(amount) : null,
      dataSize: dataSize || null,
      txDate: txDate || null,
      txRef: txRef || null
    });

    res.status(201).json({
      message: 'Complaint submitted successfully',
      ticketNumber: complaint.ticketNumber,
      complaint
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/complaints/:id/respond
 * Add response to complaint (agent)
 */
router.post('/:id/respond', authenticate, async (req, res, next) => {
  try {
    const { message } = req.body;

    if (!message || !message.trim()) {
      return res.status(400).json({ error: 'Message is required' });
    }

    const response = await complaintService.addResponse(
      req.params.id,
      req.user.id,
      message,
      false, // isAdmin
      false  // isInternal
    );

    res.json({
      message: 'Response added successfully',
      response
    });
  } catch (error) {
    if (error.message.includes('Not authorized')) {
      return res.status(403).json({ error: error.message });
    }
    next(error);
  }
});

// ============================================
// ADMIN ENDPOINTS
// ============================================

/**
 * GET /api/admin/complaints
 * Get all complaints (admin)
 */
router.get('/admin/all', authenticate, authorize('ADMIN'), async (req, res, next) => {
  try {
    const { status, priority, type, userId, assignedTo } = req.query;
    const complaints = await complaintService.getAllComplaints({
      status, priority, type, userId, assignedTo
    });
    res.json(complaints);
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/admin/complaints/stats
 * Get complaint statistics
 */
router.get('/admin/stats', authenticate, authorize('ADMIN'), async (req, res, next) => {
  try {
    const stats = await complaintService.getComplaintStats();
    res.json(stats);
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/admin/complaints/:id
 * Get single complaint (admin view with all details)
 */
router.get('/admin/:id', authenticate, authorize('ADMIN'), async (req, res, next) => {
  try {
    const complaint = await complaintService.getComplaintById(req.params.id);
    
    if (!complaint) {
      return res.status(404).json({ error: 'Complaint not found' });
    }

    res.json(complaint);
  } catch (error) {
    next(error);
  }
});

/**
 * PUT /api/admin/complaints/bulk-resolve
 * Resolve all non-resolved complaints at once
 */
router.put('/admin/bulk-resolve', authenticate, authorize('ADMIN'), async (req, res, next) => {
  try {
    const unresolved = await prisma.complaint.findMany({
      where: {
        status: { notIn: ['RESOLVED', 'CLOSED'] }
      },
      select: { id: true }
    });

    if (unresolved.length === 0) {
      return res.json({ message: 'No unresolved complaints found', count: 0 });
    }

    await prisma.complaint.updateMany({
      where: {
        status: { notIn: ['RESOLVED', 'CLOSED'] }
      },
      data: {
        status: 'RESOLVED',
        updatedAt: new Date()
      }
    });

    res.json({
      message: `Resolved ${unresolved.length} complaint(s)`,
      count: unresolved.length
    });
  } catch (error) {
    next(error);
  }
});

/**
 * PUT /api/admin/complaints/:id/status
 * Update complaint status
 */
router.put('/admin/:id/status', authenticate, authorize('ADMIN'), async (req, res, next) => {
  try {
    const { status, notes } = req.body;

    const validStatuses = ['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED', 'ESCALATED'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    const complaint = await complaintService.updateStatus(
      req.params.id,
      req.user.id,
      status,
      notes
    );

    res.json({
      message: `Complaint marked as ${status}`,
      complaint
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/admin/complaints/:id/respond
 * Admin response to complaint
 */
router.post('/admin/:id/respond', authenticate, authorize('ADMIN'), async (req, res, next) => {
  try {
    const { message, isInternal } = req.body;

    if (!message || !message.trim()) {
      return res.status(400).json({ error: 'Message is required' });
    }

    const response = await complaintService.addResponse(
      req.params.id,
      req.user.id,
      message,
      true,                    // isAdmin
      isInternal === true     // isInternal
    );

    res.json({
      message: 'Response added successfully',
      response
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/admin/complaints/:id/refund
 * Issue refund for complaint
 */
router.post('/admin/:id/refund', authenticate, authorize('ADMIN'), async (req, res, next) => {
  try {
    const { amount, notes } = req.body;

    if (!amount || parseFloat(amount) <= 0) {
      return res.status(400).json({ error: 'Valid refund amount is required' });
    }

    const result = await complaintService.issueRefund(
      req.params.id,
      req.user.id,
      parseFloat(amount),
      notes
    );

    res.json({
      message: `Refund of GHS ${parseFloat(amount).toFixed(2)} issued successfully`,
      ...result
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/admin/complaints/:id/resend
 * Resend data bundle
 */
router.post('/admin/:id/resend', authenticate, authorize('ADMIN'), async (req, res, next) => {
  try {
    const { phone } = req.body;

    const result = await complaintService.resendData(
      req.params.id,
      req.user.id,
      phone
    );

    res.json({
      message: 'Data resent successfully',
      ...result
    });
  } catch (error) {
    next(error);
  }
});

/**
 * PUT /api/admin/complaints/:id/assign
 * Assign complaint to admin
 */
router.put('/admin/:id/assign', authenticate, authorize('ADMIN'), async (req, res, next) => {
  try {
    const { assignTo } = req.body;

    if (!assignTo) {
      return res.status(400).json({ error: 'assignTo (admin user ID) is required' });
    }

    const complaint = await complaintService.assignComplaint(
      req.params.id,
      req.user.id,
      assignTo
    );

    res.json({
      message: 'Complaint assigned successfully',
      complaint
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
