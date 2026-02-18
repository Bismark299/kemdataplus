/**
 * ALERT SERVICE
 * ==============
 * Manages admin alerts and notifications for critical system events.
 * 
 * Alert Types:
 * - PAYOUT_FAILED: A payout transfer failed
 * - PAYOUT_STUCK: A payout has been in PROCESSING for too long
 * - LOW_PAYSTACK_BALANCE: Paystack balance is below threshold
 * - WEBHOOK_FAILURE: Webhook processing failed
 * - SYSTEM_ERROR: Critical system error
 * - SECURITY_ALERT: Security-related events
 * - HIGH_WITHDRAWAL_VOLUME: Unusual withdrawal activity
 */

const prisma = require('../lib/prisma');

const alertService = {
  /**
   * Create a new alert
   */
  async create({ type, severity = 'MEDIUM', title, message, entityType, entityId, metadata }) {
    try {
      const alert = await prisma.adminAlert.create({
        data: {
          type,
          severity,
          title,
          message,
          entityType,
          entityId,
          metadata: metadata || {}
        }
      });
      
      console.log(`[Alert] Created ${severity} alert: ${title}`);
      return alert;
    } catch (error) {
      console.error('[Alert] Failed to create alert:', error);
      return null;
    }
  },

  /**
   * Alert when a payout fails
   */
  async payoutFailed({ payoutId, reference, agentName, amount, reason }) {
    return await this.create({
      type: 'PAYOUT_FAILED',
      severity: 'HIGH',
      title: 'Payout Transfer Failed',
      message: `Payout ${reference} for ${agentName} (GH₵${amount.toFixed(2)}) failed: ${reason}`,
      entityType: 'AgentPayout',
      entityId: payoutId,
      metadata: { reference, agentName, amount, reason }
    });
  },

  /**
   * Alert when a payout is stuck in PROCESSING
   */
  async payoutStuck({ payoutId, reference, agentName, amount, processingDuration }) {
    return await this.create({
      type: 'PAYOUT_STUCK',
      severity: 'MEDIUM',
      title: 'Payout Stuck in Processing',
      message: `Payout ${reference} has been processing for ${processingDuration}. May need manual intervention.`,
      entityType: 'AgentPayout',
      entityId: payoutId,
      metadata: { reference, agentName, amount, processingDuration }
    });
  },

  /**
   * Alert when Paystack balance is low
   */
  async lowPaystackBalance({ currentBalance, threshold }) {
    return await this.create({
      type: 'LOW_PAYSTACK_BALANCE',
      severity: 'CRITICAL',
      title: 'Low Paystack Balance',
      message: `Paystack balance (GH₵${currentBalance.toFixed(2)}) is below threshold (GH₵${threshold.toFixed(2)}). Top up required.`,
      entityType: 'System',
      metadata: { currentBalance, threshold }
    });
  },

  /**
   * Alert for unusual withdrawal volume
   */
  async highWithdrawalVolume({ totalAmount, count, period }) {
    return await this.create({
      type: 'HIGH_WITHDRAWAL_VOLUME',
      severity: 'MEDIUM',
      title: 'High Withdrawal Volume Detected',
      message: `${count} withdrawal requests totaling GH₵${totalAmount.toFixed(2)} in the last ${period}`,
      entityType: 'System',
      metadata: { totalAmount, count, period }
    });
  },

  /**
   * Alert for webhook failures
   */
  async webhookFailure({ endpoint, errorMessage, payload }) {
    return await this.create({
      type: 'WEBHOOK_FAILURE',
      severity: 'HIGH',
      title: 'Webhook Processing Failed',
      message: `Webhook from ${endpoint} failed: ${errorMessage}`,
      entityType: 'Webhook',
      metadata: { endpoint, errorMessage, payloadSummary: JSON.stringify(payload).slice(0, 500) }
    });
  },

  /**
   * Get unread alerts
   */
  async getUnread({ limit = 50 } = {}) {
    return await prisma.adminAlert.findMany({
      where: { isRead: false, isDismissed: false },
      orderBy: [{ severity: 'desc' }, { createdAt: 'desc' }],
      take: limit
    });
  },

  /**
   * Get all alerts with filters
   */
  async getAll({ type, severity, isRead, page = 1, limit = 20 } = {}) {
    const where = { isDismissed: false };
    
    if (type) where.type = type;
    if (severity) where.severity = severity;
    if (typeof isRead === 'boolean') where.isRead = isRead;

    const [alerts, total] = await Promise.all([
      prisma.adminAlert.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit
      }),
      prisma.adminAlert.count({ where })
    ]);

    return {
      alerts,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) }
    };
  },

  /**
   * Get alert counts by type and severity
   */
  async getCounts() {
    const [byType, bySeverity, unreadCount] = await Promise.all([
      prisma.adminAlert.groupBy({
        by: ['type'],
        where: { isDismissed: false },
        _count: { type: true }
      }),
      prisma.adminAlert.groupBy({
        by: ['severity'],
        where: { isDismissed: false, isRead: false },
        _count: { severity: true }
      }),
      prisma.adminAlert.count({
        where: { isRead: false, isDismissed: false }
      })
    ]);

    return {
      unread: unreadCount,
      byType: byType.reduce((acc, t) => { acc[t.type] = t._count.type; return acc; }, {}),
      bySeverity: bySeverity.reduce((acc, s) => { acc[s.severity] = s._count.severity; return acc; }, {})
    };
  },

  /**
   * Mark alert as read
   */
  async markRead(alertId, readBy) {
    return await prisma.adminAlert.update({
      where: { id: alertId },
      data: { isRead: true, readBy, readAt: new Date() }
    });
  },

  /**
   * Mark multiple alerts as read
   */
  async markManyRead(alertIds, readBy) {
    return await prisma.adminAlert.updateMany({
      where: { id: { in: alertIds } },
      data: { isRead: true, readBy, readAt: new Date() }
    });
  },

  /**
   * Dismiss an alert
   */
  async dismiss(alertId, dismissedBy) {
    return await prisma.adminAlert.update({
      where: { id: alertId },
      data: { isDismissed: true, dismissedBy, dismissedAt: new Date() }
    });
  },

  /**
   * Resolve an alert (for auto-resolvable alerts)
   */
  async resolve(alertId) {
    return await prisma.adminAlert.update({
      where: { id: alertId },
      data: { isResolved: true, resolvedAt: new Date() }
    });
  },

  /**
   * Check for stuck payouts and create alerts
   * Call this periodically (e.g., every hour)
   */
  async checkStuckPayouts(maxProcessingHours = 6) {
    const cutoff = new Date(Date.now() - maxProcessingHours * 60 * 60 * 1000);
    
    const stuckPayouts = await prisma.agentPayout.findMany({
      where: {
        status: 'PROCESSING',
        updatedAt: { lt: cutoff }
      },
      include: {
        user: { select: { name: true } }
      }
    });

    for (const payout of stuckPayouts) {
      // Check if we already have an unresolved alert for this payout
      const existingAlert = await prisma.adminAlert.findFirst({
        where: {
          type: 'PAYOUT_STUCK',
          entityId: payout.id,
          isResolved: false
        }
      });

      if (!existingAlert) {
        const hoursSince = Math.round((Date.now() - new Date(payout.updatedAt).getTime()) / (60 * 60 * 1000));
        await this.payoutStuck({
          payoutId: payout.id,
          reference: payout.reference,
          agentName: payout.user?.name || 'Unknown',
          amount: payout.amount,
          processingDuration: `${hoursSince} hours`
        });
      }
    }

    return stuckPayouts.length;
  },

  /**
   * Clean up old dismissed alerts
   */
  async cleanupOld(daysOld = 30) {
    const cutoff = new Date(Date.now() - daysOld * 24 * 60 * 60 * 1000);
    
    const result = await prisma.adminAlert.deleteMany({
      where: {
        isDismissed: true,
        dismissedAt: { lt: cutoff }
      }
    });

    console.log(`[Alert] Cleaned up ${result.count} old alerts`);
    return result.count;
  }
};

module.exports = alertService;
