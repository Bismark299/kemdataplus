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

const { PrismaClient } = require('@prisma/client');
const fs = require('fs');
const path = require('path');
const prisma = new PrismaClient();

// Helper to get API config from settings
// Priority: Environment variables > settings.json > defaults
function getApiConfig() {
  // Check environment variables FIRST (more reliable for cloud deployment)
  if (process.env.DATAHUB_API_TOKEN) {
    console.log('[DataHub] Using environment variables for config');
    return {
      url: process.env.DATAHUB_API_URL || 'https://datahub.mcbissolution.com/api/v1',
      token: process.env.DATAHUB_API_TOKEN
    };
  }
  
  // Fallback to settings.json
  try {
    const settingsPath = path.join(__dirname, '../../settings.json');
    console.log('[DataHub] Reading settings from:', settingsPath);
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    
    const token = settings.adminSettings?.mcbisApiToken || settings.adminSettings?.apiKey || '';
    
    if (token) {
      console.log('[DataHub] Using settings.json for config');
      return {
        url: settings.adminSettings?.mcbisApiUrl || settings.adminSettings?.apiUrl || 'https://datahub.mcbissolution.com/api/v1',
        token: token
      };
    }
  } catch (e) {
    console.log('[DataHub] Settings file error:', e.message);
  }
  
  console.log('[DataHub] WARNING: No API token found!');
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
  'AIRTELTIGO': 'atbigtime',  // or 'atpremium' depending on bundle type
  'AirtelTigo': 'atbigtime',
  'airteltigo': 'atbigtime',
  'AT': 'atbigtime'
};

const axios = require('axios');

/**
 * Make API request to McbisSolution using axios
 * Axios handles redirects and cookies better than native fetch
 */
async function apiRequest(endpoint, method = 'GET', body = null) {
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
    timeout: 30000,
    maxRedirects: 5
  };

  if (body && method !== 'GET') {
    axiosConfig.data = body;
  }

  try {
    const response = await axios(axiosConfig);
    console.log(`[DataHub] Response status: ${response.status}`);
    return response.data;
  } catch (error) {
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
      // Request made but no response
      throw new Error('No response from API server');
    } else {
      throw new Error(error.message);
    }
  }
}

/**
 * Generate unique reference for order
 */
