/**
 * AUDIT SERVICE
 * ==============
 * Comprehensive audit logging for compliance and accountability.
 * 
 * PRINCIPLES:
 * 1. All logs are append-only (immutable)
 * 2. Every financial action is logged
 * 3. Every admin action is logged
 * 4. Logs include IP address and user agent
 * 5. Logs are queryable for reports
 */

const { v4: uuidv4 } = require('uuid');

const prisma = require('../lib/prisma');

const auditService = {
  /**
   * Log an audit entry
   * @param {Object} data - Audit data
   */
  async log(data) {
    try {
      const entry = await prisma.auditLog.create({
        data: {
          id: uuidv4(),
          userId: data.userId || null,
          tenantId: data.tenantId || null,
          ipAddress: data.ipAddress || null,
          userAgent: data.userAgent || null,
          action: data.action,
          entityType: data.entityType,
          entityId: data.entityId || null,
          oldValues: data.oldValues || null,
          newValues: data.newValues || null,
          metadata: data.metadata || null
        }
      });
      return entry;
    } catch (error) {
      console.error('Audit log failed:', error);
      // Don't throw - audit failure shouldn't break the main operation
      return null;
    }
  },

  /**
   * Log user login
   */
  async logLogin(userId, ipAddress, userAgent, success = true, failureReason = null) {
    return await this.log({
      userId,
      ipAddress,
      userAgent,
      action: 'LOGIN',
      entityType: 'User',
      entityId: userId,
      metadata: { success, failureReason }
    });
  },

  /**
   * Log user logout
   */
  async logLogout(userId, ipAddress) {
    return await this.log({
      userId,
      ipAddress,
      action: 'LOGOUT',
      entityType: 'User',
      entityId: userId
    });
  },

  /**
   * Log price change
   */
  async logPriceChange(data) {
    return await this.log({
      userId: data.changedBy,
      tenantId: data.tenantId,
      action: 'PRICE_CHANGE',
      entityType: data.entityType || 'BundlePrice',
      entityId: data.entityId,
      oldValues: { price: data.oldPrice },
      newValues: { price: data.newPrice },
      metadata: {
        bundleId: data.bundleId,
        role: data.role,
        reason: data.reason
      }
    });
  },

  /**
   * Log wallet operation
   */
  async logWalletOperation(data) {
    return await this.log({
      userId: data.userId,
      tenantId: data.tenantId,
      action: data.type === 'credit' ? 'WALLET_CREDIT' : 'WALLET_DEBIT',
      entityType: 'Wallet',
      entityId: data.walletId,
      oldValues: { balance: data.oldBalance },
      newValues: { balance: data.newBalance, amount: data.amount },
      metadata: {
        reference: data.reference,
        description: data.description
      }
    });
  },

  /**
   * Log order action
   */
  async logOrderAction(data) {
    const actionMap = {
      create: 'ORDER_CREATE',
      complete: 'ORDER_COMPLETE',
      cancel: 'ORDER_CANCEL'
    };

    return await this.log({
      userId: data.userId,
      tenantId: data.tenantId,
      action: actionMap[data.action] || 'UPDATE',
      entityType: 'Order',
      entityId: data.orderId,
      oldValues: data.oldValues,
      newValues: data.newValues,
      metadata: data.metadata
    });
  },

  /**
   * Log admin override
   */
  async logAdminOverride(data) {
    return await this.log({
      userId: data.adminId,
      tenantId: data.tenantId,
      ipAddress: data.ipAddress,
      action: 'ADMIN_OVERRIDE',
      entityType: data.entityType,
      entityId: data.entityId,
      oldValues: data.oldValues,
      newValues: data.newValues,
      metadata: {
        reason: data.reason,
        overrideType: data.overrideType
      }
    });
  },

  /**
   * Query audit logs with filters
   */
  async queryLogs(filters = {}, pagination = { page: 1, limit: 50 }) {
    const where = {};

    if (filters.userId) where.userId = filters.userId;
    if (filters.tenantId) where.tenantId = filters.tenantId;
    if (filters.action) where.action = filters.action;
    if (filters.entityType) where.entityType = filters.entityType;
    if (filters.entityId) where.entityId = filters.entityId;
    
    if (filters.startDate || filters.endDate) {
      where.createdAt = {};
      if (filters.startDate) where.createdAt.gte = new Date(filters.startDate);
      if (filters.endDate) where.createdAt.lte = new Date(filters.endDate);
    }

    const [logs, total] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        skip: (pagination.page - 1) * pagination.limit,
        take: pagination.limit,
        orderBy: { createdAt: 'desc' },
        include: {
          user: {
            select: { id: true, name: true, email: true, role: true }
          },
          tenant: {
            select: { id: true, name: true, slug: true }
          }
        }
      }),
      prisma.auditLog.count({ where })
    ]);

    return {
      logs,
      pagination: {
        page: pagination.page,
        limit: pagination.limit,
        total,
        pages: Math.ceil(total / pagination.limit)
      }
    };
  },

  /**
   * Get audit trail for specific entity
   */
  async getEntityAuditTrail(entityType, entityId) {
    return await prisma.auditLog.findMany({
      where: { entityType, entityId },
      orderBy: { createdAt: 'desc' },
      include: {
        user: {
          select: { id: true, name: true, email: true }
        }
      }
    });
  },

  /**
   * Get user activity summary
   */
  async getUserActivitySummary(userId, days = 30) {
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const logs = await prisma.auditLog.groupBy({
      by: ['action'],
      where: {
        userId,
        createdAt: { gte: startDate }
      },
      _count: { action: true }
    });

    return logs.map(l => ({
      action: l.action,
      count: l._count.action
    }));
  },

  /**
   * Get security alerts (failed logins, suspicious activity)
   */
  async getSecurityAlerts(tenantId = null, hours = 24) {
    const startDate = new Date();
    startDate.setHours(startDate.getHours() - hours);

    const where = {
      createdAt: { gte: startDate },
      action: 'LOGIN',
      metadata: {
        path: ['success'],
        equals: false
      }
    };

    if (tenantId) where.tenantId = tenantId;

    const failedLogins = await prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: {
        user: {
          select: { id: true, name: true, email: true }
        }
      }
    });

    // Group by IP address to detect brute force
    const byIp = {};
    for (const log of failedLogins) {
      if (!log.ipAddress) continue;
      if (!byIp[log.ipAddress]) {
        byIp[log.ipAddress] = { count: 0, users: new Set() };
      }
      byIp[log.ipAddress].count++;
      if (log.userId) byIp[log.ipAddress].users.add(log.userId);
    }

    const alerts = [];
    for (const [ip, data] of Object.entries(byIp)) {
      if (data.count >= 5) {
        alerts.push({
          type: 'BRUTE_FORCE_ATTEMPT',
          severity: data.count >= 10 ? 'HIGH' : 'MEDIUM',
          ipAddress: ip,
          attemptCount: data.count,
          targetedUsers: data.users.size
        });
      }
    }

    return {
      failedLogins: failedLogins.length,
      alerts
    };
  },

  /**
   * Generate compliance report
   */
  async generateComplianceReport(tenantId, startDate, endDate) {
    const where = {
      createdAt: {
        gte: new Date(startDate),
        lte: new Date(endDate)
      }
    };

    if (tenantId) where.tenantId = tenantId;

    const [
      totalActions,
      byAction,
      byUser,
      priceChanges,
      walletOperations,
      adminOverrides
    ] = await Promise.all([
      prisma.auditLog.count({ where }),
      prisma.auditLog.groupBy({
        by: ['action'],
        where,
        _count: { action: true }
      }),
      prisma.auditLog.groupBy({
        by: ['userId'],
        where: { ...where, userId: { not: null } },
        _count: { userId: true }
      }),
      prisma.auditLog.count({
        where: { ...where, action: 'PRICE_CHANGE' }
      }),
      prisma.auditLog.count({
        where: {
          ...where,
          action: { in: ['WALLET_CREDIT', 'WALLET_DEBIT'] }
        }
      }),
      prisma.auditLog.findMany({
        where: { ...where, action: 'ADMIN_OVERRIDE' },
        include: {
          user: { select: { name: true, email: true } }
        }
      })
    ]);

    return {
      period: { startDate, endDate },
      tenantId,
      summary: {
        totalActions,
        uniqueUsers: byUser.length,
        priceChanges,
        walletOperations
      },
      byAction: byAction.map(a => ({
        action: a.action,
        count: a._count.action
      })),
      adminOverrides: adminOverrides.map(o => ({
        timestamp: o.createdAt,
        admin: o.user?.name || 'Unknown',
        entityType: o.entityType,
        reason: o.metadata?.reason
      }))
    };
  },

  // ========== PAYOUT AUDIT METHODS ==========
  
  /**
   * Log payout request
   */
  async logPayoutRequest(data) {
    return await this.log({
      userId: data.userId,
      action: 'PAYOUT_REQUEST',
      entityType: 'AgentPayout',
      entityId: data.payoutId,
      newValues: {
        amount: data.amount,
        fee: data.fee,
        netAmount: data.netAmount,
        accountNumber: data.accountNumber?.slice(-4) ? `****${data.accountNumber.slice(-4)}` : null,
        network: data.network
      },
      metadata: {
        reference: data.reference,
        accountName: data.accountName
      }
    });
  },

  /**
   * Log payout accumulation (adding to existing request)
   */
  async logPayoutAccumulate(data) {
    return await this.log({
      userId: data.userId,
      action: 'PAYOUT_ACCUMULATE',
      entityType: 'AgentPayout',
      entityId: data.payoutId,
      oldValues: {
        amount: data.previousAmount,
        fee: data.previousFee
      },
      newValues: {
        amount: data.newAmount,
        fee: data.newFee,
        addedAmount: data.addedAmount
      },
      metadata: {
        reference: data.reference
      }
    });
  },

  /**
   * Log payout approval/processing start
   */
  async logPayoutApprove(data) {
    return await this.log({
      userId: data.adminId,
      action: 'PAYOUT_APPROVE',
      entityType: 'AgentPayout',
      entityId: data.payoutId,
      oldValues: { status: data.oldStatus },
      newValues: { status: data.newStatus },
      metadata: {
        reference: data.reference,
        agentId: data.agentId,
        amount: data.amount
      }
    });
  },

  /**
   * Log payout rejection
   */
  async logPayoutReject(data) {
    return await this.log({
      userId: data.adminId,
      action: 'PAYOUT_REJECT',
      entityType: 'AgentPayout',
      entityId: data.payoutId,
      oldValues: { status: data.oldStatus },
      newValues: { status: 'REJECTED' },
      metadata: {
        reference: data.reference,
        agentId: data.agentId,
        amount: data.amount,
        reason: data.reason
      }
    });
  },

  /**
   * Log payout processing (sent to Paystack)
   */
  async logPayoutProcess(data) {
    return await this.log({
      userId: data.adminId,
      action: 'PAYOUT_PROCESS',
      entityType: 'AgentPayout',
      entityId: data.payoutId,
      oldValues: { status: 'RESERVED' },
      newValues: { status: 'PROCESSING', transferCode: data.transferCode },
      metadata: {
        reference: data.reference,
        paystackReference: data.paystackReference,
        amount: data.amount
      }
    });
  },

  /**
   * Log payout completion (successful)
   */
  async logPayoutComplete(data) {
    return await this.log({
      userId: data.adminId || null,
      action: 'PAYOUT_COMPLETE',
      entityType: 'AgentPayout',
      entityId: data.payoutId,
      oldValues: { status: data.oldStatus },
      newValues: { status: 'COMPLETED' },
      metadata: {
        reference: data.reference,
        agentId: data.agentId,
        amount: data.amount,
        completedVia: data.completedVia || 'webhook' // 'webhook', 'manual', 'force'
      }
    });
  },

  /**
   * Log payout failure
   */
  async logPayoutFail(data) {
    return await this.log({
      userId: data.adminId || null,
      action: 'PAYOUT_FAIL',
      entityType: 'AgentPayout',
      entityId: data.payoutId,
      oldValues: { status: data.oldStatus },
      newValues: { status: 'FAILED' },
      metadata: {
        reference: data.reference,
        agentId: data.agentId,
        amount: data.amount,
        failureReason: data.failureReason,
        failedVia: data.failedVia || 'webhook'
      }
    });
  },

  /**
   * Log force complete by admin
   */
  async logPayoutForceComplete(data) {
    return await this.log({
      userId: data.adminId,
      action: 'PAYOUT_FORCE_COMPLETE',
      entityType: 'AgentPayout',
      entityId: data.payoutId,
      oldValues: { status: data.oldStatus },
      newValues: { status: 'COMPLETED' },
      metadata: {
        reference: data.reference,
        agentId: data.agentId,
        amount: data.amount,
        reason: data.reason || 'Admin force complete'
      }
    });
  },

  /**
   * Log force cancel by admin
   */
  async logPayoutForceCancel(data) {
    return await this.log({
      userId: data.adminId,
      action: 'PAYOUT_FORCE_CANCEL',
      entityType: 'AgentPayout',
      entityId: data.payoutId,
      oldValues: { status: data.oldStatus },
      newValues: { status: 'FAILED' },
      metadata: {
        reference: data.reference,
        agentId: data.agentId,
        amount: data.amount,
        reason: data.reason
      }
    });
  },

  /**
   * Log user cancellation
   */
  async logPayoutCancel(data) {
    return await this.log({
      userId: data.userId,
      action: 'PAYOUT_CANCEL',
      entityType: 'AgentPayout',
      entityId: data.payoutId,
      oldValues: { status: data.oldStatus },
      newValues: { status: 'CANCELLED' },
      metadata: {
        reference: data.reference,
        amount: data.amount
      }
    });
  },

  /**
   * Query payout audit trail
   */
  async getPayoutAuditTrail(payoutId) {
    return await prisma.auditLog.findMany({
      where: {
        entityType: 'AgentPayout',
        entityId: payoutId
      },
      orderBy: { createdAt: 'asc' },
      include: {
        user: {
          select: { id: true, name: true, email: true, role: true }
        }
      }
    });
  },

  /**
   * Query all payout audits within a period
   */
  async getPayoutAuditSummary(startDate, endDate) {
    const where = {
      entityType: 'AgentPayout',
      createdAt: {
        gte: new Date(startDate),
        lte: new Date(endDate)
      }
    };

    const [byAction, total] = await Promise.all([
      prisma.auditLog.groupBy({
        by: ['action'],
        where,
        _count: { action: true }
      }),
      prisma.auditLog.count({ where })
    ]);

    return {
      period: { startDate, endDate },
      total,
      byAction: byAction.reduce((acc, a) => {
        acc[a.action] = a._count.action;
        return acc;
      }, {})
    };
  }
};

module.exports = auditService;
