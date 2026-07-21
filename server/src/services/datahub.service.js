/**
 * MCBISSOLUTION DATAHUB API SERVICE
 * ==================================
 * Integrates with McbisSolution API for automatic data bundle fulfillment.
 * 
 * API Base: https://datahub.mcbissolution.com/api/v1
 * 
 * Endpoints:
 * - POST /placeOrder - Send data to recipient
 * - GET /walletBalance - Check API wallet balance
 * - GET /checkOrderStatus/:reference - Check order status
 * - GET /allProducts - Get available products and prices
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const prisma = require('../lib/prisma');

// Force IPv4 to avoid IPv6 issues on cloud platforms (Render, Railway, etc.)
const httpAgent = new http.Agent({ family: 4 });
const httpsAgent = new https.Agent({ family: 4 });

// Helper to get API config from settings
// Priority: Environment variables > in-memory settings cache (DB) > settings.json > defaults
function getApiConfig() {
  // 1. Environment variables — most reliable for cloud deployment
  if (process.env.DATAHUB_API_TOKEN) {
    return {
      url: process.env.DATAHUB_API_URL || 'https://datahub.mcbissolution.com/api/v1',
      token: process.env.DATAHUB_API_TOKEN
    };
  }

  // 2. In-memory settings cache (loaded from DB at startup, stays current after admin saves)
  //    This is the reliable source on production containers where settings.json is ephemeral.
  try {
    const settingsController = require('../controllers/settings.controller');
    const adminSettings = settingsController.getAdminSettings ? settingsController.getAdminSettings() : null;
    const token = adminSettings?.mcbisApiToken || adminSettings?.apiKey || '';
    if (token) {
      return {
        url: adminSettings?.mcbisApiUrl || 'https://datahub.mcbissolution.com/api/v1',
        token
      };
    }
  } catch (e) {
    // settingsController not yet initialised — fall through
  }

  // 3. Fallback to settings.json (local dev convenience)
  try {
    const settingsPath = path.join(__dirname, '../../settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    const token = settings.adminSettings?.mcbisApiToken || settings.adminSettings?.apiKey || '';
    if (token) {
      return {
        url: settings.adminSettings?.mcbisApiUrl || settings.adminSettings?.apiUrl || 'https://datahub.mcbissolution.com/api/v1',
        token
      };
    }
  } catch (e) {
    // File missing or unreadable — expected on production containers
  }

  console.warn('[DataHub] WARNING: No McBIS API token found — status checks will fail with 401');
  return {
    url: 'https://datahub.mcbissolution.com/api/v1',
    token: ''
  };
}

// Network mapping (our system -> API)
const NETWORK_MAP = {
  'MTN': 'mtn',
  'mtn': 'mtn',
  'TELECEL': 'telecel',
  'telecel': 'telecel',
  'Telecel': 'telecel',
  'AIRTELTIGO': 'atishare',  // AT Premium (iShare)
  'AirtelTigo': 'atishare',
  'airteltigo': 'atishare',
  'AT': 'atishare',
  'AT- BIG TIME': 'atbigtime',
  'AT-BIG TIME': 'atbigtime',
  'AT-BIGTIME': 'atbigtime'
};

const axios = require('axios');

/**
 * Make API request to McbisSolution using axios
 * Axios handles redirects and cookies better than native fetch
 */
