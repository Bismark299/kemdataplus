/**
 * Data Gatekeeper API Service
 *
 * Base URL: https://data-gatekeeper.onrender.com/api/v1
 * Auth: X-API-Key header
 *
 * Endpoints:
 * - GET  /account        — wallet balance + account info
 * - GET  /bundles        — list available bundles (optional ?network=mtn)
 * - POST /orders         — place order { bundleId, phoneNumber }
 * - GET  /orders/{id}    — poll order status
 *
 * Networks supported: mtn, telecel, at-ishare, at-bigtime
 * This service is configured for MTN only (admin-controlled per-network toggle).
 *
 * Reference format: DGK-{orderId} stored as externalReference so sync
 * knows which provider handled the order.
 */

const BASE_URL = 'https://data-gatekeeper.onrender.com/api/v1';

function getApiKey() {
  return process.env.DATAGATEKEEPER_API_KEY || '';
}

async function makeRequest(endpoint, options = {}, timeoutMs = 15000) {
  const apiKey = getApiKey();
  const url = `${BASE_URL}${endpoint}`;

  if (!apiKey) {
    throw new Error('DATAGATEKEEPER_API_KEY not set — add it to your environment variables');
  }

  const headers = {
    'X-API-Key': apiKey,
    'Content-Type': 'application/json',
    ...options.headers
  };

  console.log(`[DataGatekeeper] ${options.method || 'GET'} ${url}`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await fetch(url, { ...options, headers, signal: controller.signal });
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') {
      const e = new Error('Request timed out (Data Gatekeeper API may be cold-starting — will retry)');
      e.networkError = true;
      throw e;
    }
    const e = new Error(`Network error: ${err.message}`);
    e.networkError = true;
    throw e;
  }
  clearTimeout(timer);

  console.log(`[DataGatekeeper] Status: ${response.status}`);

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || data.message || `HTTP ${response.status}`);
  }

  return data;
}

// Bundle cache — refreshed every 10 minutes to avoid hammering the API
let bundleCache = null;
let bundleCacheAt = 0;
const BUNDLE_CACHE_TTL = 10 * 60 * 1000;

async function getBundles(network = 'mtn') {
  const now = Date.now();
  if (bundleCache && now - bundleCacheAt < BUNDLE_CACHE_TTL) {
    return bundleCache;
  }
  const data = await makeRequest(`/bundles?network=${network}`);
  bundleCache = data.bundles || [];
  bundleCacheAt = now;
  return bundleCache;
}

// Find a bundle by dataAmount (e.g. "5GB" → matches bundle with dataAmount "5GB")
async function findBundleId(network, dataAmountStr) {
  try {
    const bundles = await getBundles(network.toLowerCase());
    if (!bundles.length) return null;

    // Extract numeric GB from string like "5GB", "5 GB", "5gb"
    const match = (dataAmountStr || '').match(/(\d+(\.\d+)?)/);
    const targetGB = match ? parseFloat(match[1]) : null;

    if (targetGB === null) return null;

    // Try exact dataAmount match first
    const exact = bundles.find(b => {
      const bMatch = (b.dataAmount || '').match(/(\d+(\.\d+)?)/);
      return bMatch && parseFloat(bMatch[1]) === targetGB;
    });

    return exact ? exact.id : null;
  } catch (e) {
    console.error('[DataGatekeeper] findBundleId error:', e.message);
    return null;
  }
}

