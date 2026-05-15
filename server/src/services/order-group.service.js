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

const prisma = require('../lib/prisma');
const walletService = require('./wallet.service');

// TopUpGH batch queue — lazy-loaded to avoid circular deps at startup
let topupghBatchService = null;
function getTopUpGHBatchService() {
  if (!topupghBatchService) {
    try { topupghBatchService = require('./topupgh-batch.service'); } catch (e) { /* not available */ }
  }
  return topupghBatchService;
}

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
    // STEP 1: CHECK FOR DUPLICATE (Idempotency Key)
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
    // STEP 1.5: CHECK FOR POTENTIAL DUPLICATE ORDER (Same bundle+phone within 10 min)
    // This prevents accidental double orders
    // ============================================================
    const DUPLICATE_WINDOW_MINUTES = 10;
    const duplicateCheckTime = new Date(Date.now() - DUPLICATE_WINDOW_MINUTES * 60 * 1000);
    
    const potentialDuplicates = [];
    for (const item of items) {
      // Check if same user ordered same bundle for same phone recently
      const recentOrder = await prisma.orderItem.findFirst({
        where: {
          bundleId: item.bundleId,
          recipientPhone: item.recipientPhone,
          orderGroup: {
            userId: userId,
            createdAt: { gte: duplicateCheckTime }
          },
          status: { notIn: ['CANCELLED', 'FAILED'] } // Ignore cancelled/failed orders
        },
        include: {
          orderGroup: { select: { displayId: true, createdAt: true } },
          bundle: { select: { name: true } }
        },
        orderBy: { orderGroup: { createdAt: 'desc' } }
      });
      
      if (recentOrder) {
        potentialDuplicates.push({
          bundleId: item.bundleId,
          recipientPhone: item.recipientPhone,
          bundleName: recentOrder.bundle?.name || 'Unknown',
          existingOrderId: recentOrder.orderGroup.displayId,
          existingOrderTime: recentOrder.orderGroup.createdAt
        });
      }
    }
    
    // If potential duplicates found, flag this for DUPLICATE_HOLD
    const hasPotentialDuplicates = potentialDuplicates.length > 0;
    if (hasPotentialDuplicates) {
      console.log(`[OrderGroup] ⚠️ POTENTIAL DUPLICATE detected for ${potentialDuplicates.length} item(s)`);
      potentialDuplicates.forEach(dup => {
        console.log(`[OrderGroup]   - ${dup.bundleName} → ${dup.recipientPhone} (existing: ${dup.existingOrderId})`);
      });
    }

    // ============================================================
    // STEP 2: VALIDATE ALL ITEMS & CALCULATE TOTALS
    // ============================================================
    const validatedItems = [];
    let grandTotal = 0;

    for (const item of items) {
      if (!item.bundleId) throw new Error('bundleId is required for each item');
      if (!item.recipientPhone) throw new Error('recipientPhone is required for each item');

      // Get bundle with pricing (include prices like order.controller.js)
      const bundle = await prisma.bundle.findUnique({
        where: { id: item.bundleId },
        include: { prices: true }
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

      // Get price for user's role from bundle's prices array
      const rolePrice = bundle.prices.find(p => p.role === user.role);

      const unitPrice = rolePrice?.price || bundle.basePrice;
      const quantity = item.quantity || 1;
      const itemTotal = Number((unitPrice * quantity).toFixed(2));

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

    // Round final grandTotal to avoid floating point accumulation
    grandTotal = Number(grandTotal.toFixed(2));

    console.log(`[OrderGroup] Validated ${validatedItems.length} items, Total: ${grandTotal}`);

    // Determine order status based on duplicate detection
    const orderStatus = hasPotentialDuplicates ? 'DUPLICATE_HOLD' : 'PENDING';
    if (hasPotentialDuplicates) {
      console.log(`[OrderGroup] ⚠️ DUPLICATE_HOLD: Found ${potentialDuplicates.length} potential duplicate(s) - order will be held for admin review`);
    }

    // ============================================================
    // STEP 3: ATOMIC TRANSACTION - CHECK BALANCE & CREATE ORDER
    // Balance check MUST be inside transaction to prevent race conditions
    // ============================================================
    const result = await prisma.$transaction(async (tx) => {
      // 3a. Check wallet balance INSIDE transaction (prevents race condition)
      const wallet = await tx.wallet.findUnique({
        where: { userId }
      });

      if (!wallet) {
        throw new Error('WALLET_NOT_FOUND');
      }

      if (wallet.isFrozen) {
        throw new Error('WALLET_FROZEN');
      }

      // Round both values to 2 decimal places to avoid floating point precision issues
      // e.g., 4.1999999999 should be treated as 4.20
      const availableBalance = Math.round((wallet.balance || 0) * 100) / 100;
      const requiredAmount = Math.round(grandTotal * 100) / 100;
      
      if (!wallet || availableBalance < requiredAmount) {
        throw new Error(`INSUFFICIENT_BALANCE:${requiredAmount}:${availableBalance}`);
      }
      // 4a. Create OrderGroup (this auto-generates sequenceNum via database)
      const orderGroup = await tx.orderGroup.create({
        data: {
          userId,
          tenantId,
          idempotencyKey,
          totalAmount: grandTotal,
          itemCount: validatedItems.length,
          status: orderStatus,
          summaryStatus: orderStatus
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
            status: orderStatus,
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
      // Use GREATEST(0, balance - amount) via raw SQL to guard against
      // floating point precision producing infinitesimally negative balances
      // which violate the wallet_balance_non_negative DB constraint.
      const deductAmount = Math.round(grandTotal * 100) / 100;
      await tx.$executeRaw`UPDATE "wallets" SET balance = GREATEST(0, ROUND((balance - ${deductAmount})::numeric, 10)), "updatedAt" = NOW() WHERE "userId" = ${userId}`;

      // 4f. Create wallet transaction
      await tx.transaction.create({
        data: {
          walletId: wallet.id,
          type: 'PURCHASE',
          amount: -grandTotal,
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

    // ============================================================
    // ETOPUP QUEUE: Route MTN items to the Etopup batch queue
    // Only when:
    //   1. No duplicate hold
    //   2. etopupAPI + etopup_mtnAPI are both enabled
    //   3. No other provider (MCBIS / CKGodsway) already handles MTN
    //      — existing providers take priority; Etopup is the fallback
    // ============================================================
    if (!hasPotentialDuplicates) {
      let etopupEnabled = true;
      let etopupMtnEnabled = true;
      let otherProviderHandlesMtn = false;
      try {
        const sc = require('../controllers/settings.controller');
        const ss = sc && sc.getSiteSettings ? sc.getSiteSettings() : {};
        if (ss.etopupAPI === false) etopupEnabled = false;
        if (ss.etopup_mtnAPI === false) etopupMtnEnabled = false;
        // Check if MCBIS or CKGodsway is handling MTN — they take priority
        const mcbisHandlesMtn = ss.mcbisAPI === true && ss.mcbis_mtnAPI !== false;
        const ckgHandlesMtn   = ss.ckgodswayAPI === true && ss.ckgodsway_mtnAPI !== false;
        if (mcbisHandlesMtn || ckgHandlesMtn) otherProviderHandlesMtn = true;
      } catch (e) { /* settings not available, default to enabled */ }

      if (etopupEnabled && etopupMtnEnabled && !otherProviderHandlesMtn) {
        const batchSvc = getTopUpGHBatchService();
        if (batchSvc) {
          const mtnItems = result.orderGroup.items.filter(
            i => (i.network || '').toLowerCase() === 'mtn'
          );
          for (const item of mtnItems) {
            batchSvc.queueItem(item.id).catch(err =>
              console.error(`[OrderGroup] Failed to queue item ${item.id} for Etopup:`, err.message)
            );
          }
          if (mtnItems.length > 0) {
            console.log(`[OrderGroup] Queued ${mtnItems.length} MTN item(s) for Etopup`);
          }
        }
      } else {
        if (otherProviderHandlesMtn) {
          console.log(`[OrderGroup] Etopup MTN queueing skipped — MCBIS/CKGodsway handles MTN`);
        } else {
          console.log(`[OrderGroup] Etopup MTN queueing skipped (etopupAPI=${etopupEnabled}, etopup_mtnAPI=${etopupMtnEnabled})`);
        }
      }
    }

    // Build response with duplicate info if applicable
    const response = {
      success: true,
      duplicate: false,
      orderGroup: result.orderGroup,
      message: `Order ${result.orderGroup.displayId} created with ${validatedItems.length} item(s)`
    };

    // Add duplicate warning info if order is held
    if (hasPotentialDuplicates) {
      response.duplicateHold = true;
      response.duplicateInfo = potentialDuplicates;
      response.message = `Order ${result.orderGroup.displayId} created but HELD for admin review - potential duplicate detected (${potentialDuplicates.length} similar order(s) in last 10 minutes)`;
    }

    return response;
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
   * Combines new OrderGroup orders with legacy Order table for backwards compatibility.
   */
  async getOrdersForClient(userId, { page = 1, limit = 20 } = {}) {
    const skip = (page - 1) * limit;

    // Fetch OrderGroups first to get displayIds to exclude from legacy orders
    const orderGroups = await prisma.orderGroup.findMany({
      where: { userId },
      include: {
        items: {
          include: {
            bundle: {
              select: { name: true, network: true, dataAmount: true }
            }
          },
          orderBy: { itemIndex: 'asc' }
        }
      },
      orderBy: { createdAt: 'desc' }
    });

    // Get all displayIds from OrderGroups to exclude from legacy query
    const orderGroupDisplayIds = orderGroups.map(og => og.displayId).filter(Boolean);

    // Fetch legacy Orders that are NOT linked to OrderGroups
    // Exclude orders where reference matches an OrderGroup displayId (prevents duplicates)
    const legacyOrders = await prisma.order.findMany({
      where: { 
        userId,
        // Exclude orders that have a storefrontOrderId (they're shown via OrderGroup)
        storefrontOrderId: null,
        // Also exclude orders whose reference matches an OrderGroup displayId
        NOT: orderGroupDisplayIds.length > 0 ? {
          reference: { in: orderGroupDisplayIds }
        } : undefined
      },
      include: {
        bundle: {
          select: { name: true, network: true, dataAmount: true }
        }
      },
      orderBy: { createdAt: 'desc' }
    });

    // Convert OrderGroups to standard format
    const formattedOrderGroups = orderGroups.map(order => {
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
        updatedAt: order.updatedAt,
        isLegacy: false,
        items: order.items.map(item => ({
          id: item.id,
          reference: item.reference,
          recipientPhone: item.recipientPhone,
          price: item.totalPrice || item.unitPrice || 0,
          unitPrice: item.unitPrice,
          totalPrice: item.totalPrice,
          status: item.status,
          bundle: item.bundle?.name || 'Unknown',
          network: item.bundle?.network || 'MTN',
          dataAmount: item.bundle?.dataAmount || '',
          failureReason: item.failureReason,
          updatedAt: item.updatedAt
        })),
        preview: order.items[0] ? {
          bundle: order.items[0].bundle?.name,
          network: order.items[0].bundle?.network,
          phone: order.items[0].recipientPhone
        } : null
      };
    });

    // Convert legacy Orders to standard format (each order = single item group)
    const formattedLegacyOrders = legacyOrders.map(order => ({
      orderId: order.reference,
      itemCount: 1,
      isBatch: false,
      totalAmount: order.totalPrice || 0,
      status: order.status,
      createdAt: order.createdAt,
      updatedAt: order.updatedAt,
      isLegacy: true,
      items: [{
        id: order.id,
        reference: order.reference,
        recipientPhone: order.recipientPhone,
        price: order.totalPrice || order.unitPrice || 0,
        unitPrice: order.unitPrice,
        totalPrice: order.totalPrice,
        status: order.status,
        bundle: order.bundle?.name || 'Unknown',
        network: order.bundle?.network || 'MTN',
        dataAmount: order.bundle?.dataAmount || '',
        failureReason: order.failureReason,
        updatedAt: order.updatedAt
      }],
      preview: {
        bundle: order.bundle?.name,
        network: order.bundle?.network,
        phone: order.recipientPhone
      }
    }));

    // Combine and sort by date (newest first)
    const allOrders = [...formattedOrderGroups, ...formattedLegacyOrders]
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    // Apply pagination to combined list
    const total = allOrders.length;
    const paginatedOrders = allOrders.slice(skip, skip + limit);

    return {
      orders: paginatedOrders,
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
            role: true,
            agentCode: true
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
   * Sends each PENDING item to external API for fulfillment.
   * 
   * Per-network routing:
   * - Each item's network finds the first enabled provider
   * - ckgodswayAPI + ckgodsway_{network}API → CK-Godsway
   * - mcbisAPI + mcbis_{network}API → MCBIS
   * - No provider found → Order stays PENDING
   * 
   * Rules:
   * - Only processes PENDING items (not PROCESSING, COMPLETED, etc.)
   * - Checks network-specific toggle (mtnAPI, telecelAPI, airteltigoAPI)
   * - Checks API wallet balance BEFORE each item
   * - Items stay PENDING if API disabled or insufficient balance
   */
  async processOrderItems(orderGroupId) {
    const datahubService = require('./datahub.service');
    const ckgodswayService = require('./ckgodsway.service');
    const settingsController = require('../controllers/settings.controller');
    const fs = require('fs');
    const path = require('path');
    
    // Helper to get site settings - USE CACHE from settingsController
    const getSiteSettings = () => {
      // Try settingsController cache first (most reliable)
      if (settingsController && settingsController.getSiteSettings) {
        const settings = settingsController.getSiteSettings();
        console.log(`[OrderGroup] Settings from cache:`, JSON.stringify(settings));
        return settings;
      }
      // Fallback to file
      try {
        const settingsPath = path.join(__dirname, '../../settings.json');
        const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        console.log(`[OrderGroup] Settings from file:`, JSON.stringify(settings.siteSettings));
        return settings.siteSettings || {};
      } catch (e) {
        console.log(`[OrderGroup] Settings error:`, e.message);
        return {};
      }
    };
    
    // Determine which API provider to use
    // Per-network routing: each network finds the first enabled provider that supports it
    const isTruthy = (val) => val === true || val === 'true' || val === 1;
    
    const PROVIDERS = [
      { key: 'ckgodswayAPI', name: 'CKGODSWAY', prefix: 'ckgodsway', service: ckgodswayService },
      { key: 'mcbisAPI', name: 'MCBIS', prefix: 'mcbis', service: datahubService }
    ];
    
    const getNetworkToggleKey = (prefix, network) => {
      const n = (network || '').toLowerCase().replace(/\s+/g, '');
      if (n === 'mtn') return `${prefix}_mtnAPI`;
      if (n === 'telecel' || n === 'vodafone') return `${prefix}_telecelAPI`;
      if (n === 'airteltigo' || n === 'at') return `${prefix}_airteltigoAPI`;
      if (n === 'at-bigtime' || n === 'atbigtime' || n === 'at-big time' || n.includes('big time') || n.includes('bigtime')) return `${prefix}_bigtimeAPI`;
      return null;
    };
    
    const getProviderForNetwork = (network, siteSettings) => {
      for (const p of PROVIDERS) {
        if (!isTruthy(siteSettings[p.key])) continue;
        const toggleKey = getNetworkToggleKey(p.prefix, network);
        if (toggleKey) {
          const enabled = siteSettings[toggleKey] !== false;
          if (!enabled) {
            console.log(`[OrderGroup] ${p.name}: ${network} disabled (${toggleKey}=${siteSettings[toggleKey]})`);
            continue;
          }
        }
        console.log(`[OrderGroup] ${network} → ${p.name}`);
        return { name: p.name, service: p.service };
      }
      console.log(`[OrderGroup] No provider found for ${network}`);
      return null;
    };
    
    const orderGroup = await prisma.orderGroup.findUnique({
      where: { id: orderGroupId },
      include: {
        items: {
          where: {
            status: 'PENDING' // Only process PENDING items
          },
          include: { bundle: true }
        }
      }
    });

    if (!orderGroup || orderGroup.items.length === 0) {
      console.log(`[OrderGroup] No PENDING items to process for ${orderGroupId}`);
      return { processed: 0, skipped: 0, results: [] };
    }

    console.log(`[OrderGroup] Processing ${orderGroup.items.length} PENDING items for ${orderGroup.displayId}`);

    const siteSettings = getSiteSettings();
    const results = [];
    let skipped = 0;
    
    // Track balances per provider (fetched on first use)
    const providerBalances = {};
    
    async function getProviderBalance(providerName, service) {
      if (providerBalances[providerName] !== undefined) return providerBalances[providerName];
      
      if (providerName === 'CKGODSWAY') {
        // CK-Godsway has no balance endpoint - bypass check
        providerBalances[providerName] = Infinity;
        console.log(`[OrderGroup] CK-Godsway: No balance endpoint, skipping balance check`);
      } else if (providerName === 'MCBIS') {
        try {
          const balanceResult = await service.getWalletBalance();
          providerBalances[providerName] = balanceResult.success ? balanceResult.balance : Infinity;
          console.log(`[OrderGroup] MCBIS wallet balance: ${providerBalances[providerName]} GHS`);
        } catch (e) {
          // If balance check fails, proceed anyway — let placeOrder fail naturally
          providerBalances[providerName] = Infinity;
          console.log(`[OrderGroup] Could not fetch MCBIS balance (proceeding anyway): ${e.message}`);
        }
      } else {
        providerBalances[providerName] = Infinity;
      }
      return providerBalances[providerName];
    }

    for (const item of orderGroup.items) {
      const network = item.bundle?.network || 'MTN';
      
      // DUPLICATE PREVENTION CHECK 1: Already has externalReference (sent to API before)
      if (item.externalReference) {
        console.log(`[OrderGroup] SKIP DUPLICATE: ${item.reference} already has externalReference: ${item.externalReference}`);
        skipped++;
        results.push({
          itemId: item.id,
          reference: item.reference,
          skipped: true,
          reason: 'Already sent to API (has externalReference)'
        });
        continue;
      }
      
      // DUPLICATE PREVENTION CHECK 2: apiSentAt is set (attempted before)
      if (item.apiSentAt) {
        console.log(`[OrderGroup] SKIP DUPLICATE: ${item.reference} has apiSentAt: ${item.apiSentAt}`);
        skipped++;
        results.push({
          itemId: item.id,
          reference: item.reference,
          skipped: true,
          reason: 'Already attempted (has apiSentAt)'
        });
        continue;
      }
      
      // DUPLICATE PREVENTION CHECK 3: Re-fetch fresh status (race condition protection)
      const freshItem = await prisma.orderItem.findUnique({ where: { id: item.id } });
      if (freshItem.status !== 'PENDING') {
        console.log(`[OrderGroup] SKIP: ${item.reference} status changed to ${freshItem.status}`);
        skipped++;
        results.push({
          itemId: item.id,
          reference: item.reference,
          skipped: true,
          reason: `Status is ${freshItem.status}, not PENDING`
        });
        continue;
      }
      
      // Check 4: Find the right API provider for this item's network
      const provider = getProviderForNetwork(network, siteSettings);
      if (!provider) {
        console.log(`[OrderGroup] Skipping ${item.reference}: No provider enabled for ${network}`);
        skipped++;
        results.push({
          itemId: item.id,
          reference: item.reference,
          skipped: true,
          reason: `No API provider enabled for ${network}`
        });
        continue;
      }
      
      const apiProvider = provider.name;
      const apiService = provider.service;
      
      // Check 2: Extract data amount and estimate cost
      let dataAmount = 1;
      if (item.bundle?.dataAmount) {
        const match = item.bundle.dataAmount.match(/(\d+)/);
        if (match) dataAmount = parseInt(match[1]);
      }
      
      // Estimate cost (rough estimate: ~3.9 GHS per 1GB for MTN)
      const estimatedCost = item.baseCost || (dataAmount * 3.9);
      
      // Check 3: Is API balance sufficient?
      const apiBalance = await getProviderBalance(apiProvider, apiService);
      if (apiBalance < estimatedCost) {
        console.log(`[OrderGroup] Skipping ${item.reference}: Insufficient ${apiProvider} balance (need ${estimatedCost}, have ${apiBalance})`);
        skipped++;
        results.push({
          itemId: item.id,
          reference: item.reference,
          skipped: true,
          reason: `Insufficient ${apiProvider} balance (need ${estimatedCost}, have ${apiBalance})`
        });
        continue;
      }

      try {
        // ============ ATOMIC LOCK: Claim this item BEFORE calling API ============
        // This prevents race conditions where two requests try to process same item
        const claimResult = await prisma.orderItem.updateMany({
          where: {
            id: item.id,
            apiSentAt: null,  // Only claim if not already claimed!
            status: 'PENDING'
          },
          data: {
            apiSentAt: new Date()  // Mark as claimed
          }
        });
        
        // If count is 0, another request already claimed this item
        if (claimResult.count === 0) {
          console.log(`[OrderGroup] ATOMIC LOCK: ${item.reference} already claimed by another request`);
          skipped++;
          results.push({
            itemId: item.id,
            reference: item.reference,
            skipped: true,
            reason: 'Already being processed (atomic lock)'
          });
          continue;
        }
        
        console.log(`[OrderGroup] ATOMIC LOCK: Claimed ${item.reference} for processing`);
        
        // Place order via selected API provider
        const result = await apiService.placeOrder({
          network: network,
          phone: item.recipientPhone,
          amount: dataAmount,
          orderId: item.id
        });

        // Check for insufficient balance returned as a non-throwing failure
        if (!result.success && result.error && result.error.includes('Insufficient balance')) {
          console.log(`[OrderGroup] ${apiProvider} insufficient balance for ${item.reference}: ${result.error}`);
          providerBalances[apiProvider] = 0;
          // Reset apiSentAt so auto-retry can pick it up
          await prisma.orderItem.update({ where: { id: item.id }, data: { apiSentAt: null } });
          skipped++;
          results.push({
            itemId: item.id,
            reference: item.reference,
            skipped: true,
            reason: `${apiProvider} insufficient balance — will auto-retry`
          });
          continue;
        }

        // ============ NETWORK ERROR: MARK PROCESSING, LET AUTO-SYNC VERIFY ============
        // If we got a network/timeout error, MCBIS may have already received and processed
        // the order despite no response. Store the reference and mark PROCESSING so that
        // auto-sync (syncOrderItemStatus) checks the real status each minute.
        // This avoids hammering MCBIS with immediate status checks (rate limiting).
        // Auto-sync will mark FAILED if MCBIS returns 404 (never received).
        if (!result.success && result.networkError && result.reference && apiProvider === 'MCBIS') {
          console.log(`[OrderGroup] Network error for ${item.reference} — storing ref ${result.reference}, marking PROCESSING for auto-sync`);
          await this.updateItemStatus(item.id, {
            status: 'PROCESSING',
            externalReference: result.reference,
            failureReason: null
          });
        } else {
          // Update item status based on result
          // Only pass externalReference on success — on failure it stays null
          // so the retry button shows in the admin UI
          await this.updateItemStatus(item.id, {
            status: result.success ? 'PROCESSING' : 'FAILED',
            externalReference: result.success ? result.reference : undefined,
            failureReason: result.success ? null : result.error
          });
        }

        results.push({
          itemId: item.id,
          reference: item.reference,
          success: result.success,
          externalReference: result.reference,
          provider: apiProvider
        });
        
        // Deduct estimated cost from balance tracker (or use new_balance from API)
        if (result.success) {
          if (result.newBalance !== undefined) {
            providerBalances[apiProvider] = result.newBalance;
          } else {
            providerBalances[apiProvider] = (providerBalances[apiProvider] || 0) - estimatedCost;
          }
        }

        // Delay between API calls
        await new Promise(resolve => setTimeout(resolve, 500));

      } catch (error) {
        console.error(`[OrderGroup] Error processing item ${item.id}:`, error.message);
        
        // Check if it's an insufficient balance error from API
        if (error.message.includes('Insufficient') || error.message.includes('balance')) {
          console.log(`[OrderGroup] ${apiProvider} balance depleted, keeping item PENDING for retry`);
          providerBalances[apiProvider] = 0;
          // Reset apiSentAt so auto-retry can pick it up
          await prisma.orderItem.update({ where: { id: item.id }, data: { apiSentAt: null } }).catch(() => {});
          skipped++;
          results.push({
            itemId: item.id,
            reference: item.reference,
            skipped: true,
            reason: `${apiProvider} insufficient balance — will auto-retry`
          });
          continue;
        }
        
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

    console.log(`[OrderGroup] Processed: ${results.filter(r => !r.skipped).length}, Skipped: ${skipped}`);

    return {
      orderGroupId,
      displayId: orderGroup.displayId,
      processed: results.filter(r => !r.skipped).length,
      skipped,
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

    // Refund wallet via walletService (writes to walletLedger, idempotent, always COMPLETED)
    if (orderGroup.walletDeducted) {
      try {
        await walletService.creditWallet(
          userId,
          orderGroup.totalAmount,
          `Refund for cancelled order ${orderGroup.displayId}`,
          `REFUND-${orderGroup.displayId}`,
          { entryType: 'REFUND', orderId: orderGroup.id }
        );
      } catch (refundErr) {
        if (refundErr.message !== 'Duplicate transaction reference') {
          console.error(`[OrderGroup] Refund failed for order ${orderGroup.displayId}:`, refundErr.message);
        }
      }
    }

    return {
      success: true,
      message: `Order ${orderGroup.displayId} cancelled and refunded`
    };
  },

  /**
   * ============================================================
   * SYNC ORDER ITEM STATUS FROM EXTERNAL API
   * ============================================================
   * Checks the status of an OrderItem from MCBIS or CK-Godsway API
   * and updates the local status accordingly.
   */
  async syncOrderItemStatus(itemId) {
    const item = await prisma.orderItem.findUnique({
      where: { id: itemId },
      include: { orderGroup: true }
    });

    if (!item) {
      return { success: false, error: 'OrderItem not found' };
    }

    if (!item.externalReference) {
      return { success: false, error: 'No external reference - order not sent to API yet' };
    }

    console.log(`[Sync] Checking status for item ${item.reference}, externalRef: ${item.externalReference}`);

    // Determine which API to check based on the reference prefix
    let apiResult;
    try {
      const ref = item.externalReference || '';
      const datahubService = require('./datahub.service');
      const ckgodswayService = require('./ckgodsway.service');
      
      if (ref.startsWith('CK-')) {
        // CK-Godsway order
        const ckResult = await ckgodswayService.checkOrderStatus(ref);
        apiResult = ckResult.success
          ? { success: true, status: ckResult.status, provider: 'CKGODSWAY' }
          : { success: false, error: ckResult.error };
      } else {
        // Default: MCBIS (legacy orders without prefix, or KEM- prefix)
        const mcbisResult = await datahubService.checkOrderStatus(ref);
        if (mcbisResult.success) {
          const s = (mcbisResult.status || '').toLowerCase();
          if (s === 'unknown') {
            // MCBIS returned 404 — reference never received, safe to mark FAILED
            console.log(`[Sync] MCBIS 404 for ${ref} — order never received, will mark FAILED`);
            apiResult = { success: true, status: 'failed', provider: 'MCBIS', notReceived: true };
          } else {
            apiResult = { success: true, status: s, provider: 'MCBIS' };
          }
        } else {
          // Network error reaching MCBIS — don't change status, try again next cycle
          apiResult = { success: false, error: mcbisResult.error || 'MCBIS unreachable' };
        }
      }
    } catch (error) {
      console.error(`[Sync] API check failed:`, error.message);
      return { success: false, error: error.message };
    }

    if (!apiResult.success) {
      return { success: false, error: apiResult.error || 'API check failed' };
    }

    console.log(`[Sync] API returned status: ${apiResult.status} (provider: ${apiResult.provider})`);

    // Map external status to our status
    let newStatus = item.status;
    const externalStatus = (apiResult.status || '').toLowerCase();
    
    if (externalStatus === 'success' || externalStatus === 'completed' || externalStatus === 'delivered') {
      newStatus = 'COMPLETED';
    } else if (externalStatus === 'failed' || externalStatus === 'error' || externalStatus === 'rejected') {
      newStatus = 'FAILED';
    } else if (externalStatus === 'pending' || externalStatus === 'processing' || externalStatus === 'queued') {
      newStatus = 'PROCESSING';
    }

    // PREVENT STATUS DOWNGRADES - never revert manually completed/failed orders
    const statusPriority = { 'PENDING': 1, 'PROCESSING': 2, 'COMPLETED': 3, 'FAILED': 3, 'CANCELLED': 3 };
    const currentPriority = statusPriority[item.status] || 0;
    const newPriority = statusPriority[newStatus] || 0;
    
    if (newPriority < currentPriority) {
      console.log(`[Sync] ⚠️ Skipping downgrade: ${item.status} → ${newStatus} (manual override preserved)`);
      return { success: true, itemId, previousStatus: item.status, newStatus: item.status, statusChanged: false, message: 'Manual override preserved' };
    }

    const statusChanged = newStatus !== item.status;
    
    if (statusChanged) {
      console.log(`[Sync] Status change: ${item.status} → ${newStatus}`);

      // Set a clear failureReason so admin knows whether it's safe to re-send
      let failureReason = undefined;
      if (newStatus === 'FAILED') {
        failureReason = apiResult.notReceived
          ? 'MCBIS 404 - order never received by provider (safe to re-send)'
          : `Provider reported failure: ${apiResult.status}`;
      }
      
      await prisma.orderItem.update({
        where: { id: itemId },
        data: {
          status: newStatus,
          externalStatus: apiResult.status,
          ...(newStatus === 'COMPLETED' ? { apiConfirmedAt: new Date() } : {}),
          ...(failureReason !== undefined ? { failureReason } : { failureReason: null })
        }
      });

      // Update OrderGroup summary status
      await this.recalculateGroupStatus(item.orderGroupId);

      // If COMPLETED, cascade to Order + StorefrontOrder + credit profit
      if (newStatus === 'COMPLETED') {
        try {
          // Find linked Order by reference prefix (item ref = "ORD-XXXX-01", order ref = "ORD-XXXX")
          const orderRef = item.reference.replace(/-\d+$/, '');
          const linkedOrder = await prisma.order.findFirst({
            where: { reference: orderRef }
          });
          if (linkedOrder) {
            // Sync Order status
            if (linkedOrder.status !== 'COMPLETED') {
              await prisma.order.update({
                where: { id: linkedOrder.id },
                data: { status: 'COMPLETED', apiConfirmedAt: new Date() }
              });
              console.log(`[Sync] ✅ Order ${orderRef} synced to COMPLETED`);
            }
            // Sync StorefrontOrder + credit profit
            if (linkedOrder.storefrontOrderId) {
              const financialOrderService = require('./financial-order.service');
              const profitResult = await financialOrderService.processCompletedStorefrontOrder(linkedOrder.id);
              if (profitResult.credited) {
                console.log(`[Sync] ✅ Agent profit credited: GHS ${profitResult.amount}`);
              }
            }
          }
        } catch (err) {
          console.error(`[Sync] Failed to cascade completion for item ${item.reference}:`, err.message);
        }
      }
    }

    return {
      success: true,
      itemId,
      previousStatus: item.status,
      newStatus,
      externalStatus: apiResult.status,
      statusChanged,
      provider: apiResult.provider
    };
  },

  /**
   * Recalculate OrderGroup summary status based on all items
   */
  async recalculateGroupStatus(orderGroupId) {
    const items = await prisma.orderItem.findMany({
      where: { orderGroupId }
    });

    if (items.length === 0) return;

    const statusCounts = {
      PENDING: 0,
      PROCESSING: 0,
      COMPLETED: 0,
      FAILED: 0,
      CANCELLED: 0
    };

    items.forEach(item => {
      if (statusCounts[item.status] !== undefined) {
        statusCounts[item.status]++;
      }
    });

    let summaryStatus = 'MIXED';
    
    if (statusCounts.COMPLETED === items.length) {
      summaryStatus = 'COMPLETED';
    } else if (statusCounts.FAILED === items.length) {
      summaryStatus = 'FAILED';
    } else if (statusCounts.CANCELLED === items.length) {
      summaryStatus = 'CANCELLED';
    } else if (statusCounts.PENDING === items.length) {
      summaryStatus = 'PENDING';
    } else if (statusCounts.PROCESSING > 0 || statusCounts.PENDING > 0) {
      summaryStatus = 'PROCESSING';
    }

    await prisma.orderGroup.update({
      where: { id: orderGroupId },
      data: { summaryStatus }
    });

    console.log(`[Sync] Updated OrderGroup ${orderGroupId} summaryStatus to ${summaryStatus}`);
  },

  /**
   * Retry stuck PENDING orders that were never sent to API
   * Called by AutoSync when API is re-enabled after being off
   * Only retries orders that:
   * - Have status PENDING
   * - Have NO externalReference (never sent to API)
   * - Are older than 1 minute (to avoid interfering with active orders)
   * - Are newer than 24 hours (don't retry very old orders)
   * Also queues MTN items to Etopup when etopup is enabled and MCBIS/CKGodsway don't handle MTN.
   */
  async retryStuckPendingOrders() {
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    
    // Find stuck PENDING OrderGroups where items were NEVER sent to API
    // CRITICAL: Only pick items with apiSentAt IS NULL — never reset apiSentAt!
    // If apiSentAt is set, the order was already claimed and may be in-flight.
    const stuckOrderGroups = await prisma.orderGroup.findMany({
      where: {
        status: 'PENDING',
        createdAt: {
          gte: twentyFourHoursAgo,  // Not older than 24 hours
          lte: fiveMinutesAgo       // At least 5 minutes old (give instant auto-process time)
        },
        items: {
          some: {
            status: 'PENDING',
            externalReference: null,  // Never sent to API
            apiSentAt: null           // Never even attempted
          }
        }
      },
      select: { id: true, displayId: true },
      take: 20  // Limit to prevent overload
    });

    if (stuckOrderGroups.length === 0) {
      return { retried: 0, message: 'No stuck pending orders found' };
    }

    console.log(`[AutoRetry] Found ${stuckOrderGroups.length} stuck pending order groups to retry`);

    let retriedCount = 0;
    let successCount = 0;
    const results = [];

    for (const orderGroup of stuckOrderGroups) {
      try {
        console.log(`[AutoRetry] Retrying ${orderGroup.displayId}...`);
        
        // DO NOT reset apiSentAt — processOrderItems uses it as an atomic lock.
        // Items with apiSentAt already set will be skipped by processOrderItems (duplicate check #2).
        // We only process items that were genuinely never attempted.
        
        // Process the order items (only PENDING items with apiSentAt=null will be claimed)
        const result = await this.processOrderItems(orderGroup.id);

        // Also queue MTN items to Etopup if etopup handles MTN and MCBIS/CKGodsway don't.
        // processOrderItems skips items when no MCBIS/CKGodsway provider is found — those
        // items stay PENDING and must be routed here instead.
        try {
          const sc = require('../controllers/settings.controller');
          const ss = sc && sc.getSiteSettings ? sc.getSiteSettings() : {};
          const etopupEnabled    = ss.etopupAPI !== false;
          const etopupMtnEnabled = ss.etopup_mtnAPI !== false;
          const mcbisHandlesMtn  = ss.mcbisAPI === true && ss.mcbis_mtnAPI !== false;
          const ckgHandlesMtn    = ss.ckgodswayAPI === true && ss.ckgodsway_mtnAPI !== false;

          if (etopupEnabled && etopupMtnEnabled && !mcbisHandlesMtn && !ckgHandlesMtn) {
            const batchSvc = getTopUpGHBatchService();
            if (batchSvc) {
              // Only pick items that are still PENDING and not yet queued to etopup
              const unqueued = await prisma.orderItem.findMany({
                where: {
                  orderGroupId   : orderGroup.id,
                  status         : 'PENDING',
                  externalReference : null,
                  topupghQueuedAt   : null,
                  apiSentAt         : null
                },
                include: { bundle: { select: { network: true } } }
              });
              const mtnItems = unqueued.filter(
                i => (i.bundle?.network || '').toLowerCase() === 'mtn'
              );
              for (const item of mtnItems) {
                await batchSvc.queueItem(item.id).catch(err =>
                  console.error(`[AutoRetry] Failed to queue item ${item.id} for Etopup:`, err.message)
                );
              }
              if (mtnItems.length > 0) {
                console.log(`[AutoRetry] Queued ${mtnItems.length} MTN item(s) for Etopup from ${orderGroup.displayId}`);
                result.processed += mtnItems.length;
              }
            }
          }
        } catch (e) {
          console.error(`[AutoRetry] Etopup queue error for ${orderGroup.displayId}:`, e.message);
        }

        retriedCount++;
        if (result.processed > 0) {
          successCount++;
        }
        
        results.push({
          displayId: orderGroup.displayId,
          processed: result.processed,
          skipped: result.skipped
        });
        
        // Delay between retries
        await new Promise(resolve => setTimeout(resolve, 1000));
        
      } catch (error) {
        console.error(`[AutoRetry] Error retrying ${orderGroup.displayId}:`, error.message);
        results.push({
          displayId: orderGroup.displayId,
          error: error.message
        });
      }
    }

    console.log(`[AutoRetry] Completed: ${retriedCount} retried, ${successCount} had items processed`);

    return {
      retried: retriedCount,
      success: successCount,
      results
    };
  },

  /**
   * Sync ALL processing/pending OrderItems that have externalReference
   * Call this periodically or via admin action
   * @param {Object} options - Filter options
   * @param {boolean} options.mcbisEnabled - Whether to sync MCBIS orders
   * @param {boolean} options.catchUp - When true: no row cap, oldest-first (use on re-enable)
   */
  async syncAllProcessingItems(options = {}) {
    const { mcbisEnabled = true, ckgodswayEnabled = true, catchUp = false } = options;
    
    console.log(`[Sync] Starting sync of all processing OrderItems... (MCBIS: ${mcbisEnabled ? 'ON' : 'OFF'}, CKGodsway: ${ckgodswayEnabled ? 'ON' : 'OFF'}${catchUp ? ', CATCH-UP mode' : ''})`);
    
    // Fetch each provider's items separately so one provider can't starve the other
    let items = [];

    if (ckgodswayEnabled) {
      const ckQuery = {
        where: {
          status: { in: ['PROCESSING', 'PENDING'] },
          externalReference: { startsWith: 'CK-' }
        },
        orderBy: { createdAt: catchUp ? 'asc' : 'desc' }
      };
      if (!catchUp) ckQuery.take = 50;
      const ckItems = await prisma.orderItem.findMany(ckQuery);
      console.log(`[Sync] CK-Godsway: ${ckItems.length} items to sync`);
      items.push(...ckItems);
    }

    if (mcbisEnabled) {
      const mcbisQuery = {
        where: {
          status: { in: ['PROCESSING', 'PENDING'] },
          externalReference: { not: null },
          NOT: { externalReference: { startsWith: 'CK-' } }
        },
        orderBy: { createdAt: catchUp ? 'asc' : 'desc' }
      };
      if (!catchUp) mcbisQuery.take = 20; // reduced from 50 to limit API call rate
      const mcbisItems = await prisma.orderItem.findMany(mcbisQuery);
      console.log(`[Sync] MCBIS: ${mcbisItems.length} items to sync`);
      items.push(...mcbisItems);
    }

    console.log(`[Sync] Total: ${items.length} items to sync`);

    const results = [];
    let completed = 0;
    let failed = 0;
    let unchanged = 0;

    for (const item of items) {
      try {
        const result = await this.syncOrderItemStatus(item.id);
        results.push({ itemId: item.id, reference: item.reference, ...result });

        // If MCBIS rate-limited us, abort remaining items immediately
        if (!result.success && result.error && result.error.includes('rate-limited')) {
          console.warn(`[Sync] MCBIS rate-limit detected — stopping cycle early after ${results.length} item(s)`);
          break;
        }

        if (result.statusChanged) {
          if (result.newStatus === 'COMPLETED') completed++;
          else if (result.newStatus === 'FAILED') failed++;
        } else {
          unchanged++;
        }
        
        // Delay between calls — 400ms keeps total cycle well under MCBIS rate limits
        await new Promise(resolve => setTimeout(resolve, 400));
      } catch (error) {
        results.push({ itemId: item.id, reference: item.reference, success: false, error: error.message });
      }
    }

    console.log(`[Sync] Complete: ${completed} completed, ${failed} failed, ${unchanged} unchanged`);

    return {
      success: true,
      total: items.length,
      completed,
      failed,
      unchanged,
      results
    };
  }
};

module.exports = orderGroupService;
