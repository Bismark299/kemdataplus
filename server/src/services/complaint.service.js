/**
 * COMPLAINT SERVICE
 * ==================
 * Handles support ticket/complaint system for agents
 * 
 * Features:
 * - Create complaints for order issues
 * - Track complaint status
 * - Admin actions (resolve, refund, resend)
 * - Response/messaging system
 */

const prisma = require('../lib/prisma');

const complaintService = {
  /**
   * Generate unique ticket number
   */
  async generateTicketNumber() {
    const lastComplaint = await prisma.complaint.findFirst({
      orderBy: { createdAt: 'desc' },
      select: { ticketNumber: true }
    });

    let nextNumber = 1;
    if (lastComplaint?.ticketNumber) {
      const match = lastComplaint.ticketNumber.match(/TICKET-(\d+)/);
      if (match) {
        nextNumber = parseInt(match[1]) + 1;
      }
    }

    return `TICKET-${String(nextNumber).padStart(6, '0')}`;
  },

  /**
   * Create a new complaint
   */
  async createComplaint(userId, data) {
    const ticketNumber = await this.generateTicketNumber();

    // Validate order if provided
    let order = null;
    if (data.orderId) {
      order = await prisma.order.findFirst({
        where: { 
          id: data.orderId,
          userId: userId
        },
        include: { bundle: true }
      });

      if (!order) {
        throw new Error('Order not found or does not belong to you');
      }
    }

    // Auto-set priority based on type
    let priority = data.priority || 'MEDIUM';
    if (data.type === 'WALLET_CREDIT_ISSUE') {
      priority = 'HIGH';
    }
    if (data.type === 'DATA_NOT_RECEIVED' && data.amount > 50) {
      priority = 'HIGH';
    }

    const complaint = await prisma.complaint.create({
      data: {
        ticketNumber,
        userId,
        orderId: data.orderId || null,
        orderGroupId: data.orderGroupId || null,
        type: data.type,
        subject: data.subject,
        description: data.description,
        affectedPhone: data.affectedPhone || order?.recipientPhone,
        dataSize: data.dataSize || null,
        txDate: data.txDate ? new Date(data.txDate) : null,
        txRef: data.txRef || null,
        amount: data.amount || order?.totalPrice,
        priority,
        status: 'OPEN'
      },
      include: {
        user: {
          select: { id: true, name: true, email: true, phone: true, role: true }
        },
        order: {
          include: { bundle: true }
        }
      }
    });

    // Log audit
    await prisma.auditLog.create({
      data: {
        userId,
        action: 'CREATE',
        entityType: 'Complaint',
        entityId: complaint.id,
        newValues: { ticketNumber, type: data.type, subject: data.subject }
      }
    }).catch(() => {});

    return complaint;
  },

  /**
   * Get complaints for a user (agent)
   */
  async getUserComplaints(userId, filters = {}) {
    const where = { userId };

    if (filters.status) {
      where.status = filters.status;
    }
    if (filters.type) {
      where.type = filters.type;
    }

    const complaints = await prisma.complaint.findMany({
      where,
      include: {
        order: {
          select: {
            id: true,
            reference: true,
            recipientPhone: true,
            totalPrice: true,
            status: true,
            bundle: {
              select: { name: true, network: true }
            }
          }
        },
        responses: {
          where: { isInternal: false },
          orderBy: { createdAt: 'desc' },
          take: 1
        },
        _count: {
          select: { responses: true }
        }
      },
      orderBy: { createdAt: 'desc' }
    });

    return complaints;
  },

  /**
   * Get single complaint details
   */
  async getComplaintById(complaintId, userId = null) {
    const where = { id: complaintId };
    
    // If userId provided, ensure ownership (for agents)
    if (userId) {
      where.userId = userId;
    }

    const complaint = await prisma.complaint.findFirst({
      where,
      include: {
        user: {
          select: { id: true, name: true, email: true, phone: true, role: true }
        },
        order: {
          include: {
            bundle: true
          }
        },
        assignedAdmin: {
          select: { id: true, name: true }
        },
        responses: {
          where: userId ? { isInternal: false } : {},
          include: {
            user: {
              select: { id: true, name: true, role: true }
            }
          },
          orderBy: { createdAt: 'asc' }
        }
      }
    });

    return complaint;
  },

  /**
   * Add response to complaint (agent or admin)
   */
  async addResponse(complaintId, userId, message, isAdmin = false, isInternal = false) {
    // Verify complaint exists
    const complaint = await prisma.complaint.findUnique({
      where: { id: complaintId }
    });

    if (!complaint) {
      throw new Error('Complaint not found');
    }

    // Agents can only respond to their own complaints
    if (!isAdmin && complaint.userId !== userId) {
      throw new Error('Not authorized to respond to this complaint');
    }

    const response = await prisma.complaintResponse.create({
      data: {
        complaintId,
        userId,
        message,
        isAdmin,
        isInternal
      },
      include: {
        user: {
          select: { id: true, name: true, role: true }
        }
      }
    });

    // If admin responds, update status to IN_PROGRESS if still OPEN
    if (isAdmin && complaint.status === 'OPEN') {
      await prisma.complaint.update({
        where: { id: complaintId },
        data: { status: 'IN_PROGRESS' }
      });
    }

    return response;
  },

  // ============================================
  // ADMIN FUNCTIONS
  // ============================================

  /**
   * Get all complaints (admin)
   */
  async getAllComplaints(filters = {}) {
    const where = {};

    if (filters.status) {
      where.status = filters.status;
    }
    if (filters.priority) {
      where.priority = filters.priority;
    }
    if (filters.type) {
      where.type = filters.type;
    }
    if (filters.userId) {
      where.userId = filters.userId;
    }
    if (filters.assignedTo) {
      where.assignedTo = filters.assignedTo;
    }

    const complaints = await prisma.complaint.findMany({
      where,
      include: {
        user: {
          select: { id: true, name: true, email: true, phone: true, role: true }
        },
        order: {
          select: {
            id: true,
            reference: true,
            recipientPhone: true,
            totalPrice: true,
            status: true,
            externalReference: true,
            bundle: {
              select: { name: true, network: true, dataAmount: true }
            }
          }
        },
        assignedAdmin: {
          select: { id: true, name: true }
        },
        _count: {
          select: { responses: true }
        }
      },
      orderBy: [
        { priority: 'desc' },
        { createdAt: 'desc' }
      ]
    });

    return complaints;
  },

  /**
   * Get complaint statistics (admin dashboard)
   */
  async getComplaintStats() {
    const [total, open, inProgress, resolved, today, urgent] = await Promise.all([
      prisma.complaint.count(),
      prisma.complaint.count({ where: { status: 'OPEN' } }),
      prisma.complaint.count({ where: { status: 'IN_PROGRESS' } }),
      prisma.complaint.count({ where: { status: 'RESOLVED' } }),
      prisma.complaint.count({
        where: {
          createdAt: {
            gte: new Date(new Date().setHours(0, 0, 0, 0))
          }
        }
      }),
      prisma.complaint.count({
        where: {
          priority: 'URGENT',
          status: { in: ['OPEN', 'IN_PROGRESS'] }
        }
      })
    ]);

    return { total, open, inProgress, resolved, today, urgent };
  },

  /**
   * Update complaint status
   */
  async updateStatus(complaintId, adminId, status, notes = null) {
    const updateData = { status };

    if (status === 'IN_PROGRESS') {
      updateData.assignedTo = adminId;
    }
    if (status === 'RESOLVED') {
      updateData.resolvedAt = new Date();
      updateData.resolvedBy = adminId;
      if (notes) updateData.resolution = notes;
    }
    if (status === 'CLOSED') {
      updateData.closedAt = new Date();
      updateData.closedBy = adminId;
    }
    if (status === 'ESCALATED') {
      updateData.escalatedAt = new Date();
      updateData.escalatedBy = adminId;
      updateData.priority = 'URGENT';
    }
    if (notes && !updateData.resolution) {
      updateData.internalNotes = notes;
    }

    const complaint = await prisma.complaint.update({
      where: { id: complaintId },
      data: updateData,
      include: {
        user: {
          select: { id: true, name: true, email: true }
        }
      }
    });

    // Audit log
    await prisma.auditLog.create({
      data: {
        userId: adminId,
        action: 'UPDATE',
        entityType: 'Complaint',
        entityId: complaintId,
        newValues: { status, notes }
      }
    }).catch(() => {});

    return complaint;
  },

  /**
   * Issue refund for complaint
   */
  async issueRefund(complaintId, adminId, amount, notes = null) {
    const complaint = await prisma.complaint.findUnique({
      where: { id: complaintId },
      include: { user: true, order: true }
    });

    if (!complaint) {
      throw new Error('Complaint not found');
    }

    // Process refund in transaction
    const result = await prisma.$transaction(async (tx) => {
      // Credit user's wallet
      const wallet = await tx.wallet.update({
        where: { userId: complaint.userId },
        data: {
          balance: { increment: amount }
        }
      });

      // Create wallet transaction
      await tx.walletLedger.create({
        data: {
          walletId: wallet.id,
          type: 'REFUND',
          amount: amount,
          balanceAfter: wallet.balance,
          description: `Refund for complaint ${complaint.ticketNumber}`,
          referenceType: 'COMPLAINT',
          referenceId: complaintId,
          status: 'COMPLETED'
        }
      });

      // Update complaint
      const updated = await tx.complaint.update({
        where: { id: complaintId },
        data: {
          refundAmount: amount,
          refundedAt: new Date(),
          status: 'RESOLVED',
          resolvedAt: new Date(),
          resolvedBy: adminId,
          resolution: notes || `Refund of GHS ${amount.toFixed(2)} issued`
        }
      });

      return { complaint: updated, wallet };
    });

    // Audit log
    await prisma.auditLog.create({
      data: {
        userId: adminId,
        action: 'WALLET_CREDIT',
        entityType: 'Complaint',
        entityId: complaintId,
        newValues: { refundAmount: amount, walletBalance: result.wallet.balance }
      }
    }).catch(() => {});

    return result;
  },

  /**
   * Resend data bundle for complaint
   */
  async resendData(complaintId, adminId, phone = null) {
    const complaint = await prisma.complaint.findUnique({
      where: { id: complaintId },
      include: {
        order: {
          include: { bundle: true }
        }
      }
    });

    if (!complaint) {
      throw new Error('Complaint not found');
    }

    if (!complaint.order) {
      throw new Error('No order associated with this complaint');
    }

    const recipientPhone = phone || complaint.affectedPhone || complaint.order.recipientPhone;

    // Create a new order for the resend
    const datahubService = require('./datahub.service');
    
    const resendResult = await datahubService.placeOrder({
      network: complaint.order.bundle.network,
      phone: recipientPhone,
      amount: parseFloat(complaint.order.bundle.dataAmount) || 1,
      orderId: `RESEND-${complaint.ticketNumber}`
    });

    // Update complaint
    const updated = await prisma.complaint.update({
      where: { id: complaintId },
      data: {
        dataResent: true,
        dataResentAt: new Date(),
        status: 'RESOLVED',
        resolvedAt: new Date(),
        resolvedBy: adminId,
        resolution: `Data resent to ${recipientPhone}. Reference: ${resendResult.reference || 'N/A'}`
      }
    });

    // Audit log
    await prisma.auditLog.create({
      data: {
        userId: adminId,
        action: 'UPDATE',
        entityType: 'Complaint',
        entityId: complaintId,
        newValues: { action: 'RESEND_DATA', phone: recipientPhone, result: resendResult }
      }
    }).catch(() => {});

    return { complaint: updated, resendResult };
  },

  /**
   * Assign complaint to admin
   */
  async assignComplaint(complaintId, adminId, assignToId) {
    const complaint = await prisma.complaint.update({
      where: { id: complaintId },
      data: {
        assignedTo: assignToId,
        status: 'IN_PROGRESS'
      },
      include: {
        assignedAdmin: {
          select: { id: true, name: true }
        }
      }
    });

    return complaint;
  },

  /**
   * Get recent orders for complaint form (agent)
   */
  async getRecentOrdersForComplaint(userId) {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const orders = await prisma.order.findMany({
      where: {
        userId,
        createdAt: { gte: thirtyDaysAgo }
      },
      select: {
        id: true,
        reference: true,
        recipientPhone: true,
        totalPrice: true,
        status: true,
        createdAt: true,
        bundle: {
          select: { name: true, network: true, dataAmount: true }
        }
      },
      orderBy: { createdAt: 'desc' },
      take: 50
    });

    return orders;
  }
};

module.exports = complaintService;
