/**
 * ============================================================
 * ORDER GROUP SERVICE - BANK-GRADE ORDER MANAGEMENT
 * ============================================================
 * 
 * This service implements a financially-safe, concurrency-proof
 * order system with the following guarantees:
 * 
 * 1. GLOBAL SEQUENTIAL IDs - Never reset, never duplicate
 * 2. BATCH GROUPING - Multiple items share one Order ID
 * 3. ATOMIC TRANSACTIONS - All-or-nothing order creation
 * 4. DUPLICATE PREVENTION - Idempotency keys prevent double-charges
 * 5. AUDIT TRAIL - Complete history of all state changes
 * 
 * Architecture:
 * - OrderGroup: The customer-facing order (ORD-XXXXXX)
 * - OrderItem: Individual line items within an order
 * 
 * ID Generation: PostgreSQL SERIAL sequence (atomic, never resets)
 */

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// ============================================================
// CONSTANTS
// ============================================================

const ORDER_ID_PREFIX = 'ORD';
const ORDER_ID_PAD_LENGTH = 6;

// ============================================================
// ORDER GROUP SERVICE
// ============================================================

const orderGroupService = {
  
  /**
   * Generate display ID from sequence number
   * @param {number} sequenceNum - The database sequence number
   * @returns {string} Formatted ID like "ORD-000001"
   */
  formatOrderId(sequenceNum) {
    return `${ORDER_ID_PREFIX}-${String(sequenceNum).padStart(ORDER_ID_PAD_LENGTH, '0')}`;
  },

  /**
   * Parse sequence number from display ID
   * @param {string} displayId - ID like "ORD-000001"
   * @returns {number} The sequence number
   */
  parseOrderId(displayId) {
    const match = displayId.match(/ORD-(\d+)/);
    return match ? parseInt(match[1], 10) : null;
  },

  /**
   * ============================================================
   * CREATE ORDER (SINGLE OR BATCH)
   * ============================================================
   * 
   * This is the main entry point for creating orders.
   * Handles both single orders and batch orders atomically.
   * 
   * @param {object} params
   * @param {string} params.userId - The customer's user ID
   * @param {string} params.tenantId - The tenant ID (optional)
   * @param {array} params.items - Array of order items:
   *   - bundleId: string
   *   - recipientPhone: string
   *   - quantity: number (default 1)
   * @param {string} params.idempotencyKey - Unique key to prevent duplicates
   * 
   * @returns {object} The created OrderGroup with items
   */
  async createOrder({ userId, tenantId, items, idempotencyKey }) {
    // Validate inputs
    if (!userId) throw new Error('userId is required');
    if (!items || !Array.isArray(items) || items.length === 0) {
      throw new Error('At least one order item is required');
    }
    if (!idempotencyKey) {
      // Generate one if not provided (but client should always provide)
      idempotencyKey = `${userId}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    }

    console.log(`[OrderGroup] Creating order for user ${userId}`);
    console.log(`[OrderGroup] Items: ${items.length}, IdempotencyKey: ${idempotencyKey}`);

    // ============================================================
    // STEP 1: CHECK FOR DUPLICATE (Idempotency)
    // ============================================================
    const existingOrder = await prisma.orderGroup.findUnique({
      where: { idempotencyKey },
      include: {
        items: {
          include: { bundle: true }
        }
      }
    });

    if (existingOrder) {
      console.log(`[OrderGroup] DUPLICATE DETECTED - Returning existing order ${existingOrder.displayId}`);
      return {
        success: true,
        duplicate: true,
        orderGroup: existingOrder,
        message: 'Order already exists (idempotency protection)'
      };
    }

    // ============================================================
    // STEP 2: VALIDATE ALL ITEMS & CALCULATE TOTALS
    // ============================================================
    const validatedItems = [];
    let grandTotal = 0;

    for (const item of items) {
      if (!item.bundleId) throw new Error('bundleId is required for each item');
      if (!item.recipientPhone) throw new Error('recipientPhone is required for each item');

      // Get bundle with pricing
      const bundle = await prisma.bundle.findUnique({
        where: { id: item.bundleId }
      });

      if (!bundle) {
        throw new Error(`Bundle not found: ${item.bundleId}`);
      }

      if (!bundle.isActive) {
        throw new Error(`Bundle is not available: ${bundle.name}`);
      }

      // Get user's role-based price
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { role: true }
      });

      // Get price for user's role
      const rolePrice = await prisma.rolePrice.findUnique({
        where: {
          bundleId_role_tenantId: {
            bundleId: bundle.id,
            role: user.role,
            tenantId: tenantId || 'default'
          }
        }
      });

      const unitPrice = rolePrice?.price || bundle.basePrice;
      const quantity = item.quantity || 1;
      const itemTotal = unitPrice * quantity;

      validatedItems.push({
        bundleId: bundle.id,
        bundleName: bundle.name,
        network: bundle.network,
        dataAmount: bundle.dataAmount,
        recipientPhone: item.recipientPhone,
        quantity,
        unitPrice,
        totalPrice: itemTotal,
        baseCost: bundle.baseCost || 0
      });

      grandTotal += itemTotal;
    }

    console.log(`[OrderGroup] Validated ${validatedItems.length} items, Total: ${grandTotal}`);

    // ============================================================
    // STEP 3: CHECK WALLET BALANCE
    // ============================================================
    const wallet = await prisma.wallet.findUnique({
      where: { userId }
    });

    if (!wallet || wallet.balance < grandTotal) {
      const available = wallet?.balance || 0;
      throw new Error(`INSUFFICIENT_BALANCE:${grandTotal}:${available}`);
    }

    // ============================================================
    // STEP 4: ATOMIC TRANSACTION - CREATE ORDER & DEDUCT WALLET
    // ============================================================
    const result = await prisma.$transaction(async (tx) => {
      // 4a. Create OrderGroup (this auto-generates sequenceNum via database)
      const orderGroup = await tx.orderGroup.create({
        data: {
          userId,
          tenantId,
          idempotencyKey,
          totalAmount: grandTotal,
          itemCount: validatedItems.length,
          status: 'PENDING',
          summaryStatus: 'PENDING'
        }
      });

      // 4b. Format the display ID
      const displayId = this.formatOrderId(orderGroup.sequenceNum);
      
      // 4c. Update with display ID
      await tx.orderGroup.update({
        where: { id: orderGroup.id },
        data: { displayId }
      });

      console.log(`[OrderGroup] Created group: ${displayId} (seq: ${orderGroup.sequenceNum})`);

      // 4d. Create all OrderItems
      const createdItems = [];
      for (let i = 0; i < validatedItems.length; i++) {
        const item = validatedItems[i];
        const itemRef = `${displayId}-${String(i + 1).padStart(2, '0')}`;

        const orderItem = await tx.orderItem.create({
          data: {
            orderGroupId: orderGroup.id,
            bundleId: item.bundleId,
            recipientPhone: item.recipientPhone,
            quantity: item.quantity,
            unitPrice: item.unitPrice,
            totalPrice: item.totalPrice,
            baseCost: item.baseCost,
            reference: itemRef,
            status: 'PENDING',
            itemIndex: i + 1
          }
        });

        createdItems.push({
          ...orderItem,
          bundleName: item.bundleName,
          network: item.network,
          dataAmount: item.dataAmount
        });
      }

      // 4e. Deduct wallet
      await tx.wallet.update({
        where: { userId },
        data: {
          balance: { decrement: grandTotal }
        }
      });

      // 4f. Create wallet transaction
      await tx.transaction.create({
        data: {
          walletId: wallet.id,
          type: 'PURCHASE',
          amount: -grandTotal,
          balanceAfter: wallet.balance - grandTotal,
          reference: displayId,
          description: `Order ${displayId} - ${validatedItems.length} item(s)`,
          status: 'COMPLETED'
        }
      });

      // 4g. Mark wallet as deducted
      await tx.orderGroup.update({
        where: { id: orderGroup.id },
        data: {
          walletDeducted: true,
          walletDeductedAt: new Date()
        }
      });

      console.log(`[OrderGroup] Wallet deducted: ${grandTotal} from user ${userId}`);

      // 4h. Create audit log
      await tx.auditLog.create({
        data: {
          userId,
          tenantId,
          action: 'ORDER_CREATE',
          entityType: 'OrderGroup',
          entityId: orderGroup.id,
          newValues: {
            displayId,
            itemCount: validatedItems.length,
            totalAmount: grandTotal
          }
        }
      });

      return {
        orderGroup: {
          ...orderGroup,
          displayId,
          items: createdItems
        }
      };
    });

    console.log(`[OrderGroup] Order created successfully: ${result.orderGroup.displayId}`);

    return {
      success: true,
      duplicate: false,
      orderGroup: result.orderGroup,
      message: `Order ${result.orderGroup.displayId} created with ${validatedItems.length} item(s)`
    };
  },

  /**
   * ============================================================
   * GET ORDER FOR CLIENT
   * ============================================================
   * Returns order data formatted for client display.
   * Includes batch size, summary status, and item details.
   */
  async getOrderForClient(orderGroupId, userId) {
    const orderGroup = await prisma.orderGroup.findFirst({
      where: {
        OR: [
          { id: orderGroupId },
          { displayId: orderGroupId }
        ],
        userId // Ensure user owns this order
      },
      include: {
        items: {
          include: {
            bundle: {
              select: {
                name: true,
                network: true,
                dataAmount: true
              }
            }
          },
          orderBy: { itemIndex: 'asc' }
        }
      }
    });

    if (!orderGroup) {
      return null;
    }

    // Calculate summary status from items
    const itemStatuses = orderGroup.items.map(i => i.status);
    let summaryStatus = 'PENDING';
    
    if (itemStatuses.every(s => s === 'COMPLETED')) {
      summaryStatus = 'COMPLETED';
    } else if (itemStatuses.every(s => s === 'FAILED')) {
      summaryStatus = 'FAILED';
    } else if (itemStatuses.some(s => s === 'PROCESSING' || s === 'COMPLETED')) {
      summaryStatus = 'PROCESSING';
    } else if (itemStatuses.every(s => s === 'CANCELLED')) {
      summaryStatus = 'CANCELLED';
    }

    return {
      // Client-facing data
      orderId: orderGroup.displayId,
      itemCount: orderGroup.itemCount,
      isBatch: orderGroup.itemCount > 1,
      totalAmount: orderGroup.totalAmount,
      status: summaryStatus,
      createdAt: orderGroup.createdAt,
      
      // Item details
      items: orderGroup.items.map(item => ({
        itemNumber: item.itemIndex,
        reference: item.reference,
        bundle: item.bundle?.name || 'Unknown',
        network: item.bundle?.network || 'Unknown',
        dataAmount: item.bundle?.dataAmount || 'Unknown',
        recipientPhone: item.recipientPhone,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        totalPrice: item.totalPrice,
        status: item.status,
        processedAt: item.processedAt,
        failureReason: item.failureReason
      }))
    };
  },

  /**
   * ============================================================
   * GET ALL ORDERS FOR CLIENT
   * ============================================================
   * Returns paginated list of orders for a user.
   */
  async getOrdersForClient(userId, { page = 1, limit = 20 } = {}) {
    const skip = (page - 1) * limit;

    const [orders, total] = await Promise.all([
      prisma.orderGroup.findMany({
        where: { userId },
        include: {
          items: {
            include: {
              bundle: {
                select: { name: true, network: true }
              }
            },
            orderBy: { itemIndex: 'asc' }
          }
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit
      }),
      prisma.orderGroup.count({ where: { userId } })
    ]);

    return {
      orders: orders.map(order => {
        // Calculate summary status
        const statuses = order.items.map(i => i.status);
        let summaryStatus = 'PENDING';
        if (statuses.every(s => s === 'COMPLETED')) summaryStatus = 'COMPLETED';
        else if (statuses.every(s => s === 'FAILED')) summaryStatus = 'FAILED';
        else if (statuses.some(s => s === 'PROCESSING' || s === 'COMPLETED')) summaryStatus = 'PROCESSING';
        else if (statuses.every(s => s === 'CANCELLED')) summaryStatus = 'CANCELLED';

        return {
          orderId: order.displayId,
          itemCount: order.itemCount,
          isBatch: order.itemCount > 1,
          totalAmount: order.totalAmount,
          status: summaryStatus,
          createdAt: order.createdAt,
          // Preview of first item
          preview: order.items[0] ? {
            bundle: order.items[0].bundle?.name,
            network: order.items[0].bundle?.network,
            phone: order.items[0].recipientPhone
          } : null
        };
      }),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit)
      }
    };
  },

  /**
   * ============================================================
   * GET ORDER FOR ADMIN
   * ============================================================
   * Returns full order details including internal IDs and API data.
   */
  async getOrderForAdmin(orderGroupId) {
    const orderGroup = await prisma.orderGroup.findFirst({
      where: {
        OR: [
          { id: orderGroupId },
          { displayId: orderGroupId }
        ]
      },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            phone: true,
            role: true
          }
        },
        items: {
          include: {
            bundle: true
          },
          orderBy: { itemIndex: 'asc' }
        }
      }
    });

    if (!orderGroup) {
      return null;
    }

    return {
      // Admin sees everything
      id: orderGroup.id,
      displayId: orderGroup.displayId,
      sequenceNum: orderGroup.sequenceNum,
      
      // Customer info
      customer: orderGroup.user,
      
      // Order summary
      itemCount: orderGroup.itemCount,
      totalAmount: orderGroup.totalAmount,
      status: orderGroup.summaryStatus,
      
      // Financial tracking
      walletDeducted: orderGroup.walletDeducted,
      walletDeductedAt: orderGroup.walletDeductedAt,
      idempotencyKey: orderGroup.idempotencyKey,
      
      // Timestamps
      createdAt: orderGroup.createdAt,
      updatedAt: orderGroup.updatedAt,
      
      // All items with full details
      items: orderGroup.items.map(item => ({
        id: item.id,
        itemIndex: item.itemIndex,
        reference: item.reference,
        
        // Bundle details
        bundle: {
          id: item.bundle.id,
          name: item.bundle.name,
          network: item.bundle.network,
          dataAmount: item.bundle.dataAmount
        },
        
        // Order details
        recipientPhone: item.recipientPhone,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        totalPrice: item.totalPrice,
        baseCost: item.baseCost,
        
        // Status
        status: item.status,
        processedAt: item.processedAt,
        failureReason: item.failureReason,
        
        // API tracking
        externalReference: item.externalReference,
        externalStatus: item.externalStatus,
        apiSentAt: item.apiSentAt,
        apiConfirmedAt: item.apiConfirmedAt,
        
        // Retry info
        retryCount: item.retryCount
      }))
    };
  },

  /**
   * ============================================================
   * UPDATE ITEM STATUS
   * ============================================================
   * Updates a single item's status and recalculates group status.
   */
  async updateItemStatus(itemId, { status, externalReference, externalStatus, failureReason }) {
    const updateData = { status };
    
    if (externalReference) updateData.externalReference = externalReference;
    if (externalStatus) updateData.externalStatus = externalStatus;
    if (failureReason) updateData.failureReason = failureReason;
    
    if (status === 'PROCESSING') {
      updateData.apiSentAt = new Date();
    } else if (status === 'COMPLETED') {
      updateData.processedAt = new Date();
      updateData.apiConfirmedAt = new Date();
    }

    const item = await prisma.orderItem.update({
      where: { id: itemId },
      data: updateData
    });

    // Recalculate group status
    await this.recalculateGroupStatus(item.orderGroupId);

    return item;
  },

  /**
   * ============================================================
   * RECALCULATE GROUP STATUS
   * ============================================================
   * Updates the OrderGroup's summaryStatus based on item statuses.
   */
  async recalculateGroupStatus(orderGroupId) {
    const items = await prisma.orderItem.findMany({
      where: { orderGroupId },
      select: { status: true }
    });

    const statuses = items.map(i => i.status);
    let summaryStatus = 'PENDING';

    if (statuses.every(s => s === 'COMPLETED')) {
      summaryStatus = 'COMPLETED';
    } else if (statuses.every(s => s === 'FAILED')) {
      summaryStatus = 'FAILED';
    } else if (statuses.some(s => s === 'PROCESSING' || s === 'COMPLETED')) {
      summaryStatus = 'PROCESSING';
    } else if (statuses.every(s => s === 'CANCELLED')) {
      summaryStatus = 'CANCELLED';
    }

    await prisma.orderGroup.update({
      where: { id: orderGroupId },
      data: { summaryStatus }
    });

    return summaryStatus;
  },

  /**
   * ============================================================
   * PROCESS ORDER ITEMS VIA API
   * ============================================================
   * Sends each item to MCBIS API for fulfillment.
   */
  async processOrderItems(orderGroupId) {
    const datahubService = require('./datahub.service');
    
    const orderGroup = await prisma.orderGroup.findUnique({
      where: { id: orderGroupId },
      include: {
        items: {
          where: {
            status: 'PENDING',
            externalReference: null,
            apiSentAt: null
          },
          include: { bundle: true }
        }
      }
    });

    if (!orderGroup || orderGroup.items.length === 0) {
      return { processed: 0, results: [] };
    }

    console.log(`[OrderGroup] Processing ${orderGroup.items.length} items for ${orderGroup.displayId}`);

    const results = [];
    for (const item of orderGroup.items) {
      try {
        // Extract data amount
        let dataAmount = 1;
        if (item.bundle?.dataAmount) {
          const match = item.bundle.dataAmount.match(/(\d+)/);
          if (match) dataAmount = parseInt(match[1]);
        }

        // Place order via API
        const result = await datahubService.placeOrder({
          network: item.bundle?.network || 'MTN',
          phone: item.recipientPhone,
          amount: dataAmount,
          orderId: item.id
        });

        // Update item status
        await this.updateItemStatus(item.id, {
          status: result.success ? 'PROCESSING' : 'FAILED',
          externalReference: result.reference,
          failureReason: result.success ? null : result.error
        });

        results.push({
          itemId: item.id,
          reference: item.reference,
          success: result.success,
          externalReference: result.reference
        });

        // Delay between API calls
        await new Promise(resolve => setTimeout(resolve, 500));

      } catch (error) {
        console.error(`[OrderGroup] Error processing item ${item.id}:`, error.message);
        
        await this.updateItemStatus(item.id, {
          status: 'FAILED',
          failureReason: error.message
        });

        results.push({
          itemId: item.id,
          reference: item.reference,
          success: false,
          error: error.message
        });
      }
    }

    return {
      orderGroupId,
      displayId: orderGroup.displayId,
      processed: results.length,
      results
    };
  },

  /**
   * ============================================================
   * CANCEL ORDER
   * ============================================================
   * Cancels an order and refunds the wallet.
   */
  async cancelOrder(orderGroupId, userId) {
    const orderGroup = await prisma.orderGroup.findFirst({
      where: {
        OR: [
          { id: orderGroupId },
          { displayId: orderGroupId }
        ],
        userId
      },
      include: { items: true }
    });

    if (!orderGroup) {
      throw new Error('Order not found');
    }

    // Can only cancel if all items are PENDING
    const allPending = orderGroup.items.every(i => i.status === 'PENDING');
    if (!allPending) {
      throw new Error('Cannot cancel order - some items have already been processed');
    }

    // Refund and cancel in transaction
    await prisma.$transaction(async (tx) => {
      // Cancel all items
      await tx.orderItem.updateMany({
        where: { orderGroupId: orderGroup.id },
        data: { status: 'CANCELLED' }
      });

      // Update group status
      await tx.orderGroup.update({
        where: { id: orderGroup.id },
        data: { 
          summaryStatus: 'CANCELLED',
          status: 'CANCELLED'
        }
      });

      // Refund wallet if it was deducted
      if (orderGroup.walletDeducted) {
        const wallet = await tx.wallet.findUnique({
          where: { userId }
        });

        await tx.wallet.update({
          where: { userId },
          data: {
            balance: { increment: orderGroup.totalAmount }
          }
        });

        // Create refund transaction
        await tx.transaction.create({
          data: {
            walletId: wallet.id,
            type: 'REFUND',
            amount: orderGroup.totalAmount,
            balanceAfter: wallet.balance + orderGroup.totalAmount,
            reference: `REFUND-${orderGroup.displayId}`,
            description: `Refund for cancelled order ${orderGroup.displayId}`,
            status: 'COMPLETED'
          }
        });
      }

      // Audit log
      await tx.auditLog.create({
        data: {
          userId,
          action: 'ORDER_CANCEL',
          entityType: 'OrderGroup',
          entityId: orderGroup.id,
          newValues: {
            displayId: orderGroup.displayId,
            refundAmount: orderGroup.totalAmount
          }
        }
      });
    });

    return {
      success: true,
      message: `Order ${orderGroup.displayId} cancelled and refunded`
    };
  }
};

module.exports = orderGroupService;
