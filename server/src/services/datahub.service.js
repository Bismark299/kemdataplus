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
const prisma = new PrismaClient();

// API Configuration
const API_BASE_URL = 'https://datahub.mcbissolution.com/api/v1';
const API_TOKEN = process.env.DATAHUB_API_TOKEN || '44|XWxomstKxT6Evxv2FUpvBq3uDs3yukPT4iFQSrsc894d387f';

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
  const url = `${API_BASE_URL}${endpoint}`;
  
  const options = {
    method,
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${API_TOKEN}`
    }
  };

  if (body && method !== 'GET') {
    options.body = JSON.stringify(body);
  }

  try {
    const response = await fetch(url, options);
    const data = await response.json();
    
    if (!response.ok) {
      throw new Error(data.message || `API Error: ${response.status}`);
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
