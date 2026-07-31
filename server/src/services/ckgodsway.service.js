/**
 * CK-Godsway API Service
 * 
 * Base URL: https://console.ckgodsway.com/api
 * Auth: X-API-Key header
 * 
 * Endpoints:
 * - POST /data-purchase - Place data bundle order (returns balance in response)
 * - GET  /external/order-status?reference=xxx - Check order status
 * 
 * Network Keys:
 * - MTN        → YELLO
 * - AirtelTigo → AT_PREMIUM (iShare/instant)
 * - Telecel    → TELECEL
 * - AT BigTime → AT_BIGTIME
 */

const fs = require('fs');
const path = require('path');

// Network mapping (our system -> CK-Godsway API)
const NETWORK_MAP = {
  'MTN': 'YELLO',
  'mtn': 'YELLO',
  'TELECEL': 'TELECEL',
  'telecel': 'TELECEL',
  'Telecel': 'TELECEL',
  'AIRTELTIGO': 'AT_PREMIUM',
  'AirtelTigo': 'AT_PREMIUM',
  'airteltigo': 'AT_PREMIUM',
  'AT': 'AT_PREMIUM',
  'AT- BIG TIME': 'AT_BIGTIME',
  'AT-BIG TIME': 'AT_BIGTIME',
  'AT-BIGTIME': 'AT_BIGTIME'
};

// Read settings from settings.json
function getSettings() {
  // Check environment variables first
  if (process.env.CKGODSWAY_API_KEY) {
    return {
      baseUrl: process.env.CKGODSWAY_API_URL || 'https://console.ckgodsway.com/api',
      apiKey: process.env.CKGODSWAY_API_KEY
    };
  }

  try {
    const settingsPath = path.join(__dirname, '../../settings.json');
    if (fs.existsSync(settingsPath)) {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      return {
        baseUrl: settings.adminSettings?.ckgodswayApiUrl || 'https://console.ckgodsway.com/api',
        apiKey: settings.adminSettings?.ckgodswayApiKey || ''
      };
    }
  } catch (error) {
    console.error('[CKGodsway] Error reading settings:', error.message);
  }

  return {
    baseUrl: 'https://console.ckgodsway.com/api',
    apiKey: ''
  };
}

// Make API request
async function makeRequest(endpoint, options = {}) {
  const settings = getSettings();
  const url = `${settings.baseUrl}${endpoint}`;

  const headers = {
    'X-API-Key': settings.apiKey,
    'Content-Type': 'application/json',
    ...options.headers
  };

  console.log(`[CKGodsway] Request: ${options.method || 'GET'} ${url}`);

  try {
    const response = await fetch(url, {
      ...options,
      headers
    });

    console.log(`[CKGodsway] Response status: ${response.status}`);

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || data.message || `HTTP ${response.status}`);
    }

    return data;
  } catch (error) {
    console.error(`[CKGodsway] Request failed:`, error.message);
    throw error;
  }
}

// In-memory cache for last known balance (updated after each order)
let lastKnownBalance = null;