function generateReference() {
  return `KEM${Date.now()}${Math.random().toString(36).substr(2, 6).toUpperCase()}`;
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
    console.log('[DataHub Test] Token (first 10 chars):', config.token?.substring(0, 10) + '...');
    
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
        timeout: 30000
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
      
      return {
        success: false,
        error: error.message,
        hint: 'Network error - check if API URL is correct'
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
      const orderStatus = result.data?.order?.status || result.data?.status || 'unknown';
      
      console.log(`[DataHub] Extracted order status: ${orderStatus}`);
      
      return {
        success: true,
        status: orderStatus,
        order: result.data?.order,
        raw: result
      };
    } catch (error) {
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
      return {
        success: false,
        reference: reference,
        status: 'failed',
        error: error.message
      };
    }
  },

  /**
   * Process an order from our system through the API
   * Updates order status in database
   * 
   * NOW INCLUDES: Balance check - if MCBIS doesn't have enough balance,
   * order stays PENDING and will be retried later
   * 
   * @param {string} orderId - Our internal order ID
   */
  async processOrder(orderId) {
    console.log(`[DataHub] ========== PROCESS ORDER START ==========`);
    console.log(`[DataHub] Processing order ID: ${orderId}`);
    
    // Get order from database
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: { bundle: true }
    });

    if (!order) {
      console.error(`[DataHub] ERROR: Order not found: ${orderId}`);
      throw new Error('Order not found');
    }

    console.log(`[DataHub] Order found:`, {
      id: order.id,
      status: order.status,
      recipientPhone: order.recipientPhone,
      bundle: order.bundle?.name,
      network: order.bundle?.network,
      dataAmount: order.bundle?.dataAmount
    });

    if (order.status === 'COMPLETED') {
      console.log(`[DataHub] Order already completed, skipping`);
      throw new Error('Order already completed');
    }

    // Extract data amount from bundle (e.g., "5GB" -> 5)
    let dataAmount = 1;
    if (order.bundle?.dataAmount) {
      const match = order.bundle.dataAmount.match(/(\d+)/);
      if (match) {
        dataAmount = parseInt(match[1]);
      }
    }
    console.log(`[DataHub] Data amount extracted: ${dataAmount}GB`);

    // ============ NEW: CHECK MCBIS WALLET BALANCE ============
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
    const newStatus = result.success ? 'PROCESSING' : 'FAILED';
    console.log(`[DataHub] Updating order status to: ${newStatus}`);
    console.log(`[DataHub] Storing API reference: ${result.reference}`);
    
    await prisma.order.update({
      where: { id: orderId },
      data: {
        status: newStatus,
        // CRITICAL: Store the MCBIS API reference for status checks
        // This is the reference returned by McbisSolution, NOT our internal ORD-xxx reference
        externalReference: result.reference,
        apiSentAt: new Date(),
        updatedAt: new Date(),
        ...(result.success ? {} : { failureReason: result.error })
      }
    });

    console.log(`[DataHub] Order updated in database`);

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
      let newStatus = order.status;
      if (statusResult.status === 'success' || statusResult.status === 'completed') {
        newStatus = 'COMPLETED';
      } else if (statusResult.status === 'failed') {
        newStatus = 'FAILED';
      } else if (statusResult.status === 'pending' || statusResult.status === 'processing') {
        newStatus = 'PROCESSING';
      }

      if (newStatus !== order.status) {
        console.log(`[DataHub] Status change: ${order.status} → ${newStatus}`);
        await prisma.order.update({
          where: { id: orderId },
          data: { 
            status: newStatus,
            externalStatus: statusResult.status,
            ...(newStatus === 'COMPLETED' ? { apiConfirmedAt: new Date() } : {})
          }
        });
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
  async syncAllPendingOrders() {
    // First, try to process orders that are PENDING and haven't been pushed yet
    // (likely due to insufficient MCBIS balance earlier)
    await this.retryPendingOrders();
    
    const pendingOrders = await prisma.order.findMany({
      where: {
        status: { in: ['PROCESSING', 'PENDING'] },
        // Only sync orders that were actually pushed to API (have externalReference)
        externalReference: { not: null }
      },
      take: 50 // Limit to prevent API overload
    });

    console.log(`[DataHub] Found ${pendingOrders.length} orders with API references to sync`);
    
    const results = [];
    for (const order of pendingOrders) {
      try {
        const result = await this.syncOrderStatus(order.id);
        results.push({ orderId: order.id, ...result });
        // Small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 200));
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
   */
  async retryPendingOrders() {
    // Find PENDING orders without externalReference (never pushed to API)
    const pendingOrders = await prisma.order.findMany({
      where: {
        status: 'PENDING',
        externalReference: null,
        // Only orders created more than 30 seconds ago (to avoid race conditions with new orders)
        createdAt: { lt: new Date(Date.now() - 30000) }
      },
      include: { bundle: true },
      take: 20,
      orderBy: { createdAt: 'asc' } // Oldest first
    });

    if (pendingOrders.length === 0) {
      return { retried: 0, results: [] };
    }

    console.log(`[DataHub] Found ${pendingOrders.length} pending orders to retry`);

    // Check MCBIS balance once
    const balanceResult = await this.getWalletBalance();
    if (!balanceResult.success) {
      console.log(`[DataHub] Cannot check MCBIS balance for retry: ${balanceResult.error}`);
      return { retried: 0, error: balanceResult.error };
    }

    console.log(`[DataHub] MCBIS balance for retry: ${balanceResult.balance} GHS`);

    const results = [];
    let runningBalance = balanceResult.balance;

    for (const order of pendingOrders) {
      // Estimate cost
      let dataAmount = 1;
      if (order.bundle?.dataAmount) {
        const match = order.bundle.dataAmount.match(/(\d+)/);
        if (match) dataAmount = parseInt(match[1]);
      }
      const estimatedCost = dataAmount * 5; // 5 GHS per GB estimate

      if (runningBalance < estimatedCost) {
        console.log(`[DataHub] Stopping retry - insufficient balance for remaining orders`);
        break;
      }

      try {
        console.log(`[DataHub] Retrying order ${order.id}...`);
        const result = await this.processOrder(order.id);
        results.push({ orderId: order.id, ...result });
        
        if (result.success) {
          runningBalance -= estimatedCost; // Deduct estimated cost
        }
        
        // Small delay between orders
        await new Promise(resolve => setTimeout(resolve, 500));
      } catch (error) {
        results.push({ orderId: order.id, success: false, error: error.message });
      }
    }

    console.log(`[DataHub] Retry complete: ${results.length} orders attempted`);
    return { retried: results.length, results };
  }
};

module.exports = datahubService;
