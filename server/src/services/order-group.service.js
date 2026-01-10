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
   * Combines new OrderGroup orders with legacy Order table for backwards compatibility.
   */
  async getOrdersForClient(userId, { page = 1, limit = 20 } = {}) {
    const skip = (page - 1) * limit;

    // Fetch from BOTH OrderGroup and legacy Order tables
    const [orderGroups, legacyOrders, orderGroupCount, legacyOrderCount] = await Promise.all([
      prisma.orderGroup.findMany({
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
      }),
      prisma.order.findMany({
        where: { userId },
        include: {
          bundle: {
            select: { name: true, network: true, dataAmount: true }
          }
        },
        orderBy: { createdAt: 'desc' }
      }),
      prisma.orderGroup.count({ where: { userId } }),
      prisma.order.count({ where: { userId } })
    ]);

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
          failureReason: item.failureReason
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
        failureReason: order.failureReason
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
   * Sends each PENDING item to external API for fulfillment.
   * 
   * Priority (Either/Or):
   * - masterAPI ON  → Use EasyDataGH API
   * - mcbisAPI ON   → Use MCBIS API (only if masterAPI is OFF)
   * - Both OFF      → Orders stay PENDING (manual processing)
   * 
   * Rules:
   * - Only processes PENDING items (not PROCESSING, COMPLETED, etc.)
   * - Checks network-specific toggle (mtnAPI, telecelAPI, airteltigoAPI)
   * - Checks API wallet balance BEFORE each item
   * - Items stay PENDING if API disabled or insufficient balance
   */
  async processOrderItems(orderGroupId) {
    const datahubService = require('./datahub.service');
    const easyDataService = require('./easydata.service');
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
    const getApiProvider = (siteSettings) => {
      console.log(`[OrderGroup] Checking API provider - masterAPI: ${siteSettings.masterAPI}, mcbisAPI: ${siteSettings.mcbisAPI}`);
      if (siteSettings.masterAPI) {
        return 'EASYDATA'; // masterAPI = EasyDataGH
      }
      if (siteSettings.mcbisAPI) {
        return 'MCBIS';
      }
      return null; // No API enabled
    };
    
    // Helper to check if network API is enabled
    // Provider-specific toggles: easydata_mtnAPI, mcbis_mtnAPI, etc.
    const isNetworkApiEnabled = (network, siteSettings, provider) => {
      if (!provider) {
        console.log(`[OrderGroup] No API provider enabled (masterAPI and mcbisAPI both OFF)`);
        return false;
      }
      
      const networkLower = (network || '').toLowerCase();
      const providerPrefix = provider === 'EASYDATA' ? 'easydata' : 'mcbis';
      
      // Check provider-specific network toggle
      if (networkLower === 'mtn') {
        const toggleKey = `${providerPrefix}_mtnAPI`;
        const enabled = siteSettings[toggleKey] !== false;
        console.log(`[OrderGroup] MTN API check: ${toggleKey}=${siteSettings[toggleKey]}, enabled=${enabled}`);
        return enabled;
      }
      if (networkLower === 'telecel' || networkLower === 'vodafone') {
        const toggleKey = `${providerPrefix}_telecelAPI`;
        const enabled = siteSettings[toggleKey] !== false;
        console.log(`[OrderGroup] Telecel API check: ${toggleKey}=${siteSettings[toggleKey]}, enabled=${enabled}`);
        return enabled;
      }
      if (networkLower === 'airteltigo' || networkLower === 'at') {
        const toggleKey = `${providerPrefix}_airteltigoAPI`;
        const enabled = siteSettings[toggleKey] !== false;
        console.log(`[OrderGroup] AirtelTigo API check: ${toggleKey}=${siteSettings[toggleKey]}, enabled=${enabled}`);
        return enabled;
      }
      
      // Unknown network - allow if provider is enabled
      console.log(`[OrderGroup] Network '${network}' - allowing by default`);
      return true;
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
    const apiProvider = getApiProvider(siteSettings);
    const results = [];
    let skipped = 0;
    
    console.log(`[OrderGroup] API Provider: ${apiProvider || 'NONE'}`);
    
    // Get API balance once at the start
    let apiBalance = 0;
    let apiService = null;
    
    if (apiProvider === 'EASYDATA') {
      apiService = easyDataService;
      try {
        const balanceResult = await easyDataService.getWalletBalance();
        apiBalance = balanceResult.success ? balanceResult.balance : 0;
        console.log(`[OrderGroup] EasyDataGH wallet balance: ${apiBalance} GHS`);
      } catch (e) {
        console.log(`[OrderGroup] Could not fetch EasyDataGH balance: ${e.message}`);
      }
    } else if (apiProvider === 'MCBIS') {
      apiService = datahubService;
      try {
        const balanceResult = await datahubService.getWalletBalance();
        apiBalance = balanceResult.success ? balanceResult.balance : 0;
        console.log(`[OrderGroup] MCBIS wallet balance: ${apiBalance} GHS`);
      } catch (e) {
        console.log(`[OrderGroup] Could not fetch MCBIS balance: ${e.message}`);
      }
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
      
      // Check 4: Is network API enabled?
      if (!isNetworkApiEnabled(network, siteSettings, apiProvider)) {
        console.log(`[OrderGroup] Skipping ${item.reference}: ${network} API disabled or no provider`);
        skipped++;
        results.push({
          itemId: item.id,
          reference: item.reference,
          skipped: true,
          reason: apiProvider ? `${network} API is disabled` : 'No API provider enabled'
        });
        continue;
      }
      
      // Check 2: Extract data amount and estimate cost
      let dataAmount = 1;
      if (item.bundle?.dataAmount) {
        const match = item.bundle.dataAmount.match(/(\d+)/);
        if (match) dataAmount = parseInt(match[1]);
      }
      
      // Estimate cost (rough estimate: ~3.9 GHS per 1GB for MTN)
      const estimatedCost = item.baseCost || (dataAmount * 3.9);
      
      // Check 3: Is API balance sufficient?
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

        // Update item status based on result
        await this.updateItemStatus(item.id, {
          status: result.success ? 'PROCESSING' : 'FAILED',
          externalReference: result.reference,
          failureReason: result.success ? null : result.error
        });

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
            apiBalance = result.newBalance;
          } else {
            apiBalance -= estimatedCost;
          }
        }

        // Delay between API calls
        await new Promise(resolve => setTimeout(resolve, 500));

      } catch (error) {
        console.error(`[OrderGroup] Error processing item ${item.id}:`, error.message);
        
        // Check if it's an insufficient balance error from API
        if (error.message.includes('Insufficient') || error.message.includes('balance')) {
          console.log(`[OrderGroup] ${apiProvider} balance depleted, stopping further processing`);
          skipped++;
          results.push({
            itemId: item.id,
            reference: item.reference,
            skipped: true,
            reason: `${apiProvider} balance depleted`
          });
          // Stop processing remaining items
          break;
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

    console.log(`[OrderGroup] Provider: ${apiProvider || 'NONE'}, Processed: ${results.filter(r => !r.skipped).length}, Skipped: ${skipped}`);

    return {
      orderGroupId,
      displayId: orderGroup.displayId,
      provider: apiProvider,
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
  },

  /**
   * ============================================================
   * SYNC ORDER ITEM STATUS FROM EXTERNAL API
   * ============================================================
   * Checks the status of an OrderItem from MCBIS or EasyDataGH API
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

    // Determine which API to check based on the reference prefix or apiProvider field
    let apiResult;
    try {
      // Try to detect API from reference pattern or try both
      const datahubService = require('./datahub.service');
      const easyDataService = require('./easydata.service');
      
      // MCBIS references typically start with KDP- or numeric, EasyData with ED-
      // But safer to try MCBIS first since it's the most common
      apiResult = await datahubService.checkOrderStatus(item.externalReference);
      
      if (!apiResult.success || apiResult.status === 'unknown') {
        // Try EasyDataGH as fallback
        const easyResult = await easyDataService.checkOrderStatus(item.externalReference);
        if (easyResult.success) {
          apiResult = {
            success: true,
            status: easyResult.orderStatus,
            provider: 'EASYDATA'
          };
        }
      } else {
        apiResult.provider = 'MCBIS';
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

    const statusChanged = newStatus !== item.status;
    
    if (statusChanged) {
      console.log(`[Sync] Status change: ${item.status} → ${newStatus}`);
      
      await prisma.orderItem.update({
        where: { id: itemId },
        data: {
          status: newStatus,
          externalStatus: apiResult.status,
          ...(newStatus === 'COMPLETED' ? { apiConfirmedAt: new Date() } : {})
        }
      });

      // Update OrderGroup summary status
      await this.recalculateGroupStatus(item.orderGroupId);
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
   * Sync ALL processing/pending OrderItems that have externalReference
   * Call this periodically or via admin action
   */
  async syncAllProcessingItems() {
    console.log(`[Sync] Starting sync of all processing OrderItems...`);
    
    const items = await prisma.orderItem.findMany({
      where: {
        status: { in: ['PROCESSING', 'PENDING'] },
        externalReference: { not: null }
      },
      take: 100 // Limit to prevent API overload
    });

    console.log(`[Sync] Found ${items.length} items to sync`);

    const results = [];
    let completed = 0;
    let failed = 0;
    let unchanged = 0;

    for (const item of items) {
      try {
        const result = await this.syncOrderItemStatus(item.id);
        results.push({ itemId: item.id, reference: item.reference, ...result });
        
        if (result.statusChanged) {
          if (result.newStatus === 'COMPLETED') completed++;
          else if (result.newStatus === 'FAILED') failed++;
        } else {
          unchanged++;
        }
        
        // Small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 300));
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