const ckgodswayService = {
  /**
   * Get wallet balance
   * Note: CK-Godsway has no dedicated balance endpoint.
   * Balance is only returned in /data-purchase responses.
   * This returns the last known balance from the most recent order.
   */
  async getWalletBalance() {
    if (lastKnownBalance !== null) {
      return {
        success: true,
        balance: lastKnownBalance,
        currency: 'GHS',
        note: 'Last known balance from most recent order'
      };
    }
    return {
      success: true,
      balance: 0,
      currency: 'GHS',
      note: 'No balance data yet — place an order to retrieve balance'
    };
  },

  /**
   * Place data bundle order
   * POST /data-purchase
   * 
   * @param {Object} params
   * @param {string} params.network - Network name (MTN, Telecel, AirtelTigo)
   * @param {string} params.phone - Recipient phone number
   * @param {number} params.amount - Data bundle size in GB
   * @param {string} params.orderId - Internal order reference
   */
  async placeOrder({ network, phone, amount, orderId }) {
    try {
      // Map network name to CK-Godsway networkKey
      const networkKey = NETWORK_MAP[(network || '').toUpperCase()] || NETWORK_MAP[network] || 'YELLO';

      // Clean phone number
      let recipient = (phone || '').replace(/\s+/g, '');
      if (recipient.startsWith('+233')) {
        recipient = '0' + recipient.slice(4);
      } else if (recipient.startsWith('233')) {
        recipient = '0' + recipient.slice(3);
      }
      if (!recipient.startsWith('0')) {
        recipient = '0' + recipient;
      }

      console.log(`[CKGodsway] Placing order: ${network} -> ${networkKey}, ${recipient}, ${amount}GB (ref: ${orderId})`);

      const data = await makeRequest('/data-purchase', {
        method: 'POST',
        body: JSON.stringify({
          networkKey: networkKey,
          recipient: recipient,
          capacity: String(amount)
        })
      });

      if (data.success) {
        const rawRef = data.data?.orderNumber || data.data?.reference || orderId;
        // Prefix with CK- so sync can identify this provider
        const extRef = String(rawRef).startsWith('CK-') ? String(rawRef) : `CK-${rawRef}`;
        const newBal = data.balance?.current !== undefined ? parseFloat(data.balance.current) : undefined;
        // Update cached balance
        if (newBal !== undefined) {
          lastKnownBalance = newBal;
        }
        console.log(`[CKGodsway] Order success: ref=${extRef}, network=${data.data?.network}, price=${data.data?.price}, balance=${newBal}`);
        return {
          success: true,
          reference: extRef,
          message: data.message || 'Order placed successfully',
          newBalance: newBal
        };
      } else {
        throw new Error(data.error || data.message || 'Order failed');
      }
    } catch (error) {
      console.error('[CKGodsway] Place order failed:', error.message);
      // Distinguish network-level failures (connection dropped, timeout, DNS) from
      // business rejections (HTTP 4xx with an error body). On network errors the
      // order may have already reached CKGodsway — callers must NOT immediately
      // hard-fail; they should reset and let the retry loop handle it.
      const isNetworkError = /fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|ECONNREFUSED|socket|network|timeout|aborted/i.test(error.message);
      return {
        success: false,
        error: error.message,
        networkError: isNetworkError
      };
    }
  },

  /**
   * Check order status
   * GET /external/order-status?reference=xxx
   * 
   * @param {string} orderReference - The order reference/number
   */
  async checkOrderStatus(orderReference) {
    try {
      // Strip CK- prefix before sending to API (we add it locally for provider identification)
      const cleanRef = orderReference.startsWith('CK-') ? orderReference.slice(3) : orderReference;
      const data = await makeRequest(`/external/order-status?reference=${encodeURIComponent(cleanRef)}`);

      if (data.success) {
        // Map CK-Godsway statuses to our standard format
        // CK-Godsway: INITIATED, PENDING, PROCESSING, SUCCESSFUL, FAILED, CANCELLED
        const statusMap = {
          'INITIATED': 'pending',
          'PENDING': 'pending',
          'PROCESSING': 'processing',
          'SUCCESSFUL': 'completed',
          'FAILED': 'failed',
          'CANCELLED': 'failed'
        };
        const rawStatus = (data.data?.status || '').toUpperCase();
        const mappedStatus = statusMap[rawStatus] || rawStatus.toLowerCase();

        return {
          success: true,
          status: mappedStatus,
          orderStatus: mappedStatus,
          reference: data.data?.reference || orderReference,
          recipient: data.data?.recipient,
          raw: data.data
        };
      } else {
        return {
          success: false,
          status: 'unknown',
          error: data.error || 'Status check failed'
        };
      }
    } catch (error) {
      console.error('[CKGodsway] Status check failed:', error.message);
      return {
        success: false,
        status: 'unknown',
        error: error.message
      };
    }
  },

  /**
   * Test connection and credentials
   */
  async testConnection() {
    try {
      // Use order-status with a dummy reference to verify API key is valid
      // A 404 (order not found) means credentials are valid
      // A 401 means invalid API key
      const settings = getSettings();
      if (!settings.apiKey) {
        return { success: false, message: 'No API key configured' };
      }

      const data = await makeRequest('/external/order-status?reference=TEST_CONNECTION_CHECK');
      // If we get here, the API accepted our key (even if order not found)
      const balance = lastKnownBalance !== null ? lastKnownBalance : 'N/A';
      return {
        success: true,
        message: `Connected! Last known balance: GHS ${balance}`
      };
    } catch (error) {
      // 404 "Order not found" still means our API key is valid
      if (error.message && error.message.includes('not found')) {
        const balance = lastKnownBalance !== null ? lastKnownBalance : 'N/A';
        return {
          success: true,
          message: `Connected! Last known balance: GHS ${balance}`
        };
      }
      return {
        success: false,
        message: error.message
      };
    }
  }
};

module.exports = ckgodswayService;