const dataGatekeeperService = {
  /**
   * Get wallet balance via GET /account
   */
  async getWalletBalance() {
    try {
      const data = await makeRequest('/account');
      const balance = parseFloat(data.walletBalance || 0);
      return { success: true, balance, currency: 'GHS' };
    } catch (error) {
      console.error('[DataGatekeeper] getWalletBalance error:', error.message);
      return { success: false, balance: 0, error: error.message };
    }
  },

  /**
   * Place a data bundle order
   * POST /orders  { bundleId, phoneNumber }
   *
   * @param {Object} params
   * @param {string} params.network     - e.g. "MTN"
   * @param {string} params.phone       - recipient phone number
   * @param {number} params.amount      - data size in GB (e.g. 5)
   * @param {string} params.orderId     - internal order reference
   */
  async placeOrder({ network, phone, amount, orderId }) {
    try {
      // Guard: no API key = not configured yet — treat as retriable (keep order PENDING)
      if (!getApiKey()) {
        const e = new Error('DATAGATEKEEPER_API_KEY not set on this server — add it to environment variables');
        e.networkError = true;
        throw e;
      }

      // Normalise phone number to 10-digit local format
      let phoneNumber = (phone || '').replace(/\s+/g, '');
      if (phoneNumber.startsWith('+233')) phoneNumber = '0' + phoneNumber.slice(4);
      else if (phoneNumber.startsWith('233')) phoneNumber = '0' + phoneNumber.slice(3);
      if (!phoneNumber.startsWith('0')) phoneNumber = '0' + phoneNumber;

      // Resolve bundleId from the Gatekeeper catalogue
      const bundleId = await findBundleId(network, `${amount}GB`);
      if (!bundleId) {
        throw new Error(`No Data Gatekeeper bundle found for ${network} ${amount}GB`);
      }

      console.log(`[DataGatekeeper] Placing order: ${network} ${amount}GB → ${phoneNumber} (bundleId=${bundleId}, ref=${orderId})`);

      const data = await makeRequest('/orders', {
        method: 'POST',
        body: JSON.stringify({ bundleId, phoneNumber })
      });

      const extRef = `DGK-${data.orderId}`;
      const newBalance = data.walletBalance ? parseFloat(data.walletBalance) : undefined;

      console.log(`[DataGatekeeper] Order placed: orderId=${data.orderId}, status=${data.status}, balance=${newBalance}`);

      return {
        success: true,
        reference: extRef,
        message: data.message || 'Order placed successfully',
        newBalance
      };
    } catch (error) {
      console.error('[DataGatekeeper] placeOrder error:', error.message);
      return { success: false, error: error.message, networkError: !!error.networkError };
    }
  },

  /**
   * Check order status
   * GET /orders/{id}
   *
   * @param {string} orderReference - stored as "DGK-{id}"
   */
  async checkOrderStatus(orderReference) {
    try {
      // Strip DGK- prefix to get the numeric ID
      const rawId = String(orderReference).startsWith('DGK-')
        ? orderReference.slice(4)
        : orderReference;

      const data = await makeRequest(`/orders/${rawId}`);

      // Map API statuses to internal format
      // API: pending | processing | completed | failed
      const statusMap = {
        pending: 'pending',
        processing: 'processing',
        completed: 'completed',
        failed: 'failed'
      };

      const rawStatus = (data.status || '').toLowerCase();
      const mappedStatus = statusMap[rawStatus] || rawStatus;

      return {
        success: true,
        status: mappedStatus,
        orderStatus: mappedStatus,
        reference: orderReference,
        recipient: data.phoneNumber,
        raw: data
      };
    } catch (error) {
      console.error('[DataGatekeeper] checkOrderStatus error:', error.message);
      return { success: false, status: 'unknown', error: error.message };
    }
  },

  /**
   * Test connection — verifies API key via GET /account
   */
  async testConnection() {
    try {
      const apiKey = getApiKey();
      if (!apiKey) return { success: false, message: 'No API key configured (DATAGATEKEEPER_API_KEY)' };

      const data = await makeRequest('/account');
      const balance = parseFloat(data.walletBalance || 0);
      return {
        success: true,
        message: `Connected as "${data.name || data.email}". Wallet: GHS ${balance.toFixed(2)}`
      };
    } catch (error) {
      return { success: false, message: error.message };
    }
  }
};

module.exports = dataGatekeeperService;