async function apiRequest(endpoint, method = 'GET', body = null, retries = 2) {
  // CRITICAL SAFETY: Never retry POST requests on network errors.
  // POST /placeOrder is NOT idempotent — MCBIS may have received and processed the request
  // even if we got no response (ECONNABORTED/timeout). Retrying would send data to the
  // customer multiple times. Only GET requests (status checks) are safe to retry.
  if (method.toUpperCase() === 'POST') {
    retries = 0;
  }

  const config = getApiConfig();
  const url = `${config.url}${endpoint}`;
  
  console.log(`[DataHub] Request: ${method} ${url}`);
  
  const axiosConfig = {
    method: method.toLowerCase(),
    url: url,
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.token}`,
      'User-Agent': 'KemDataplus/1.0'
    },
    timeout: 45000,
    maxRedirects: 5,
    httpAgent: httpAgent,
    httpsAgent: httpsAgent
  };

  if (body && method !== 'GET') {
    axiosConfig.data = body;
  }

  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    try {
      const response = await axios(axiosConfig);
      console.log(`[DataHub] Response status: ${response.status}`);
      return response.data;
    } catch (error) {
      const isLastAttempt = attempt > retries;

      // Handle axios errors
      if (error.response) {
        // Server responded with error status
        const text = typeof error.response.data === 'string' ? error.response.data : JSON.stringify(error.response.data);
        
        // Check if response is HTML (Cloudflare page)
        if (text.includes('<!DOCTYPE') || text.includes('<html') || text.includes('Just a moment')) {
          console.error(`[DataHub] Cloudflare blocking detected. Status: ${error.response.status}`);
          throw new Error(`API returned HTML (likely Cloudflare). Status: ${error.response.status}. Contact McbisSolution to whitelist server IP.`);
        }
        
        const errorMsg = error.response.data?.message || error.response.data?.error || `API Error: ${error.response.status}`;
        throw new Error(errorMsg);
      } else if (error.request) {
        // Request made but no response - log details and retry
        const code = error.code || 'UNKNOWN';
        console.error(`[DataHub] No response (attempt ${attempt}/${retries + 1}): code=${code}, message=${error.message}`);
        if (isLastAttempt) {
          throw new Error(`No response from API server (${code}). The external API may be unreachable from this server.`);
        }
        // Wait before retry (1s, then 2s)
        await new Promise(r => setTimeout(r, attempt * 1000));
      } else {
        throw new Error(error.message);
      }
    }
  }
}

/**
 * Generate unique reference for order
 */
function generateReference() {
  return `KEM${Date.now()}${Math.random().toString(36).substr(2, 6).toUpperCase()}`;
}

// Rate-limit backoff: when MCBIS returns "Too Many Attempts", skip all status
// checks for RATE_LIMIT_COOLDOWN_MS to let the window reset.
const RATE_LIMIT_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes
let mcbisRateLimitedUntil = 0;

function isMcbisRateLimited() {
  return Date.now() < mcbisRateLimitedUntil;
}

function setMcbisRateLimited() {
  mcbisRateLimitedUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS;
  console.warn(`[DataHub] ⚠️ Rate-limited by MCBIS. Pausing status checks for ${RATE_LIMIT_COOLDOWN_MS / 60000} minutes until ${new Date(mcbisRateLimitedUntil).toISOString()}`);
}

const datahubService = {
  /**
   * Test connection and return raw response details for debugging
   */
  async testConnection() {
    const config = getApiConfig();
    const url = `${config.url}/walletBalance`;
    
    console.log('[DataHub Test] Testing connection with axios...');
    console.log('[DataHub Test] URL:', url);
    console.log('[DataHub Test] Token configured:', !!config.token);
    
    try {
      const response = await axios({
        method: 'get',
        url: url,
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.token}`,
          'User-Agent': 'KemDataplus/1.0'
        },
        timeout: 45000,
        httpAgent: httpAgent,
        httpsAgent: httpsAgent
      });
      
      console.log('[DataHub Test] Status:', response.status);
      console.log('[DataHub Test] Response:', JSON.stringify(response.data).substring(0, 200));
      
      return {
        success: true,
        message: 'Connection successful!',
        data: response.data,
        balance: response.data?.data?.walletBalance
      };
    } catch (error) {
      console.error('[DataHub Test] Error:', error.message);
      
      if (error.response) {
        const text = typeof error.response.data === 'string' ? error.response.data : JSON.stringify(error.response.data);
        console.log('[DataHub Test] Error response:', text.substring(0, 300));
        
        // Check if HTML (Cloudflare)
        if (text.includes('<!DOCTYPE') || text.includes('<html') || text.includes('Just a moment')) {
          return {
            success: false,
            error: `API returned HTML (likely Cloudflare). Status: ${error.response.status}`,
            status: error.response.status,
            hint: 'Cloudflare is blocking the request. Contact McbisSolution to whitelist server IP.',
            responsePreview: text.substring(0, 300)
          };
        }
        
        return {
          success: false,
          error: error.response.data?.message || `API Error: ${error.response.status}`,
          status: error.response.status,
          hint: error.response.status === 401 ? 'Token might be invalid or expired' : 
                error.response.status === 404 ? 'API endpoint not found - check URL' :
                'Check API URL and token'
        };
      }
      
      const code = error.code || 'UNKNOWN';
      return {
        success: false,
        error: `${error.message} (${code})`,
        hint: code === 'ECONNREFUSED' ? 'Connection refused - API server may be down' :
              code === 'ETIMEDOUT' || code === 'ECONNABORTED' ? 'Connection timed out - API server may be slow or blocking this IP' :
              code === 'ENETUNREACH' ? 'Network unreachable - possible IPv6 issue on cloud host' :
              'Network error - check if API URL is correct and reachable from server'
      };
    }
  },

  /**
   * Get API wallet balance
   */
  async getWalletBalance() {
    try {
      const result = await apiRequest('/walletBalance');
      return {
        success: true,
        balance: parseFloat(result.data?.walletBalance || 0),
        raw: result
      };
    } catch (error) {
      return {
        success: false,
        balance: 0,
        error: error.message
      };
    }
  },

  /**
   * Get all available products/bundles
   */
  async getProducts() {
    try {
      const products = await apiRequest('/allProducts');
      return {
        success: true,
        products: Array.isArray(products) ? products : [],
        count: Array.isArray(products) ? products.length : 0
      };
    } catch (error) {
      return {
        success: false,
        products: [],
        error: error.message
      };
    }
  },

  /**
   * Check order status by reference
   */
  async checkOrderStatus(reference) {
    // Respect rate-limit cooldown to avoid hammering MCBIS
    if (isMcbisRateLimited()) {
      const secondsLeft = Math.ceil((mcbisRateLimitedUntil - Date.now()) / 1000);
      return { success: false, status: 'unknown', error: `MCBIS rate-limited, retry in ${secondsLeft}s` };
    }

    try {
      const result = await apiRequest(`/checkOrderStatus/${reference}`);
      
      // Log the raw response to debug status mapping
      console.log(`[DataHub] checkOrderStatus raw response:`, JSON.stringify(result, null, 2));
      
      // MCBIS API returns: 
      // { 
      //   message: "...", 
      //   data: { 
      //     status: "success",  ← This means API call succeeded, NOT order status!
      //     order: { 
      //       status: "pending|processing|completed|failed"  ← THIS is the order status!
      //     } 
      //   } 
      // }
      
      // CRITICAL: Use data.order.status (actual order status), NOT data.status (API call status)
      // DO NOT fall back to result.data?.status — that field just means "API call worked"
      // (always "success") so falling back to it would silently mark cancelled orders as COMPLETED.
      const orderStatus = result.data?.order?.status || 'unknown';
      
      console.log(`[DataHub] Extracted order status: ${orderStatus}`);
      
      return {
        success: true,
        status: orderStatus,
        order: result.data?.order,
        raw: result
      };
    } catch (error) {
      // Detect rate-limiting from MCBIS
      if (
        error.message?.toLowerCase().includes('too many') ||
        error.message?.toLowerCase().includes('rate limit') ||
        error.message?.toLowerCase().includes('too many attempts')
      ) {
        setMcbisRateLimited();
      }
      return {
        success: false,
        status: 'unknown',
        error: error.message
      };
    }
  },

  /**
   * Place data order through API
   * 
   * @param {object} params
   * @param {string} params.network - Network (MTN, Telecel, AirtelTigo)
   * @param {string} params.phone - Recipient phone number
   * @param {number} params.amount - Data amount in GB
   * @param {string} params.orderId - Internal order ID (optional)
   */
  async placeOrder({ network, phone, amount, orderId }) {
    console.log(`[DataHub] ========== PLACE ORDER START ==========`);
    console.log(`[DataHub] Input: network=${network}, phone=${phone}, amount=${amount}, orderId=${orderId}`);
    
    // Map network to API format
    const apiNetwork = NETWORK_MAP[network];
    if (!apiNetwork) {
      console.error(`[DataHub] ERROR: Unsupported network: ${network}`);
      throw new Error(`Unsupported network: ${network}`);
    }
    console.log(`[DataHub] Network mapped: ${network} -> ${apiNetwork}`);

    // Format phone number (remove country code if present)
    let formattedPhone = phone.replace(/\s+/g, '');
    if (formattedPhone.startsWith('+233')) {
      formattedPhone = '0' + formattedPhone.slice(4);
    } else if (formattedPhone.startsWith('233')) {
      formattedPhone = '0' + formattedPhone.slice(3);
    }
    console.log(`[DataHub] Phone formatted: ${phone} -> ${formattedPhone}`);

    // Generate reference
    const reference = generateReference();
    console.log(`[DataHub] Reference generated: ${reference}`);

    // Build payload
    const payload = {
      network: apiNetwork,
      reference: reference,
      receiver: formattedPhone,
      amount: amount
    };
    console.log(`[DataHub] PAYLOAD:`, JSON.stringify(payload, null, 2));

    try {
      console.log(`[DataHub] Calling API: POST /placeOrder`);
      const result = await apiRequest('/placeOrder', 'POST', payload);

      // Log successful order
      console.log(`[DataHub] API SUCCESS:`, JSON.stringify(result, null, 2));
      console.log(`[DataHub] Order placed: ${reference} - ${amount}GB to ${formattedPhone} (${apiNetwork})`);

      return {
        success: true,
        reference: reference,
        status: result.data?.status || 'pending',
        message: result.message,
        data: result.data
      };
    } catch (error) {
      console.error(`[DataHub] API FAILED:`, error.message);
      console.error(`[DataHub] Full error:`, error);
      // Flag network/timeout errors separately so the caller can verify MCBIS status
      // before marking as FAILED (order may have been received by MCBIS despite no response)
      const isNetworkError = error.message.includes('ECONNABORTED') ||
        error.message.includes('ETIMEDOUT') ||
        error.message.includes('ECONNRESET') ||
        error.message.includes('No response from API server') ||
        error.message.includes('521') ||
        error.message.includes('522');
      return {
        success: false,
        reference: reference,
        status: 'failed',
        error: error.message,
        networkError: isNetworkError
      };
    }
  },

  /**
   * Process an order from our system through the API
   * Updates order status in database
   * 
   * INCLUDES: 
   * - Balance check - if MCBIS doesn't have enough balance, order stays PENDING
   * - Duplicate prevention - orders already sent to MCBIS are never resent
   * - Atomic locking - prevents concurrent processing of same order
   * 
   * @param {string} orderId - Our internal order ID
   */
  async processOrder(orderId) {
    console.log(`[DataHub] ========== PROCESS ORDER START ==========`);
    console.log(`[DataHub] Processing order ID: ${orderId}`);
    
    // ============ DUPLICATE PREVENTION: ATOMIC CHECK ============
    // Re-fetch order with fresh data to prevent race conditions
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: { bundle: true }
    });

    if (!order) {
      console.error(`[DataHub] ERROR: Order not found: ${orderId}`);
      throw new Error('Order not found');
    }

    // CRITICAL: If order already has externalReference, it was already sent to MCBIS
    // NEVER send the same order twice!
    if (order.externalReference) {
      console.log(`[DataHub] DUPLICATE PREVENTION: Order ${orderId} already has externalReference: ${order.externalReference}`);
      console.log(`[DataHub] This order was already sent to MCBIS. Skipping to prevent duplicate.`);
      return {
        orderId,
        success: false,
        status: order.status,
        message: 'Order already sent to MCBIS (has externalReference)',
        alreadyProcessed: true,
        externalReference: order.externalReference
      };
    }

    // CRITICAL: If order status is COMPLETED or PROCESSING, don't resend
    if (order.status === 'COMPLETED') {
      console.log(`[DataHub] Order already COMPLETED, skipping`);
      return {
        orderId,
        success: false,
        status: 'COMPLETED',
        message: 'Order already completed',
        alreadyProcessed: true
      };
    }

    if (order.status === 'PROCESSING') {
      console.log(`[DataHub] Order already PROCESSING, skipping to prevent duplicate`);
      return {
        orderId,
        success: false,
        status: 'PROCESSING',
        message: 'Order already processing',
        alreadyProcessed: true
      };
    }

    if (order.status === 'CANCELLED' || order.status === 'FAILED') {
      console.log(`[DataHub] Order status is ${order.status}, skipping`);
      return {
        orderId,
        success: false,
        status: order.status,
        message: `Order is ${order.status}`,
        alreadyProcessed: true
      };
    }

    // CRITICAL: Check if apiSentAt is set (another indicator order was sent)
    if (order.apiSentAt) {
      console.log(`[DataHub] DUPLICATE PREVENTION: Order ${orderId} has apiSentAt: ${order.apiSentAt}`);
      console.log(`[DataHub] This order was already attempted. Skipping.`);
      return {
        orderId,
        success: false,
        status: order.status,
        message: 'Order already attempted (has apiSentAt)',
        alreadyProcessed: true
      };
    }

    console.log(`[DataHub] Order is safe to process:`, {
      id: order.id,
      status: order.status,
      externalReference: order.externalReference,
      apiSentAt: order.apiSentAt,
      recipientPhone: order.recipientPhone,
      bundle: order.bundle?.name,
      network: order.bundle?.network,
      dataAmount: order.bundle?.dataAmount
    });
    // ============ END DUPLICATE PREVENTION ============

    // Extract data amount from bundle (e.g., "5GB" -> 5)
    let dataAmount = 1;
    if (order.bundle?.dataAmount) {
      const match = order.bundle.dataAmount.match(/(\d+)/);
      if (match) {
        dataAmount = parseInt(match[1]);
      }
    }
    console.log(`[DataHub] Data amount extracted: ${dataAmount}GB`);

    // ============ CHECK MCBIS WALLET BALANCE ============
    // Get estimated cost (this is approximate - actual cost depends on MCBIS pricing)
    // Typical data prices: 1GB ≈ 3-5 GHS, adjust based on your MCBIS account pricing
    const estimatedCostPerGB = 5; // GHS per GB - adjust this to your MCBIS pricing
    const estimatedOrderCost = dataAmount * estimatedCostPerGB;
    
    console.log(`[DataHub] Estimated order cost: ${estimatedOrderCost} GHS (${dataAmount}GB × ${estimatedCostPerGB} GHS/GB)`);
    
    // Check MCBIS wallet balance
    const balanceResult = await this.getWalletBalance();
    
    if (!balanceResult.success) {
      console.log(`[DataHub] WARNING: Could not check MCBIS balance: ${balanceResult.error}`);
      // Continue anyway if we can't check balance - let MCBIS API handle it
    } else {
      const mcbisBalance = balanceResult.balance;
      console.log(`[DataHub] MCBIS wallet balance: ${mcbisBalance} GHS`);
      
      if (mcbisBalance < estimatedOrderCost) {
        console.log(`[DataHub] INSUFFICIENT MCBIS BALANCE!`);
        console.log(`[DataHub] Required: ${estimatedOrderCost} GHS, Available: ${mcbisBalance} GHS`);
        console.log(`[DataHub] Order ${orderId} will stay PENDING until balance is topped up`);
        
        // Update order with insufficient balance note
        await prisma.order.update({
          where: { id: orderId },
          data: {
            failureReason: `MCBIS balance insufficient (${mcbisBalance} GHS < ${estimatedOrderCost} GHS needed). Will retry when topped up.`,
            updatedAt: new Date()
          }
        });
        
        return {
          orderId,
          success: false,
          status: 'PENDING',
          message: `MCBIS wallet insufficient. Balance: ${mcbisBalance} GHS, Required: ~${estimatedOrderCost} GHS. Order will retry automatically.`,
          insufficientBalance: true,
          mcbisBalance: mcbisBalance,
          requiredAmount: estimatedOrderCost
        };
      }
      
      console.log(`[DataHub] Balance sufficient. Proceeding with order...`);
    }
    // ============ END BALANCE CHECK ============

    // Place order via API
    const result = await this.placeOrder({
      network: order.bundle?.network || 'MTN',
      phone: order.recipientPhone,
      amount: dataAmount,
      orderId: orderId
    });

    console.log(`[DataHub] placeOrder result:`, result);

    // Update order in database
    // PROCESSING = API accepted the order, waiting for delivery confirmation via auto-sync
    
    // ============ CRITICAL: INSUFFICIENT BALANCE ERROR HANDLING ============
    // If placeOrder failed due to insufficient MCBIS balance (edge case after pre-check),
    // keep order PENDING so it can be automatically retried when balance is topped up.
    // This handles race conditions where balance changed between pre-check and placeOrder call.
    
    const isInsufficientBalanceError = result.error && 
      (result.error.toLowerCase().includes('insufficient') || 
       result.error.toLowerCase().includes('balance') || 
       result.error.toLowerCase().includes('wallet'));
    
    let newStatus = result.success ? 'PROCESSING' : 'FAILED';
    let updateData = {};
    
    if (isInsufficientBalanceError) {
      console.log(`[DataHub] ⚠️ INSUFFICIENT BALANCE detected in placeOrder response`);
      console.log(`[DataHub] Keeping order PENDING for automatic retry when balance topped up`);
      newStatus = 'PENDING';
      // CRITICAL: Do NOT set externalReference or apiSentAt if insufficient balance
      // This allows retryPendingOrders to pick it up again
      updateData = {
        status: newStatus,
        failureReason: `MCBIS insufficient balance (edge case after pre-check): ${result.error}. Will retry automatically.`,
        updatedAt: new Date()
      };
    } else {
      // For all other errors (or success), proceed normally
      console.log(`[DataHub] Updating order status to: ${newStatus}`);
      console.log(`[DataHub] Storing API reference: ${result.reference}`);
      updateData = {
        status: newStatus,
        updatedAt: new Date(),
        // Only set externalReference and apiSentAt on success — on failure both stay
        // null so the retry button shows and processOrderGroup won't skip the item
        ...(result.success
          ? { externalReference: result.reference, apiSentAt: new Date() }
          : { failureReason: result.error }
        )
      };
    }
    
    await prisma.order.update({
      where: { id: orderId },
      data: updateData
    });

    console.log(`[DataHub] Order updated in database`);

    // SYNC: Also update the linked OrderItem with externalReference
    // CRITICAL: Only if order was actually sent to MCBIS (not if insufficient balance)
    if (order.reference && result.reference && result.success) {
      const orderItem = await prisma.orderItem.findFirst({
        where: { reference: { startsWith: order.reference } }
      });
      
      if (orderItem) {
        await prisma.orderItem.update({
          where: { id: orderItem.id },
          data: {
            status: newStatus,
            externalReference: result.reference,
            apiSentAt: new Date()
          }
        });
        console.log(`[DataHub] ✅ OrderItem updated with externalReference: ${result.reference}`);
      }
    }

    // Log to audit
    await prisma.auditLog.create({
      data: {
        userId: order.userId,
        action: 'API_ORDER',
        entityType: 'Order',
        entityId: orderId,
        newValues: {
          apiReference: result.reference,
          apiStatus: result.status,
          success: result.success
        }
      }
    }).catch(() => {}); // Don't fail if audit fails

    console.log(`[DataHub] ========== PROCESS ORDER END ==========`);

    return {
      orderId,
      apiReference: result.reference,
      success: result.success,
      status: newStatus,
      message: result.success ? 'Order sent to provider' : result.error
    };
  },

  /**
   * Sync order status from API
   * Call this periodically to update pending orders
   */
  async syncOrderStatus(orderId) {
    const order = await prisma.order.findUnique({
      where: { id: orderId }
    });

    // Use externalReference (the MCBIS reference) not reference (our internal ORD-xxx)
    if (!order || !order.externalReference) {
      return { success: false, error: 'Order or API reference not found' };
    }

    console.log(`[DataHub] Checking status for API reference: ${order.externalReference}`);
    const statusResult = await this.checkOrderStatus(order.externalReference);
    console.log(`[DataHub] API returned status: ${statusResult.status}`);

    if (statusResult.success) {
      // Map API status to our status
      // IMPORTANT: Compare in lowercase since API might return different cases
      let newStatus = order.status;
      const apiStatus = (statusResult.status || '').toLowerCase();
      console.log(`[DataHub] Normalized API status: '${apiStatus}'`);
      console.log(`[DataHub] Current DB status: '${order.status}'`);
      
      if (apiStatus === 'success' || apiStatus === 'completed' || apiStatus === 'delivered' || apiStatus === 'successful') {
        newStatus = 'COMPLETED';
      } else if (apiStatus === 'failed' || apiStatus === 'fail' || apiStatus === 'error') {
        newStatus = 'FAILED';
      } else if (apiStatus === 'cancelled' || apiStatus === 'canceled' || apiStatus === 'cancel') {
        newStatus = 'CANCELLED';
      } else if (apiStatus === 'pending' || apiStatus === 'processing' || apiStatus === 'initiated') {
        newStatus = 'PROCESSING';
      } else if (apiStatus) {
        // Unrecognized status — log it so nothing silently stays PROCESSING forever
        console.warn(`[DataHub] ⚠️ Unrecognized McBIS status '${apiStatus}' for order ${orderId} (ref: ${order.externalReference}) — status left unchanged as ${order.status}`);
      }
      
      console.log(`[DataHub] Computed newStatus: '${newStatus}'`);
      
      // PREVENT STATUS DOWNGRADES - never revert manually completed/failed orders
      // Only allow: PENDING → PROCESSING → COMPLETED, or any → FAILED
      const statusPriority = { 'PENDING': 1, 'PROCESSING': 2, 'COMPLETED': 3, 'FAILED': 3, 'CANCELLED': 3 };
      const currentPriority = statusPriority[order.status] || 0;
      const newPriority = statusPriority[newStatus] || 0;
      
      if (newPriority < currentPriority) {
        console.log(`[DataHub] ⚠️ Skipping downgrade: ${order.status} → ${newStatus} (manual override preserved)`);
        return { success: true, status: order.status, message: 'Status preserved (manual override)' };
      }

      // ALWAYS sync related tables (OrderItem, StorefrontOrder) even if Order status unchanged
      // This fixes cases where Order was updated but related tables weren't
      const shouldSyncRelatedTables = order.reference || order.storefrontOrderId;

      if (newStatus !== order.status) {
        console.log(`[DataHub] ✅ Status change: ${order.status} → ${newStatus}`);
        await prisma.order.update({
          where: { id: orderId },
          data: { 
            status: newStatus,
            externalStatus: statusResult.status,
            ...(newStatus === 'COMPLETED' ? { apiConfirmedAt: new Date() } : {})
          }
        });
        console.log(`[DataHub] ✅ Order table updated!`);
      } else {
        console.log(`[DataHub] Order status unchanged (${order.status})`);
      }

      // SYNC ALL RELATED TABLES (always, not just on status change)
      // 1. Update linked StorefrontOrder status if exists
      if (order.storefrontOrderId) {
        const storefrontOrder = await prisma.storefrontOrder.findUnique({
          where: { id: order.storefrontOrderId }
        });
        if (storefrontOrder && storefrontOrder.status !== newStatus) {
          await prisma.storefrontOrder.update({
            where: { id: order.storefrontOrderId },
            data: { status: newStatus }
          });
          console.log(`[DataHub] ✅ StorefrontOrder status synced: ${storefrontOrder.status} → ${newStatus}`);
        }
      }

      // 2. Update OrderItem that matches this order's reference
      // The Order.reference is the OrderGroup displayId (e.g., ORD-000123)
      if (order.reference) {
        const orderItem = await prisma.orderItem.findFirst({
          where: { 
            reference: { startsWith: order.reference }
          }
        });
        
        if (orderItem && (orderItem.status !== newStatus || !orderItem.externalReference)) {
          // PREVENT STATUS DOWNGRADES on OrderItem too (e.g., admin manually completed)
          const itemPriority = { 'PENDING': 1, 'PROCESSING': 2, 'COMPLETED': 3, 'FAILED': 3, 'CANCELLED': 3 };
          const curPri = itemPriority[orderItem.status] || 0;
          const newPri = itemPriority[newStatus] || 0;
          
          if (newPri < curPri) {
            console.log(`[DataHub] ⚠️ Skipping OrderItem downgrade: ${orderItem.status} → ${newStatus} (manual override preserved)`);
          } else {
            await prisma.orderItem.update({
              where: { id: orderItem.id },
              data: { 
                status: newStatus,
                externalStatus: statusResult.status,
                externalReference: order.externalReference,
                ...(newStatus === 'COMPLETED' ? { apiConfirmedAt: new Date() } : {})
              }
            });
            console.log(`[DataHub] ✅ OrderItem synced: ${orderItem.status} → ${newStatus}, externalRef: ${order.externalReference}`);

            // 3. Recalculate OrderGroup summary status
            const orderGroupService = require('./order-group.service');
            await orderGroupService.recalculateGroupStatus(orderItem.orderGroupId);
            console.log(`[DataHub] ✅ OrderGroup status recalculated`);
          }
        }
      }

      // If order completed and has storefront order, credit agent profit
      if (newStatus === 'COMPLETED' && order.storefrontOrderId) {
        try {
          const financialOrderService = require('./financial-order.service');
          const profitResult = await financialOrderService.processCompletedStorefrontOrder(orderId);
          if (profitResult.credited) {
            console.log(`[DataHub] ✅ Agent profit credited: GHS ${profitResult.amount}`);
          }
        } catch (err) {
          console.error(`[DataHub] Failed to credit profit for order ${orderId}:`, err.message);
        }
      }
      
      // If order failed/cancelled and has storefront order, cancel pending profit
      if ((newStatus === 'FAILED' || newStatus === 'CANCELLED') && order.storefrontOrderId) {
        try {
          const profitPayoutService = require('./profit-payout.service');
          await profitPayoutService.cancelPendingProfit(order.storefrontOrderId, `Order ${newStatus.toLowerCase()}`);
        } catch (err) {
          console.error(`[DataHub] Failed to cancel pending profit for order ${orderId}:`, err.message);
        }
      }

      // If order failed/cancelled, auto-refund the user's wallet
      if ((newStatus === 'FAILED' || newStatus === 'CANCELLED') && newStatus !== order.status) {
        try {
          if (order.totalPrice > 0) {
            const walletService = require('./wallet.service');
            await walletService.creditWallet(
              order.userId,
              order.totalPrice,
              `Auto-refund: ${order.recipientPhone} rejected. Order ${order.reference || orderId}`,
              `MCBIS-REFUND-${order.reference || orderId}`,
              { entryType: 'REFUND', orderId }
            );
            console.log(`[DataHub] ✅ Auto-refunded GHS ${order.totalPrice} to user ${order.userId} (${newStatus})`);
          }
        } catch (refundErr) {
          if (refundErr.message !== 'Duplicate transaction reference') {
            console.error(`[DataHub] ⚠️ Auto-refund failed for order ${order.reference || orderId}:`, refundErr.message);
          } else {
            console.log(`[DataHub] ⏩ Refund already issued for ${order.reference || orderId} — skipping duplicate`);
          }
        }
      }

      return {
        success: true,
        previousStatus: order.status,
        newStatus: newStatus,
        apiStatus: statusResult.status
      };
    }

    return statusResult;
  },

  /**
   * Sync all pending orders that have an external reference (were pushed to API)
   * Runs every minute via auto-sync
   */
  async syncAllPendingOrders(options = {}) {
    const { catchUp = false } = options;
    // First, try to process orders that are PENDING and haven't been pushed yet
    // (likely due to insufficient MCBIS balance earlier)
    await this.retryPendingOrders();
    
    const orderQuery = {
      where: {
        status: { in: ['PROCESSING', 'PENDING'] },
        // Only sync orders that were actually pushed to API (have externalReference)
        externalReference: { not: null }
      },
      orderBy: { createdAt: catchUp ? 'asc' : 'desc' }
    };
    if (!catchUp) orderQuery.take = 30; // Steady-state: limit to prevent API overload
    const pendingOrders = await prisma.order.findMany(orderQuery);
    if (catchUp) console.log(`[DataHub] Catch-up mode: processing all ${pendingOrders.length} backlogged orders (oldest first)`);

    console.log(`[DataHub] Found ${pendingOrders.length} orders with API references to sync`);
    
    const results = [];
    for (const order of pendingOrders) {
      // Abort cycle early if MCBIS has rate-limited us
      if (isMcbisRateLimited()) {
        console.warn(`[DataHub] MCBIS rate-limited — stopping legacy sync cycle after ${results.length} order(s)`);
        break;
      }
      try {
        const result = await this.syncOrderStatus(order.id);
        results.push({ orderId: order.id, ...result });
        // 400ms delay keeps total cycle within MCBIS rate limits
        await new Promise(resolve => setTimeout(resolve, 400));
      } catch (error) {
        results.push({ orderId: order.id, success: false, error: error.message });
      }
    }

    return {
      synced: results.length,
      results
    };
  },

  /**
   * Retry pending orders that haven't been pushed to MCBIS yet
   * These are orders waiting for MCBIS balance to be topped up
   * 
   * SAFETY: Multiple checks to prevent duplicate orders:
   * 1. Only fetches orders with status=PENDING AND externalReference=null AND apiSentAt=null
   * 2. Re-checks each order before processing (in processOrder)
   * 3. Uses 30-second grace period to avoid race conditions
   */
  async retryPendingOrders() {
    // Find PENDING orders that were NEVER sent to API
    const pendingOrders = await prisma.order.findMany({
      where: {
        status: 'PENDING',
        externalReference: null,
        apiSentAt: null,
        createdAt: { lt: new Date(Date.now() - 5 * 60 * 1000) }  // 5 min grace period — give instant auto-process time
      },
      include: { bundle: true },
      take: 20,
      orderBy: { createdAt: 'asc' }
    });

    if (pendingOrders.length === 0) {
      return { retried: 0, results: [] };
    }

    console.log(`[Retry] Found ${pendingOrders.length} pending orders eligible for retry`);

    // Per-network routing helpers
    const settingsController = require('../controllers/settings.controller');
    const ckgodswayService = require('./ckgodsway.service');
    const siteSettings = settingsController.getSiteSettings();
    const isTruthy = (val) => val === true || val === 'true' || val === 1;
    const getNetworkToggleKey = (prefix, network) => {
      const n = (network || '').toLowerCase().replace(/\s+/g, '');
      if (n === 'mtn') return `${prefix}_mtnAPI`;
      if (n === 'telecel' || n === 'vodafone') return `${prefix}_telecelAPI`;
      if (n === 'airteltigo' || n === 'at') return `${prefix}_airteltigoAPI`;
      if (n === 'at-bigtime' || n === 'atbigtime' || n === 'at-big time' || n.includes('big time') || n.includes('bigtime')) return `${prefix}_bigtimeAPI`;
      return null;
    };
    const PROVIDERS = [
      { key: 'ckgodswayAPI', name: 'CKGODSWAY', prefix: 'ckgodsway', service: ckgodswayService },
      { key: 'mcbisAPI', name: 'MCBIS', prefix: 'mcbis', service: this }
    ];
    const getProviderForNetwork = (network) => {
      for (const p of PROVIDERS) {
        if (!isTruthy(siteSettings[p.key])) continue;
        const toggleKey = getNetworkToggleKey(p.prefix, network);
        if (toggleKey && siteSettings[toggleKey] === false) continue;
        return p;
      }
      return null;
    };

    const results = [];

    for (const order of pendingOrders) {
      const freshOrder = await prisma.order.findUnique({ where: { id: order.id } });
      if (!freshOrder || freshOrder.status !== 'PENDING' || freshOrder.externalReference || freshOrder.apiSentAt) {
        continue;
      }

      // CRITICAL: Skip if a linked OrderItem already exists for this order and has been
      // sent or completed. The OrderItem system will handle fulfilment — if we also send
      // via the legacy Order path we create a duplicate delivery to the customer.
      if (freshOrder.reference) {
        const linkedItem = await prisma.orderItem.findFirst({
          where: {
            reference: { startsWith: freshOrder.reference + '-' },
            status: { in: ['PROCESSING', 'COMPLETED'] }
          },
          select: { id: true, reference: true, status: true, externalReference: true }
        });
        if (linkedItem) {
          console.log(`[Retry] Skipping Order ${freshOrder.reference} — linked OrderItem ${linkedItem.reference} is already ${linkedItem.status}. Marking Order COMPLETED to prevent future retries.`);
          await prisma.order.update({
            where: { id: freshOrder.id },
            data: {
              status: linkedItem.status === 'COMPLETED' ? 'COMPLETED' : 'PROCESSING',
              externalReference: freshOrder.externalReference || linkedItem.externalReference || null,
              ...(linkedItem.status === 'COMPLETED' ? { apiConfirmedAt: new Date() } : {})
            }
          });
          continue;
        }
      }

      const network = order.bundle?.network || 'MTN';
      const provider = getProviderForNetwork(network);
      if (!provider) {
        console.log(`[Retry] No provider enabled for ${network}, skipping order ${order.id}`);
        continue;
      }

      let dataAmount = 1;
      if (order.bundle?.dataAmount) {
        const match = order.bundle.dataAmount.match(/(\d+)/);
        if (match) dataAmount = parseInt(match[1]);
      }

      try {
        console.log(`[Retry] Retrying order ${order.id} (${order.bundle?.name}) via ${provider.name}...`);
        
        // Atomic lock
        const claim = await prisma.order.updateMany({
          where: { id: order.id, apiSentAt: null, status: 'PENDING', externalReference: null },
          data: { apiSentAt: new Date() }
        });
        if (claim.count === 0) {
          console.log(`[Retry] Order ${order.id} already claimed, skipping`);
          continue;
        }
        
        const result = await provider.service.placeOrder({
          network: network,
          phone: order.recipientPhone,
          amount: dataAmount,
          orderId: order.id
        });
        
        // CKGodsway has no idempotency — each retry creates a NEW order on their end.
        // On failure: mark FAILED so retryPendingOrders never re-queues it.
        // For MCBIS: keep existing behavior (reset apiSentAt, stay PENDING for retry).
        const isCkGodsway = provider.name === 'CKGODSWAY';
        await prisma.order.update({
          where: { id: order.id },
          data: {
            status: result.success ? 'PROCESSING' : (isCkGodsway ? 'FAILED' : 'PENDING'),
            externalReference: result.reference || null,
            ...(result.success ? {} : { failureReason: result.error || 'API failed' })
          }
        });
        
        if (!result.success && !isCkGodsway) {
          await prisma.order.update({ where: { id: order.id }, data: { apiSentAt: null } });
        }
        
        results.push({ orderId: order.id, success: result.success, provider: provider.name });
        console.log(`[Retry] Order ${order.id}: ${result.success ? 'SUCCESS' : result.error} via ${provider.name}`);
        
        await new Promise(resolve => setTimeout(resolve, 500));
      } catch (error) {
        console.error(`[Retry] Error retrying order ${order.id}:`, error.message);
        const isCkGodsway = provider?.name === 'CKGODSWAY';
        if (isCkGodsway) {
          // Don't re-queue CKGodsway orders — mark FAILED to stop retry loop
          await prisma.order.update({ where: { id: order.id }, data: { status: 'FAILED', failureReason: error.message } }).catch(() => {});
        } else {
          await prisma.order.update({ where: { id: order.id }, data: { apiSentAt: null } }).catch(() => {});
        }
        results.push({ orderId: order.id, success: false, error: error.message });
      }
    }

    console.log(`[Retry] Complete: ${results.length} orders attempted`);
    return { retried: results.length, results };
  }
};

module.exports = datahubService;
