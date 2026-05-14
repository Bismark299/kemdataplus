/**
 * TOPUPGH RESELLER API SERVICE
 * ==============================
 * Integrates with TopUpGH platform for MTN data bundle fulfillment.
 *
 * Base URL : https://reseller.etopupgh.com/api/v1
 * Docs URL : https://reseller.etopupgh.com/api/v1/docs
 *
 * Authentication (every request):
 *   X-API-Key       : API key from account settings
 *   X-Timestamp     : Unix timestamp (seconds)
 *   X-API-Signature : HMAC-SHA256(timestamp + METHOD + internalPath + body, API_SECRET)
 *
 * ⚠️  SIGNATURE PATH vs CALL PATH:
 *   Signature uses  /topupgh-api/v1/...
 *   Actual call to  /api/v1/...   (BASE_URL already ends with /api/v1)
 *
 * Networks supported: mtn | at | telecel
 * We only route MTN orders here.
 */

const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

// -------------------------------------------------------
// Config helpers
// -------------------------------------------------------

function getConfig() {
  // Environment variables take priority (cloud deployments)
  if (process.env.ETOPUPGH_API_KEY) {
    return {
      baseUrl   : process.env.ETOPUPGH_BASE_URL || 'https://reseller.etopupgh.com/api/v1',
      apiKey    : process.env.ETOPUPGH_API_KEY,
      apiSecret : process.env.ETOPUPGH_API_SECRET || ''
    };
  }

  // Fallback to settings.json
  try {
    const settingsPath = path.join(__dirname, '../../settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    const admin = settings.adminSettings || {};
    if (admin.topupghApiKey) {
      return {
        baseUrl   : admin.topupghBaseUrl || 'https://reseller.etopupgh.com/api/v1',
        apiKey    : admin.topupghApiKey,
        apiSecret : admin.topupghApiSecret || ''
      };
    }
  } catch (e) {
    console.log('[TopUpGH] Settings read error:', e.message);
  }

  console.log('[TopUpGH] WARNING: No API credentials found');
  return {
    baseUrl   : 'https://reseller.etopupgh.com/api/v1',
    apiKey    : '',
    apiSecret : ''
  };
}

// -------------------------------------------------------
// Signature generator
// -------------------------------------------------------

/**
 * Build HMAC-SHA256 signature.
 * The internal path prefix used for signing is /topupgh-api/v1
 * NOT the public /api/v1 path.
 *
 * @param {string} method       - HTTP method ("GET" or "POST")
 * @param {string} publicPath   - Path relative to base, e.g. "/orders/create"
 * @param {string} body         - JSON string of request body (empty string for GET)
 * @param {string} apiSecret
 * @returns {{ timestamp: string, signature: string }}
 */
function buildSignature(method, publicPath, body, apiSecret) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const internalPath = `/topupgh-api/v1${publicPath}`;
  const signatureString = timestamp + method.toUpperCase() + internalPath + body;
  const signature = crypto
    .createHmac('sha256', apiSecret)
    .update(signatureString)
    .digest('hex');
  return { timestamp, signature };
}

// -------------------------------------------------------
// Base request helper
// -------------------------------------------------------

async function request(method, publicPath, bodyObj) {
  const config = getConfig();
  const body   = bodyObj ? JSON.stringify(bodyObj) : '';
  const { timestamp, signature } = buildSignature(method, publicPath, body, config.apiSecret);

  const url = `${config.baseUrl}${publicPath}`;

  const headers = {
    'Accept'          : 'application/json',
    'X-API-Key'       : config.apiKey,
    'X-Timestamp'     : timestamp,
    'X-API-Signature' : signature
  };

  if (method === 'POST') {
    headers['Content-Type'] = 'application/json';
  }

  console.log(`[TopUpGH] ${method} ${url}`);

  const response = await fetch(url, {
    method,
    headers,
    body : method === 'POST' ? body : undefined
  });

  const data = await response.json();

  if (!response.ok) {
    const err = new Error(data.message || `TopUpGH API error: ${response.status}`);
    err.statusCode = response.status;
    err.responseData = data;
    throw err;
  }

  return data;
}

