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
 * Rate limit: 60 requests/minute per API key.
 * Reference format: DGK-{orderId} stored as externalReference.
 */

const BASE_URL = 'https://data-gatekeeper.onrender.com/api/v1';

function getApiKey() {
  return process.env.DATAGATEKEEPER_API_KEY || '';
}

// ── Rate-limit cooldown ────────────────────────────────────────────────────
// When DGK returns 429, block all requests for 60 seconds.
let rateLimitedUntil = 0;

function isRateLimited() {
  return Date.now() < rateLimitedUntil;
}

function setRateLimited() {
  rateLimitedUntil = Date.now() + 60 * 1000;
  console.warn('[DataGatekeeper] ⚠️ Rate limited — pausing all DGK requests for 60 seconds');
}
// ──────────────────────────────────────────────────────────────────────────

async function makeRequest(endpoint, options = {}, timeoutMs = 15000) {
  const apiKey = getApiKey();
  const url = `${BASE_URL}${endpoint}`;

  if (!apiKey) {
    throw new Error('DATAGATEKEEPER_API_KEY not set — add it to your environment variables');
  }

  // Respect rate-limit cooldown
  if (isRateLimited()) {
    const secsLeft = Math.ceil((rateLimitedUntil - Date.now()) / 1000);
    const e = new Error(`DGK rate-limited — ${secsLeft}s cooldown remaining`);
    e.networkError = true;
    e.rateLimited = true;
    throw e;
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
      const e = new Error('Request timed out (Data Gatekeeper API may be cold-starting)');
      e.networkError = true;
      throw e;
    }
    const e = new Error(`Network error: ${err.message}`);
    e.networkError = true;
    throw e;
  }
  clearTimeout(timer);

  console.log(`[DataGatekeeper] Status: ${response.status}`);

  // 429 — rate limited: activate cooldown and surface as retryable error
  if (response.status === 429) {
    setRateLimited();
    const e = new Error('DGK rate limit exceeded — requests paused for 60 seconds');
    e.networkError = true;
    e.rateLimited = true;
    throw e;
  }

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || data.message || `HTTP ${response.status}`);
  }

  return data;
}

// Static bundle ID map — confirmed from GET /bundles on 2026-06-21
const STATIC_BUNDLE_MAP = {
  1:  1,
  2:  2,
  3:  3,
  4:  4,
  5:  5,
  6:  6,
  8:  7,
  10: 8,
  15: 9,
  20: 30,
  25: 12,
  30: 11,
  40: 13,
  50: 14
};

// Live bundle cache — only used as fallback for sizes not in STATIC_BUNDLE_MAP
let bundleCache = null;
let bundleCacheAt = 0;
const BUNDLE_CACHE_TTL = 10 * 60 * 1000;

async function getBundlesLive(network = 'mtn') {
  const now = Date.now();
  if (bundleCache && now - bundleCacheAt < BUNDLE_CACHE_TTL) {
    return bundleCache;
  }
  const data = await makeRequest(`/bundles?network=${network}`);
  bundleCache = data.bundles || [];
  bundleCacheAt = now;
  return bundleCache;
}

async function findBundleId(network, dataAmountStr) {
  const match = (dataAmountStr || '').match(/(\d+(\.\d+)?)/);
  const targetGB = match ? parseFloat(match[1]) : null;

  if (targetGB === null) {
    console.error(`[DataGatekeeper] Could not parse GB from: "${dataAmountStr}"`);
    return null;
  }

  if (STATIC_BUNDLE_MAP[targetGB] !== undefined) {
    console.log(`[DataGatekeeper] Bundle ID ${STATIC_BUNDLE_MAP[targetGB]} for ${targetGB}GB (static map)`);
    return STATIC_BUNDLE_MAP[targetGB];
  }

  console.log(`[DataGatekeeper] ${targetGB}GB not in static map — fetching live bundles`);
  try {
    const bundles = await getBundlesLive(network.toLowerCase());
    const found = bundles.find(b => {
      const bMatch = (b.dataAmount || '').match(/(\d+(\.\d+)?)/);
      return bMatch && parseFloat(bMatch[1]) === targetGB;
    });
    if (found) {
      console.log(`[DataGatekeeper] Bundle ID ${found.id} for ${targetGB}GB (live lookup)`);
      return found.id;
    }
  } catch (e) {
    console.error('[DataGatekeeper] Live bundle lookup error:', e.message);
  }

  console.error(`[DataGatekeeper] No bundle found for ${targetGB}GB on ${network}`);
  return null;
}

let lastKnownBalance = null;

const dataGatekeeperService = {
  getLastKnownBalance() {
    return lastKnownBalance;
  },

  /** True if API key is present AND not currently rate-limited */
  isConfigured() {
    return !!getApiKey();
  },

  /** True if DGK is currently in a rate-limit cooldown (skip all calls) */
  isRateLimited() {
    return isRateLimited();
  },

  async getWalletBalance() {
    try {
      const data = await makeRequest('/account');
      const balance = parseFloat(data.walletBalance || 0);
      lastKnownBalance = balance;
      return { success: true, balance, currency: 'GHS' };
    } catch (error) {
      console.error('[DataGatekeeper] getWalletBalance error:', error.message);
      return { success: false, balance: 0, error: error.message };
    }
  },

  async placeOrder({ network, phone, amount, orderId }) {
    try {
      if (!getApiKey()) {
        return {
          success: false,
          error: 'DATAGATEKEEPER_API_KEY not set on this server',
          networkError: false
        };
      }

      // If rate-limited, keep order PENDING — don't mark it FAILED
      if (isRateLimited()) {
        const secsLeft = Math.ceil((rateLimitedUntil - Date.now()) / 1000);
        return {
          success: false,
          error: `DGK rate-limited — ${secsLeft}s cooldown remaining`,
          networkError: true
        };
      }

      let phoneNumber = (phone || '').replace(/\s+/g, '');
      if (phoneNumber.startsWith('+233')) phoneNumber = '0' + phoneNumber.slice(4);
      else if (phoneNumber.startsWith('233')) phoneNumber = '0' + phoneNumber.slice(3);
      if (!phoneNumber.startsWith('0')) phoneNumber = '0' + phoneNumber;

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
      if (newBalance !== undefined) lastKnownBalance = newBalance;

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

  async checkOrderStatus(orderReference) {
    try {
      if (isRateLimited()) {
        const e = new Error(`DGK rate-limited — skipping status check`);
        e.networkError = true;
        e.rateLimited = true;
        throw e;
      }

      const rawId = String(orderReference).startsWith('DGK-')
        ? orderReference.slice(4)
        : orderReference;

      const data = await makeRequest(`/orders/${rawId}`);

      const statusMap = {
        pending:    'pending',
        processing: 'processing',
        completed:  'completed',
        failed:     'failed'
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
      return {
        success: false,
        status: 'unknown',
        error: error.message,
        rateLimited: !!error.rateLimited
      };
    }
  },

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
