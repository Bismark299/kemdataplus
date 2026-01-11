/**
 * ============================================================================
 * FINANCIAL-GRADE ORDER PROCESSING SERVICE
 * ============================================================================
 * 
 * This service implements production-safe, idempotent order processing with:
 * - Database-level locking to prevent concurrent processing
 * - Idempotency keys to prevent duplicate operations
 * - State machine enforcement with atomic transitions
 * - Full audit logging of all API interactions
 * - Controlled retry mechanism with exponential backoff
 * - Crash recovery and redeploy safety
 * 
 * NON-NEGOTIABLE INVARIANTS:
 * 1. An order MUST NEVER be sent to the external API more than once
 * 2. Wallet deduction MUST occur exactly once per order
 * 3. All external API calls MUST be logged before execution
 * 4. State transitions MUST be atomic and validated
 * 5. Failed operations MUST be safely retryable without duplication
 * 
 * @module services/financial-order.service
 */

const { PrismaClient, Prisma } = require('@prisma/client');
const crypto = require('crypto');
const axios = require('axios');

const prisma = new PrismaClient();

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
  // Lock configuration
  LOCK_TIMEOUT_MS: 30000,           // 30 seconds max lock hold time
  LOCK_RETRY_INTERVAL_MS: 100,      // Retry acquiring lock every 100ms
  LOCK_MAX_RETRIES: 50,             // Max 5 seconds of retrying
  
  // Retry configuration
  MAX_RETRIES: 3,
  RETRY_BASE_DELAY_MS: 1000,        // 1 second base delay
  RETRY_MAX_DELAY_MS: 60000,        // Max 1 minute delay
  RETRY_BACKOFF_MULTIPLIER: 2,      // Exponential backoff
  
  // Idempotency configuration
  IDEMPOTENCY_KEY_TTL_HOURS: 24,    // Keys expire after 24 hours
  
  // API configuration
  API_TIMEOUT_MS: 30000,            // 30 second API timeout
  
  // Server instance ID (for distributed locking)
  SERVER_INSTANCE: process.env.RENDER_INSTANCE_ID || 
                   process.env.HOSTNAME || 
                   `server-${crypto.randomBytes(4).toString('hex')}`
};

// ============================================================================
// VALID STATE TRANSITIONS (State Machine Definition)
// ============================================================================

const VALID_TRANSITIONS = {
  'CREATED':    ['QUEUED', 'CANCELLED'],
  'QUEUED':     ['LOCKED', 'FAILED', 'CANCELLED'],
  'LOCKED':     ['SENT', 'FAILED'],
  'SENT':       ['CONFIRMED', 'FAILED'],
  'CONFIRMED':  [], // Terminal state
  'FAILED':     [], // Terminal state (use separate retry mechanism)
  'CANCELLED':  [], // Terminal state
  
  // Legacy compatibility
  'PENDING':    ['PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED'],
  'PROCESSING': ['COMPLETED', 'FAILED'],
  'COMPLETED':  [], // Terminal state
};

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Generate a cryptographic hash of data for audit logging
 */
