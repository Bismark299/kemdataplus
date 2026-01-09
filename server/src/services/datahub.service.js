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

/**
 * Make API request to McbisSolution
 */
async function apiRequest(endpoint, method = 'GET', body = null) {
  const config = getApiConfig();
  const url = `${config.url}${endpoint}`;
  
  console.log(`[DataHub] Request: ${method} ${url}`);
  
  const options = {
    method,
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.token}`
    }
  };

  if (body && method !== 'GET') {
    options.body = JSON.stringify(body);
  }

  try {
    const response = await fetch(url, options);
    const text = await response.text();
    
    // Check if response is HTML (error page)
    if (text.startsWith('<!DOCTYPE') || text.startsWith('<html')) {
      console.error(`[DataHub] Received HTML instead of JSON. Status: ${response.status}`);
      throw new Error(`API returned HTML error page. Check API URL and token. Status: ${response.status}`);
    }
    
    // Try to parse JSON
    let data;
    try {
      data = JSON.parse(text);
    } catch (parseError) {
      console.error(`[DataHub] Invalid JSON response:`, text.substring(0, 200));
      throw new Error(`Invalid JSON response from API`);
    }
    
    if (!response.ok) {
      throw new Error(data.message || data.error || `API Error: ${response.status}`);
    }
    
    return data;
  } catch (error) {
    console.error(`DataHub API Error [${endpoint}]:`, error.message);
    throw error;
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
    
    console.log('[DataHub Test] Testing connection...');
    console.log('[DataHub Test] URL:', url);
    console.log('[DataHub Test] Token (first 10 chars):', config.token?.substring(0, 10) + '...');
    
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.token}`
        }
      });
      
      const text = await response.text();
      console.log('[DataHub Test] Status:', response.status);
      console.log('[DataHub Test] Response (first 500 chars):', text.substring(0, 500));
      
      // Check if HTML
      if (text.startsWith('<!DOCTYPE') || text.startsWith('<html') || text.includes('<html')) {
        return {
          success: false,
          error: `API returned HTML (likely error page). Status: ${response.status}`,
          status: response.status,
          hint: response.status === 401 ? 'Token might be invalid or expired' : 
                response.status === 404 ? 'API endpoint not found - check URL' :
                'Check API URL and token',
          responsePreview: text.substring(0, 300)
        };
      }
      
      // Try to parse JSON
      let data;
      try {
        data = JSON.parse(text);
      } catch (e) {
        return {
          success: false,
          error: 'Response is not valid JSON',
          responsePreview: text.substring(0, 300)
        };
      }
      
      return {
        success: true,
        message: 'Connection successful!',
        data: data,
        balance: data.data?.walletBalance
      };
    } catch (error) {
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
      return {
        success: true,
        status: result.data?.status || result.data?.order?.status,
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
    // Map network to API format
    const apiNetwork = NETWORK_MAP[network];
    if (!apiNetwork) {
      throw new Error(`Unsupported network: ${network}`);
    }

    // Format phone number (remove country code if present)
    let formattedPhone = phone.replace(/\s+/g, '');
    if (formattedPhone.startsWith('+233')) {
      formattedPhone = '0' + formattedPhone.slice(4);
    } else if (formattedPhone.startsWith('233')) {
      formattedPhone = '0' + formattedPhone.slice(3);
    }

    // Generate reference
    const reference = generateReference();

    try {
      const result = await apiRequest('/placeOrder', 'POST', {
        network: apiNetwork,
        reference: reference,
        receiver: formattedPhone,
        amount: amount
      });

      // Log successful order
      console.log(`[DataHub] Order placed: ${reference} - ${amount}GB to ${formattedPhone} (${apiNetwork})`);

      return {
        success: true,
        reference: reference,
        status: result.data?.status || 'pending',
        message: result.message,
        data: result.data
      };
    } catch (error) {
      console.error(`[DataHub] Order failed: ${error.message}`);
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
   * @param {string} orderId - Our internal order ID
   */
  async processOrder(orderId) {
    // Get order from database
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: { bundle: true }
    });

    if (!order) {
      throw new Error('Order not found');
    }

    if (order.status === 'COMPLETED') {
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

    // Place order via API
    const result = await this.placeOrder({
      network: order.bundle?.network || 'MTN',
      phone: order.recipientPhone,
      amount: dataAmount,
      orderId: orderId
    });

    // Update order in database
    const newStatus = result.success ? 'PROCESSING' : 'FAILED';
    
    await prisma.order.update({
      where: { id: orderId },
      data: {
        status: newStatus,
        reference: result.reference,
        apiResponse: JSON.stringify(result),
        updatedAt: new Date()
      }
    });

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

    if (!order || !order.reference) {
      return { success: false, error: 'Order or reference not found' };
    }

    const statusResult = await this.checkOrderStatus(order.reference);

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
        await prisma.order.update({
          where: { id: orderId },
          data: { status: newStatus }
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
   * Sync all pending orders
   */
  async syncAllPendingOrders() {
    const pendingOrders = await prisma.order.findMany({
      where: {
        status: { in: ['PROCESSING', 'PENDING'] },
        reference: { not: null }
      },
      take: 50 // Limit to prevent API overload
    });

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
  }
};

module.exports = datahubService;
