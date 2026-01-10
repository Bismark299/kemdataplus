/**
 * EasyDataGH API Service
 * 
 * Base URL: https://easydatagh.pro/wp-json/custom/v1
 * Auth: Basic Authentication (Base64 encoded username:password)
 * 
 * Endpoints:
 * - POST /place-order - Place data bundle order
 * - GET /order-status?order_reference=xxx - Check order status
 * - GET /balance - Check wallet balance
 */

const fs = require('fs');
const path = require('path');

// Read settings from settings.json
function getSettings() {
  try {
    const settingsPath = path.join(__dirname, '../../settings.json');
    console.log('[EasyData] Reading settings from:', settingsPath);
    
    if (fs.existsSync(settingsPath)) {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      console.log('[EasyData] Using settings.json for config');
      return {
        baseUrl: settings.adminSettings?.easyDataApiUrl || 'https://easydatagh.pro/wp-json/custom/v1',
        username: settings.adminSettings?.easyDataUsername || '',
        password: settings.adminSettings?.easyDataPassword || ''
      };
    }
  } catch (error) {
    console.error('[EasyData] Error reading settings:', error.message);
  }
  
  return {
    baseUrl: 'https://easydatagh.pro/wp-json/custom/v1',
    username: '',
    password: ''
  };
}

// Get Basic Auth header
function getAuthHeader() {
  const settings = getSettings();
  const credentials = `${settings.username}:${settings.password}`;
  const base64Credentials = Buffer.from(credentials).toString('base64');
  return `Basic ${base64Credentials}`;
}

// Make API request
async function makeRequest(endpoint, options = {}) {
  const settings = getSettings();
  const url = `${settings.baseUrl}${endpoint}`;
  
  const headers = {
    'Authorization': getAuthHeader(),
    'Content-Type': 'application/json',
    ...options.headers
  };
  
  console.log(`[EasyData] Request: ${options.method || 'GET'} ${url}`);
  
  try {
    const response = await fetch(url, {
      ...options,
      headers
    });
    
    console.log(`[EasyData] Response status: ${response.status}`);
    
    const data = await response.json();
    
    if (!response.ok) {
      throw new Error(data.message || `HTTP ${response.status}`);
    }
    
    return data;
  } catch (error) {
    console.error(`[EasyData] Request failed:`, error.message);
    throw error;
  }
}

const easyDataService = {
  /**
   * Check wallet balance
   * GET /balance
   */
  async getWalletBalance() {
    try {
      const data = await makeRequest('/balance');
      
      return {
        success: data.status === 'success',
        balance: parseFloat(data.balance) || 0,
        currency: data.currency || 'GHS'
      };
    } catch (error) {
      console.error('[EasyData] Balance check failed:', error.message);
      return {
        success: false,
        balance: 0,
        error: error.message
      };
    }
  },

  /**
   * Place data bundle order
   * POST /place-order
   * 
   * @param {Object} params
   * @param {string} params.network - mtn, telecel, ishare, bigtime
   * @param {string} params.phone - Recipient phone number
   * @param {number} params.amount - Data bundle size in GB
   * @param {string} params.orderId - Unique order reference ID
   */
  async placeOrder({ network, phone, amount, orderId }) {
    try {
      // Map network names to EasyDataGH format
      let mappedNetwork = (network || 'mtn').toLowerCase();
      if (mappedNetwork === 'vodafone') mappedNetwork = 'telecel';
      if (mappedNetwork === 'airteltigo' || mappedNetwork === 'at') mappedNetwork = 'bigtime';
      
      // Clean phone number (remove +233 prefix if present)
      let cleanPhone = phone.replace(/^\+233/, '0').replace(/^233/, '0');
      if (!cleanPhone.startsWith('0')) cleanPhone = '0' + cleanPhone;
      
      console.log(`[EasyData] Placing order: ${mappedNetwork} ${cleanPhone} ${amount}GB (ref: ${orderId})`);
      
      const data = await makeRequest('/place-order', {
        method: 'POST',
        body: JSON.stringify({
          network: mappedNetwork,
          recipient: cleanPhone,
          package_size: parseInt(amount),
          order_id: orderId
        })
      });
      
      if (data.status === 'success') {
        console.log(`[EasyData] Order success: ${data.reference}, New balance: ${data.new_balance}`);
        return {
          success: true,
          reference: data.reference || orderId,
          externalOrderId: data.order_id,
          newBalance: data.new_balance,
          message: data.message
        };
      } else {
        throw new Error(data.message || 'Order failed');
      }
    } catch (error) {
      console.error('[EasyData] Place order failed:', error.message);
      return {
        success: false,
        error: error.message
      };
    }
  },

  /**
   * Check order status
   * GET /order-status?order_reference=xxx
   * 
   * @param {string} orderReference - The order reference ID
   */
  async checkOrderStatus(orderReference) {
    try {
      const data = await makeRequest(`/order-status?order_reference=${encodeURIComponent(orderReference)}`);
      
      return {
        success: data.status === 'success',
        orderStatus: data.order_status, // 'completed', 'pending', 'failed'
        reference: data.reference,
        recipient: data.recipient
      };
    } catch (error) {
      console.error('[EasyData] Status check failed:', error.message);
      return {
        success: false,
        error: error.message
      };
    }
  },

  /**
   * Test connection and credentials
   */
  async testConnection() {
    try {
      const result = await this.getWalletBalance();
      if (result.success) {
        return {
          success: true,
          message: `Connected! Balance: ${result.balance} ${result.currency}`
        };
      } else {
        return {
          success: false,
          message: result.error || 'Connection failed'
        };
      }
    } catch (error) {
      return {
        success: false,
        message: error.message
      };
    }
  }
};

module.exports = easyDataService;