function hashData(data) {
  const normalized = typeof data === 'string' ? data : JSON.stringify(data);
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

/**
 * Generate idempotency key from request parameters
 */
function generateIdempotencyKey(userId, bundleId, recipientPhone, clientKey = null) {
  if (clientKey) {
    // Use client-provided key (from Idempotency-Key header)
    return `client:${userId}:${clientKey}`;
  }
  // Generate deterministic key from order parameters
  const data = `${userId}:${bundleId}:${recipientPhone}:${Date.now().toString().slice(0, -4)}`;
  return `auto:${hashData(data).substring(0, 32)}`;
}

/**
 * Calculate retry delay with exponential backoff and jitter
 */
function calculateRetryDelay(retryCount) {
  const baseDelay = CONFIG.RETRY_BASE_DELAY_MS;
  const exponentialDelay = baseDelay * Math.pow(CONFIG.RETRY_BACKOFF_MULTIPLIER, retryCount);
  const cappedDelay = Math.min(exponentialDelay, CONFIG.RETRY_MAX_DELAY_MS);
  // Add jitter (±20%)
  const jitter = cappedDelay * 0.2 * (Math.random() - 0.5);
  return Math.floor(cappedDelay + jitter);
}

/**
 * Validate state transition
 */
function isValidTransition(fromState, toState) {
  const allowed = VALID_TRANSITIONS[fromState];
  return allowed && allowed.includes(toState);
}

// ============================================================================
// CORE SERVICE
// ============================================================================

const financialOrderService = {
  /**
   * ========================================================================
   * SAFE ORDER CREATION WITH WALLET DEDUCTION
   * ========================================================================
   * 
   * Creates an order with atomic wallet deduction using idempotency.
   * 
   * SAFETY GUARANTEES:
   * - Idempotency: Same request returns same result without re-executing
   * - Atomicity: Order + wallet deduction in single transaction
   * - Isolation: Serializable transaction prevents race conditions
   * 
   * @param {object} params
   * @param {string} params.userId - User placing the order
   * @param {string} params.bundleId - Bundle being purchased  
   * @param {string} params.recipientPhone - Phone to receive data
   * @param {number} params.quantity - Number of bundles
   * @param {number} params.unitPrice - Price per unit (server-resolved)
   * @param {number} params.baseCost - Cost per unit
   * @param {string} params.tenantId - Tenant ID (optional)
   * @param {string} params.idempotencyKey - Client-provided key (optional)
   * @returns {object} Created order or existing order if idempotent
   */
  async createOrderSafe(params) {
    const {
      userId,
      bundleId,
      recipientPhone,
      quantity = 1,
      unitPrice,
      baseCost,
      tenantId,
      idempotencyKey: clientKey
    } = params;

    const idempotencyKey = generateIdempotencyKey(userId, bundleId, recipientPhone, clientKey);
    const requestHash = hashData({ userId, bundleId, recipientPhone, quantity });
    const totalPrice = Number((unitPrice * quantity).toFixed(2));

    console.log(`[FinancialOrder] Creating order with idempotency key: ${idempotencyKey}`);

    // ====== STEP 1: Check idempotency ======
    const existingIdempotency = await prisma.idempotencyKey.findUnique({
      where: { key: idempotencyKey }
    });

    if (existingIdempotency) {
      if (existingIdempotency.status === 'COMPLETED' && existingIdempotency.responseData) {
        console.log(`[FinancialOrder] Returning cached response for idempotent request`);
        return {
          success: true,
          idempotent: true,
          order: existingIdempotency.responseData
        };
      }
      
      if (existingIdempotency.status === 'PENDING') {
        // Request is in progress - wait or fail
        const lockAge = Date.now() - new Date(existingIdempotency.lockedAt).getTime();
        if (lockAge < CONFIG.LOCK_TIMEOUT_MS) {
          return {
            success: false,
            error: 'DUPLICATE_REQUEST_IN_PROGRESS',
            message: 'This request is already being processed'
          };
        }
        // Lock expired, allow retry by deleting stale record
        await prisma.idempotencyKey.delete({ where: { key: idempotencyKey } });
      }
    }

    // ====== STEP 2: Create idempotency record ======
    try {
      await prisma.idempotencyKey.create({
        data: {
          key: idempotencyKey,
          operationType: 'CREATE_ORDER',
          userId,
          requestHash,
          status: 'PENDING',
          lockedAt: new Date(),
          lockedBy: CONFIG.SERVER_INSTANCE,
          expiresAt: new Date(Date.now() + CONFIG.IDEMPOTENCY_KEY_TTL_HOURS * 60 * 60 * 1000)
        }
      });
    } catch (error) {
      if (error.code === 'P2002') {
        // Unique constraint violation - concurrent request
        return {
          success: false,
          error: 'CONCURRENT_REQUEST',
          message: 'Another request is creating this order'
        };
      }
      throw error;
    }

    // ====== STEP 3: Execute order creation in serializable transaction ======
    let order;
    try {
      order = await prisma.$transaction(async (tx) => {
        // Get wallet with implicit lock (serializable)
        const wallet = await tx.wallet.findUnique({
          where: { userId }
        });

        if (!wallet) {
          throw new Error('WALLET_NOT_FOUND');
        }

        if (wallet.isFrozen) {
          throw new Error('WALLET_FROZEN');
        }

        if (wallet.balance < totalPrice) {
          throw new Error('INSUFFICIENT_BALANCE');
        }

        // Generate unique reference
        const reference = `ORD-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;

        // Atomic wallet deduction
        await tx.wallet.update({
          where: { 
            id: wallet.id,
            balance: { gte: totalPrice }
          },
          data: {
            balance: { decrement: totalPrice }
          }
        });

        // Create order with wallet deduction flag
        const newOrder = await tx.order.create({
          data: {
            userId,
            bundleId,
            recipientPhone,
            quantity,
            unitPrice,
            totalPrice,
            baseCost: baseCost * quantity,
            tenantId,
            reference,
            status: 'PENDING', // Will transition to QUEUED
            paymentStatus: 'COMPLETED',
            idempotencyKey,
            walletDeducted: true,
            walletDeductedAt: new Date()
          },
          include: {
            bundle: {
              select: { name: true, network: true, dataAmount: true }
            }
          }
        });

        // Create transaction record
        await tx.transaction.create({
          data: {
            walletId: wallet.id,
            type: 'PURCHASE',
            amount: -totalPrice,
            status: 'COMPLETED',
            reference,
            description: `Purchase: Order ${reference}`
          }
        });

        return newOrder;
      }, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        timeout: 15000
      });

      // ====== STEP 4: Update idempotency record with success ======
      await prisma.idempotencyKey.update({
        where: { key: idempotencyKey },
        data: {
          status: 'COMPLETED',
          orderId: order.id,
          responseData: order,
          completedAt: new Date()
        }
      });

      console.log(`[FinancialOrder] Order created successfully: ${order.id}`);
      return { success: true, order };

    } catch (error) {
      // ====== STEP 5: Update idempotency record with failure ======
      await prisma.idempotencyKey.update({
        where: { key: idempotencyKey },
        data: {
          status: 'FAILED',
          responseData: { error: error.message },
          completedAt: new Date()
        }
      });

      if (error.message === 'WALLET_NOT_FOUND') {
        return { success: false, error: 'WALLET_NOT_FOUND', message: 'Wallet not found' };
      }
      if (error.message === 'WALLET_FROZEN') {
        return { success: false, error: 'WALLET_FROZEN', message: 'Wallet is frozen' };
      }
      if (error.message === 'INSUFFICIENT_BALANCE') {
        return { success: false, error: 'INSUFFICIENT_BALANCE', message: 'Insufficient balance', required: totalPrice };
      }
      throw error;
    }
  },

  /**
   * ========================================================================
   * SAFE ORDER PUSH TO EXTERNAL API
   * ========================================================================
   * 
   * Pushes an order to the external provider API with full safety guarantees.
   * 
   * SAFETY GUARANTEES:
   * - Locking: Order is locked before API call, preventing concurrent sends
   * - Idempotency: External reference prevents duplicate sends
   * - Audit: All API calls logged before execution
   * - Recovery: Safe to retry after crashes
   * 
   * @param {string} orderId - Order ID to push
   * @param {object} apiConfig - API configuration
   * @returns {object} Push result
   */
  async pushOrderToApi(orderId, apiConfig) {
    console.log(`[FinancialOrder] ========== PUSH ORDER START ==========`);
    console.log(`[FinancialOrder] Order ID: ${orderId}`);

    // ====== STEP 1: Acquire lock on the order ======
    const lockResult = await this.acquireOrderLock(orderId);
    if (!lockResult.success) {
      console.log(`[FinancialOrder] Failed to acquire lock: ${lockResult.error}`);
      return lockResult;
    }

    const order = lockResult.order;
    console.log(`[FinancialOrder] Lock acquired, order status: ${order.status}`);

    try {
      // ====== STEP 2: Validate order state ======
      // Order must be in PENDING or PROCESSING to be sent
      if (!['PENDING', 'PROCESSING', 'QUEUED', 'LOCKED'].includes(order.status)) {
        console.log(`[FinancialOrder] Order not in sendable state: ${order.status}`);
        return {
          success: false,
          error: 'INVALID_STATE',
          message: `Order is in ${order.status} state, cannot send`
        };
      }

      // ====== STEP 3: Check if already sent (by external reference) ======
      if (order.externalReference) {
        console.log(`[FinancialOrder] Order already has external reference: ${order.externalReference}`);
        // Already sent - check status instead
        return {
          success: true,
          alreadySent: true,
          externalReference: order.externalReference,
          message: 'Order was already sent to provider'
        };
      }

      // ====== STEP 4: Check retry count ======
      if (order.retryCount >= order.maxRetries) {
        console.log(`[FinancialOrder] Max retries exceeded: ${order.retryCount}/${order.maxRetries}`);
        await this.transitionOrderState(orderId, 'FAILED', 'Max retries exceeded');
        return {
          success: false,
          error: 'MAX_RETRIES_EXCEEDED',
          message: `Order failed after ${order.maxRetries} retries`
        };
      }

      // ====== STEP 5: Generate external reference BEFORE API call ======
      const externalReference = `KEM${Date.now()}${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
      console.log(`[FinancialOrder] Generated external reference: ${externalReference}`);

      // ====== STEP 6: Persist external reference BEFORE API call ======
      // This is critical - if we crash after API call but before saving reference,
      // we can detect it by checking if order has a reference on recovery
      await prisma.order.update({
        where: { id: orderId },
        data: {
          externalReference,
          status: 'PROCESSING',
          apiSentAt: new Date()
        }
      });

      // ====== STEP 7: Log API call BEFORE execution ======
      const apiPayload = {
        network: this.mapNetwork(order.bundle?.network),
        reference: externalReference,
        receiver: this.formatPhone(order.recipientPhone),
        amount: this.extractDataAmount(order.bundle?.dataAmount)
      };

      const auditLogId = await this.logApiCall({
        orderId,
        operation: 'PLACE_ORDER',
        externalReference,
        requestUrl: `${apiConfig.url}/placeOrder`,
        requestMethod: 'POST',
        requestPayload: apiPayload,
        retryNumber: order.retryCount
      });

      // ====== STEP 8: Make API call ======
      let apiResponse;
      let apiError;
      const startTime = Date.now();

      try {
        console.log(`[FinancialOrder] Calling external API...`);
        apiResponse = await axios({
          method: 'POST',
          url: `${apiConfig.url}/placeOrder`,
          headers: {
            'Authorization': `Bearer ${apiConfig.token}`,
            'Content-Type': 'application/json',
            'X-Idempotency-Key': externalReference
          },
          data: apiPayload,
          timeout: CONFIG.API_TIMEOUT_MS
        });
        console.log(`[FinancialOrder] API response status: ${apiResponse.status}`);
      } catch (error) {
        apiError = error;
        console.error(`[FinancialOrder] API call failed: ${error.message}`);
      }

      const responseTimeMs = Date.now() - startTime;

      // ====== STEP 9: Update audit log with response ======
      await this.updateApiAuditLog(auditLogId, {
        responseStatus: apiResponse?.status || apiError?.response?.status,
        responsePayload: apiResponse?.data || apiError?.response?.data,
        responseTimeMs,
        errorMessage: apiError?.message,
        errorCode: apiError?.code
      });

      // ====== STEP 10: Handle API response ======
      if (apiError) {
        // API call failed
        const isRetryable = this.isRetryableError(apiError);
        
        if (isRetryable && order.retryCount < order.maxRetries - 1) {
          // Schedule retry
          const retryDelay = calculateRetryDelay(order.retryCount);
          await prisma.order.update({
            where: { id: orderId },
            data: {
              retryCount: { increment: 1 },
              nextRetryAt: new Date(Date.now() + retryDelay),
              failureReason: apiError.message
            }
          });
          
          return {
            success: false,
            error: 'API_ERROR_RETRYABLE',
            message: apiError.message,
            willRetryAt: new Date(Date.now() + retryDelay),
            retryCount: order.retryCount + 1
          };
        } else {
          // Non-retryable or max retries exceeded
          await this.transitionOrderState(orderId, 'FAILED', apiError.message);
          return {
            success: false,
            error: 'API_ERROR',
            message: apiError.message
          };
        }
      }

      // API call succeeded
      const apiStatus = apiResponse.data?.data?.status || apiResponse.data?.status;
      console.log(`[FinancialOrder] API success, provider status: ${apiStatus}`);

      // Update order with success
      await prisma.order.update({
        where: { id: orderId },
        data: {
          status: apiStatus === 'success' || apiStatus === 'completed' ? 'COMPLETED' : 'PROCESSING',
          externalStatus: apiStatus
        }
      });

      console.log(`[FinancialOrder] ========== PUSH ORDER END ==========`);

      return {
        success: true,
        externalReference,
        externalStatus: apiStatus,
        message: 'Order sent to provider'
      };

    } finally {
      // ====== STEP 11: Always release lock ======
      await this.releaseOrderLock(orderId);
    }
  },

  /**
   * ========================================================================
   * ACQUIRE ORDER LOCK
   * ========================================================================
   * 
   * Acquires an exclusive lock on an order using database row-level locking.
   * Prevents concurrent processing of the same order.
   */
  async acquireOrderLock(orderId, maxRetries = CONFIG.LOCK_MAX_RETRIES) {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const result = await prisma.$transaction(async (tx) => {
          // Try to acquire lock using FOR UPDATE SKIP LOCKED
          const orders = await tx.$queryRaw`
            SELECT * FROM orders 
            WHERE id = ${orderId} 
            AND (locked_at IS NULL OR lock_expires_at < NOW())
            FOR UPDATE SKIP LOCKED
          `;

          if (!orders || orders.length === 0) {
            return { success: false, error: 'ORDER_LOCKED_BY_ANOTHER' };
          }

          const order = orders[0];

          // Set lock
          const lockedOrder = await tx.order.update({
            where: { id: orderId },
            data: {
              lockedAt: new Date(),
              lockedBy: CONFIG.SERVER_INSTANCE,
              lockExpiresAt: new Date(Date.now() + CONFIG.LOCK_TIMEOUT_MS)
            },
            include: {
              bundle: {
                select: { name: true, network: true, dataAmount: true }
              }
            }
          });

          return { success: true, order: lockedOrder };
        }, {
          timeout: 5000
        });

        if (result.success) {
          return result;
        }
      } catch (error) {
        console.log(`[FinancialOrder] Lock attempt ${attempt + 1} failed: ${error.message}`);
      }

      // Wait before retry
      await new Promise(resolve => setTimeout(resolve, CONFIG.LOCK_RETRY_INTERVAL_MS));
    }

    return { success: false, error: 'LOCK_TIMEOUT', message: 'Could not acquire order lock' };
  },

  /**
   * Release order lock
   */
  async releaseOrderLock(orderId) {
    try {
      await prisma.order.update({
        where: { id: orderId },
        data: {
          lockedAt: null,
          lockedBy: null,
          lockExpiresAt: null
        }
      });
    } catch (error) {
      console.error(`[FinancialOrder] Failed to release lock: ${error.message}`);
    }
  },

  /**
   * ========================================================================
   * STATE TRANSITION
   * ========================================================================
   */
  async transitionOrderState(orderId, newState, reason = null) {
    const order = await prisma.order.findUnique({ where: { id: orderId } });
    if (!order) {
      throw new Error('Order not found');
    }

    if (!isValidTransition(order.status, newState)) {
      throw new Error(`Invalid transition from ${order.status} to ${newState}`);
    }

    await prisma.order.update({
      where: { id: orderId },
      data: {
        status: newState,
        ...(reason && { failureReason: reason }),
        ...(newState === 'COMPLETED' && { processedAt: new Date() })
      }
    });

    // Log transition
    await prisma.orderStateTransition.create({
      data: {
        orderId,
        fromState: order.status,
        toState: newState,
        triggeredBy: CONFIG.SERVER_INSTANCE,
        triggerSource: 'application',
        metadata: reason ? { reason } : undefined
      }
    });
  },

  /**
   * ========================================================================
   * API AUDIT LOGGING
   * ========================================================================
   */
  async logApiCall(params) {
    const log = await prisma.apiAuditLog.create({
      data: {
        orderId: params.orderId,
        idempotencyKey: params.idempotencyKey,
        operation: params.operation,
        externalReference: params.externalReference,
        requestUrl: params.requestUrl,
        requestMethod: params.requestMethod,
        requestPayloadHash: hashData(params.requestPayload),
        requestPayload: params.requestPayload,
        retryNumber: params.retryNumber || 0,
        serverInstance: CONFIG.SERVER_INSTANCE
      }
    });
    return log.id;
  },

  async updateApiAuditLog(logId, params) {
    await prisma.apiAuditLog.update({
      where: { id: logId },
      data: {
        responseStatus: params.responseStatus,
        responsePayloadHash: params.responsePayload ? hashData(params.responsePayload) : null,
        responsePayload: params.responsePayload,
        responseTimeMs: params.responseTimeMs,
        errorMessage: params.errorMessage,
        errorCode: params.errorCode
      }
    });
  },

  /**
   * ========================================================================
   * RETRY PROCESSOR
   * ========================================================================
   * 
   * Processes orders that are due for retry.
   * Safe to run from multiple instances (uses locking).
   */
  async processRetryQueue(apiConfig) {
    console.log(`[FinancialOrder] Processing retry queue...`);

    const ordersToRetry = await prisma.order.findMany({
      where: {
        status: { in: ['PENDING', 'PROCESSING'] },
        nextRetryAt: { lte: new Date() },
        retryCount: { lt: prisma.order.fields.maxRetries }
      },
      take: 10 // Process in batches
    });

    console.log(`[FinancialOrder] Found ${ordersToRetry.length} orders to retry`);

    const results = [];
    for (const order of ordersToRetry) {
      try {
        const result = await this.pushOrderToApi(order.id, apiConfig);
        results.push({ orderId: order.id, ...result });
      } catch (error) {
        results.push({ orderId: order.id, success: false, error: error.message });
      }
      // Small delay between retries
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    return { processed: results.length, results };
  },

  /**
   * ========================================================================
   * RECOVERY: Find orphaned orders
   * ========================================================================
   * 
   * Finds orders that may have been interrupted mid-processing.
   * Call this on server startup.
   */
  async recoverOrphanedOrders() {
    console.log(`[FinancialOrder] Checking for orphaned orders...`);

    // Find orders with external reference but still in PROCESSING
    // These may have been interrupted after API call but before status update
    const potentiallyOrphaned = await prisma.order.findMany({
      where: {
        externalReference: { not: null },
        status: 'PROCESSING',
        apiSentAt: { lt: new Date(Date.now() - 5 * 60 * 1000) } // Sent more than 5 min ago
      }
    });

    console.log(`[FinancialOrder] Found ${potentiallyOrphaned.length} potentially orphaned orders`);

    // These orders need their status checked with the external API
    return potentiallyOrphaned;
  },

  /**
   * ========================================================================
   * HELPER METHODS
   * ========================================================================
   */
  mapNetwork(network) {
    const map = {
      'MTN': 'mtn', 'mtn': 'mtn',
      'TELECEL': 'telecel', 'telecel': 'telecel', 'Telecel': 'telecel',
      'AIRTELTIGO': 'atbigtime', 'AirtelTigo': 'atbigtime', 'airteltigo': 'atbigtime'
    };
    return map[network] || 'mtn';
  },

  formatPhone(phone) {
    let formatted = phone.replace(/\s+/g, '');
    if (formatted.startsWith('+233')) {
      formatted = '0' + formatted.slice(4);
    } else if (formatted.startsWith('233')) {
      formatted = '0' + formatted.slice(3);
    }
    return formatted;
  },

  extractDataAmount(dataAmount) {
    if (!dataAmount) return 1;
    const match = dataAmount.match(/(\d+)/);
    return match ? parseInt(match[1]) : 1;
  },

  isRetryableError(error) {
    // Network errors and 5xx are retryable
    if (!error.response) return true; // Network error
    const status = error.response.status;
    return status >= 500 || status === 408 || status === 429;
  },

  // ========================================================================
  // STOREFRONT PROFIT DISTRIBUTION (Paystack Orders)
  // ========================================================================
  
  /**
   * Get minimum price for a bundle (AGENT role price)
   * This is the floor price - agents cannot sell below this
   */
  async getMinimumPrice(bundleId, tenantId = null) {
    // First check tenant-specific price if tenantId provided
    if (tenantId) {
      const tenantPrice = await prisma.tenantBundlePrice.findFirst({
        where: {
          tenantId,
          bundleId,
          role: 'AGENT',
          isValid: true
        }
      });
      if (tenantPrice) return tenantPrice.price;
    }

    // Fall back to system AGENT role price
    const rolePrice = await prisma.bundlePrice.findFirst({
      where: { bundleId, role: 'AGENT' }
    });

    return rolePrice?.price || null;
  },

  /**
   * Get supplier cost for a bundle (baseCost)
   */
  async getSupplierCost(bundleId) {
    const bundle = await prisma.bundle.findUnique({
      where: { id: bundleId },
      select: { baseCost: true }
    });
    return bundle?.baseCost || null;
  },

  /**
   * Validate that agent's selling price meets minimum
   */
  validateAgentPrice(agentPrice, minimumPrice) {
    if (agentPrice < minimumPrice) {
      return {
        valid: false,
        error: `Price cannot be below minimum (GHS ${minimumPrice.toFixed(2)})`,
        agentPrice,
        minimumPrice,
        shortfall: minimumPrice - agentPrice
      };
    }
    return {
      valid: true,
      agentPrice,
      minimumPrice,
      margin: agentPrice - minimumPrice
    };
  },

  /**
   * Calculate profit distribution for an order
   */
  calculateProfits(agentPrice, minimumPrice, supplierCost) {
    const agentProfit = agentPrice - minimumPrice;
    const platformProfit = minimumPrice - supplierCost;
    const totalProfit = agentProfit + platformProfit;

    return {
      agentPrice,
      minimumPrice,
      supplierCost,
      agentProfit: Math.max(0, agentProfit),
      platformProfit: Math.max(0, platformProfit),
      totalProfit,
      agentProfitPercent: totalProfit > 0 ? (agentProfit / totalProfit * 100).toFixed(1) : 0,
      platformProfitPercent: totalProfit > 0 ? (platformProfit / totalProfit * 100).toFixed(1) : 0
    };
  },

  /**
   * Credit agent profit to their wallet
   * Called when Paystack storefront order status changes to COMPLETED
   */
  async creditAgentProfit(storefrontOrderId) {
    const storefrontOrder = await prisma.storefrontOrder.findUnique({
      where: { id: storefrontOrderId },
      include: {
        storefront: {
          include: {
            owner: {
              include: { wallet: true }
            }
          }
        },
        bundle: true
      }
    });

    if (!storefrontOrder) {
      throw new Error('Storefront order not found');
    }

    // Only credit for Paystack orders (MoMo orders use wallet debit flow)
    if (storefrontOrder.paymentMethod !== 'PAYSTACK') {
      return { 
        credited: false, 
        reason: 'Not a Paystack order - profit handled via wallet debit flow' 
      };
    }

    // Check if already credited
    if (storefrontOrder.profitCredited) {
      return { 
        credited: false, 
        reason: 'Profit already credited',
        creditedAt: storefrontOrder.profitCreditedAt
      };
    }

    // Verify order is completed
    if (storefrontOrder.status !== 'COMPLETED') {
      return { 
        credited: false, 
        reason: `Order not completed (status: ${storefrontOrder.status})` 
      };
    }

    const agentProfit = storefrontOrder.ownerProfit;
    const owner = storefrontOrder.storefront.owner;

    if (agentProfit <= 0) {
      // Mark as credited even if zero profit
      await prisma.storefrontOrder.update({
        where: { id: storefrontOrderId },
        data: {
          profitCredited: true,
          profitCreditedAt: new Date()
        }
      });
      return { 
        credited: true, 
        amount: 0, 
        reason: 'No profit to credit (zero margin)' 
      };
    }

    // Credit in transaction
    const result = await prisma.$transaction(async (tx) => {
      // Get or create wallet
      let wallet = owner.wallet;
      if (!wallet) {
        wallet = await tx.wallet.create({
          data: { userId: owner.id, balance: 0 }
        });
      }

      // Credit wallet
      await tx.wallet.update({
        where: { id: wallet.id },
        data: { balance: { increment: agentProfit } }
      });

      // Create transaction record
      const transactionRef = `PROFIT-${storefrontOrderId.slice(0, 8)}-${Date.now()}`;
      await tx.transaction.create({
        data: {
          walletId: wallet.id,
          type: 'PROFIT_CREDIT',
          amount: agentProfit,
          status: 'COMPLETED',
          reference: transactionRef,
          description: `Store profit - ${storefrontOrder.bundle.name} to ${storefrontOrder.customerPhone}`
        }
      });

      // Mark storefront order as profit credited
      await tx.storefrontOrder.update({
        where: { id: storefrontOrderId },
        data: {
          profitCredited: true,
          profitCreditedAt: new Date()
        }
      });

      // Create wallet ledger entry
      const runningBalance = wallet.balance + agentProfit;
      await tx.walletLedger.create({
        data: {
          walletId: wallet.id,
          entryType: 'PROFIT_CREDIT',
          amount: agentProfit,
          runningBalance,
          orderId: storefrontOrder.orderId,
          description: `Store sale profit - Order ${storefrontOrder.orderId?.slice(0, 8) || 'N/A'}`,
          reference: transactionRef
        }
      });

      return {
        credited: true,
        amount: agentProfit,
        ownerId: owner.id,
        ownerName: owner.name,
        newBalance: runningBalance,
        transactionRef
      };
    });

    console.log(`[Financial] ✅ Agent profit credited: GHS ${agentProfit.toFixed(2)} to ${owner.name}`);
    return result;
  },

  /**
   * Process completed order - credit profits
   * Called by order status update or auto-sync
   */
  async processCompletedStorefrontOrder(orderId) {
    // Find storefront order linked to this order
    const storefrontOrder = await prisma.storefrontOrder.findFirst({
      where: { orderId }
    });

    if (!storefrontOrder) {
      return { processed: false, reason: 'No storefront order linked' };
    }

    // Update storefront order status
    await prisma.storefrontOrder.update({
      where: { id: storefrontOrder.id },
      data: { status: 'COMPLETED' }
    });

    // Credit agent profit
    return this.creditAgentProfit(storefrontOrder.id);
  },

  /**
   * Get uncredited profit orders (for manual review/retry)
   */
  async getUncreditedProfitOrders() {
    const orders = await prisma.storefrontOrder.findMany({
      where: {
        paymentMethod: 'PAYSTACK',
        paymentStatus: 'PAID',
        status: 'COMPLETED',
        profitCredited: false
      },
      include: {
        storefront: {
          select: { name: true, slug: true, owner: { select: { name: true, email: true } } }
        },
        bundle: {
          select: { name: true, network: true }
        }
      },
      orderBy: { createdAt: 'desc' }
    });

    return orders.map(o => ({
      id: o.id,
      store: o.storefront.name,
      owner: o.storefront.owner.name,
      bundle: o.bundle.name,
      amount: o.amount,
      profit: o.ownerProfit,
      createdAt: o.createdAt
    }));
  },

  /**
   * Retry crediting profits for failed/missed orders
   */
  async retryUncreditedProfits() {
    const uncredited = await this.getUncreditedProfitOrders();
    
    const results = {
      total: uncredited.length,
      credited: 0,
      failed: 0,
      details: []
    };

    for (const order of uncredited) {
      try {
        const result = await this.creditAgentProfit(order.id);
        if (result.credited) {
          results.credited++;
        }
        results.details.push({ orderId: order.id, ...result });
      } catch (error) {
        results.failed++;
        results.details.push({ orderId: order.id, error: error.message });
      }
    }

    return results;
  }
};

module.exports = financialOrderService;