// -------------------------------------------------------
// Public API methods
// -------------------------------------------------------

/**
 * Test API connection / credentials.
 * @returns {{ success, message, timestamp, user_id }}
 */
async function testConnection() {
  return request('GET', '/test', null);
}

/**
 * Get available products (optionally filter by network / data_size).
 * @param {{ network?: string, data_size?: number }} filters
 */
async function getProducts(filters = {}) {
  let path = '/products';
  const params = [];
  if (filters.network)   params.push(`network=${encodeURIComponent(filters.network)}`);
  if (filters.data_size) params.push(`data_size=${filters.data_size}`);
  if (params.length)     path += '?' + params.join('&');
  return request('GET', path, null);
}

/**
 * Get current wallet balance on the TopUpGH platform.
 * @returns {{ success, balance, currency, today: { credit, debit } }}
 */
async function getWalletBalance() {
  return request('GET', '/wallet/balance', null);
}

/**
 * Create a bulk order. Dispatches up to 300 beneficiaries in one call.
 *
 * @param {Array<{ phone: string, network: string, dataSizeGb: number }>} items
 * @returns API response with order_id, total_amount, items_added, items_skipped, balance info
 */
async function createBulkOrder(items) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('At least one order item is required');
  }
  if (items.length > 300) {
    throw new Error('Maximum 300 items per TopUpGH batch');
  }

  const orders = items.map(i => ({
    _beneficiary_number : i.phone,
    network             : (i.network || 'mtn').toLowerCase(),
    _data_size          : i.dataSizeGb
  }));

  return request('POST', '/orders/create', { orders });
}

/**
 * Get basic order status by TopUpGH order ID.
 * @param {number} topupghOrderId
 */
async function getOrderStatus(topupghOrderId) {
  return request('GET', `/orders/${topupghOrderId}`, null);
}

/**
 * Get per-item delivery status for a TopUpGH order.
 * Returns items array with individual delivery_status values.
 * @param {number} topupghOrderId
 */
async function getDeliveryStatus(topupghOrderId) {
  return request('GET', `/orders/${topupghOrderId}/delivery-status`, null);
}

/**
 * Get paginated order history from TopUpGH.
 * @param {{ page?: number, per_page?: number, status?: string }} opts
 */
async function getAllOrders(opts = {}) {
  const params = [];
  if (opts.page)     params.push(`page=${opts.page}`);
  if (opts.per_page) params.push(`per_page=${opts.per_page}`);
  if (opts.status)   params.push(`status=${encodeURIComponent(opts.status)}`);
  let p = '/orders';
  if (params.length) p += '?' + params.join('&');
  return request('GET', p, null);
}

// -------------------------------------------------------
// Network helper
// -------------------------------------------------------

/**
 * Map our internal network names to TopUpGH network keys.
 * Only MTN is routed to TopUpGH; returns null for anything else.
 */
function mapNetwork(internalNetwork) {
  const n = (internalNetwork || '').toLowerCase().trim();
  if (n === 'mtn') return 'mtn';
  return null; // not handled by TopUpGH in this integration
}

/**
 * Parse data size from bundle's dataAmount string (e.g. "5GB", "1.5GB").
 * Returns the number as a float.
 */
function parseDataSizeGb(dataAmount) {
  if (!dataAmount) return null;
  const match = String(dataAmount).match(/(\d+(\.\d+)?)/);
  return match ? parseFloat(match[1]) : null;
}

module.exports = {
  testConnection,
  getProducts,
  getWalletBalance,
  createBulkOrder,
  getOrderStatus,
  getDeliveryStatus,
  getAllOrders,
  mapNetwork,
  parseDataSizeGb
};
