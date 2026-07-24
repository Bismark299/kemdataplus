/**
 * InstantDataGH API Service
 *
 * Base URL: https://instantdatagh.com/api.php
 * Auth: x-api-key header
 *
 * Endpoints:
 * - POST /orders             — Place single order
 * - GET  /order-status?order_id=<id> — Check order status
 * - GET  /balance            — Wallet balance
 * - GET  /plans              — Available plans per network
 *
 * MTN only (as configured).
 * External reference prefix: IDG-
 */

const path = require('path');
const fs   = require('fs');

const BASE_URL = 'https://instantdatagh.com/api.php';

function getApiKey() {
  if (process.env.INSTANTDATAGH_API_KEY) return process.env.INSTANTDATAGH_API_KEY;
  try {
    const settingsController = require('../controllers/settings.controller');
    const admin = settingsController.getAdminSettings?.();
    if (admin?.instantdataghApiKey) return admin.instantdataghApiKey;
  } catch (_) {}
  try {
    const settingsPath = path.join(__dirname, '../../settings.json');
    if (fs.existsSync(settingsPath)) {
      const s = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      if (s.adminSettings?.instantdataghApiKey) return s.adminSettings.instantdataghApiKey;
    }
  } catch (_) {}
  return '';
}

async function makeRequest(endpoint, options = {}) {
  const apiKey = getApiKey();
  const url    = `${BASE_URL}${endpoint}`;
  const headers = {
    'x-api-key':    apiKey,
    'Content-Type': 'application/json',
    ...options.headers
  };

  console.log(`[InstantDataGH] ${options.method || 'GET'} ${url}`);

  const response = await fetch(url, { ...options, headers });
  const data     = await response.json();

  console.log(`[InstantDataGH] HTTP ${response.status}:`, JSON.stringify(data).slice(0, 200));

  if (!response.ok) {
    throw new Error(data.message || `HTTP ${response.status}`);
  }
  return data;
}

function cleanPhone(phone) {
  let p = (phone || '').replace(/\s+/g, '');
  if (p.startsWith('+233')) p = '0' + p.slice(4);
  else if (p.startsWith('233')) p = '0' + p.slice(3);
  if (!p.startsWith('0')) p = '0' + p;
  return p;
}

let lastKnownBalance = null;

const instantDataGHService = {
  async getWalletBalance() {
    try {
      const data = await makeRequest('/balance');
      if (data.status === 'success') {
        const bal = parseFloat(data.data?.balance_raw ?? data.data?.balance ?? 0);
        lastKnownBalance = bal;
        return { success: true, balance: bal, currency: 'GHS' };
      }
      return { success: false, balance: lastKnownBalance ?? 0, error: data.message };
    } catch (err) {
      console.error('[InstantDataGH] Balance check failed:', err.message);
      return { success: false, balance: lastKnownBalance ?? 0, error: err.message };
    }
  },

  getLastKnownBalance() {
    return lastKnownBalance;
  },

  /**
   * Place a single MTN data order.
   * @param {Object} params
   * @param {string} params.network  - Network (MTN only)
   * @param {string} params.phone    - Recipient phone number
   * @param {number|string} params.amount - Plan key / data amount (GB)
   * @param {string} params.orderId  - Internal reference (for logging)
   */
  async placeOrder({ network, phone, amount, orderId }) {
    try {
      const recipient = cleanPhone(phone);

      console.log(`[InstantDataGH] Placing order: ${network}, ${recipient}, data_amount=${amount} (ref: ${orderId})`);

      const data = await makeRequest('/orders', {
        method: 'POST',
        body: JSON.stringify({
          network:      'MTN',
          phone_number: recipient,
          data_amount:  String(amount)
        })
      });

      if (data.status === 'success') {
        const rawId  = data.data?.order_id;
        const extRef = `IDG-${rawId}`;
        const newBal = parseFloat(data.data?.remaining_balance ?? NaN);
        if (!isNaN(newBal)) lastKnownBalance = newBal;

        console.log(`[InstantDataGH] Order success: ref=${extRef}, balance=${newBal}`);
        return { success: true, reference: extRef, message: data.message || 'Order placed', newBalance: newBal };
      }

      throw new Error(data.message || 'Order failed');
    } catch (err) {
      console.error('[InstantDataGH] Place order failed:', err.message);
      return { success: false, error: err.message };
    }
  },

  /**
   * Check status of an order.
   * @param {string} orderReference - IDG-prefixed reference
   */
  async checkOrderStatus(orderReference) {
    try {
      const orderId = orderReference.startsWith('IDG-') ? orderReference.slice(4) : orderReference;
      const data    = await makeRequest(`/order-status?order_id=${encodeURIComponent(orderId)}`);

      if (data.status === 'success') {
        const raw = (data.data?.status || '').toLowerCase();

        // Map InstantDataGH statuses → our standard statuses
        const STATUS_MAP = {
          'processing':        'processing',
          'awaiting_delivery': 'processing',
          'completed':         'completed',
          'failed':            'failed',
          'refunded':          'cancelled'
        };
        const mapped = STATUS_MAP[raw] ?? raw;

        return {
          success:   true,
          status:    mapped,
          rawStatus: raw,
          orderId:   data.data?.order_id,
          raw:       data.data
        };
      }

      return { success: false, status: 'unknown', error: data.message };
    } catch (err) {
      console.error('[InstantDataGH] Status check failed:', err.message);
      return { success: false, status: 'unknown', error: err.message };
    }
  },

  async getPlans() {
    try {
      const data = await makeRequest('/plans');
      return data.status === 'success' ? { success: true, plans: data.data } : { success: false, plans: {} };
    } catch (err) {
      return { success: false, plans: {}, error: err.message };
    }
  },

  async testConnection() {
    try {
      const apiKey = getApiKey();
      if (!apiKey) return { success: false, message: 'No API key configured' };
      const result = await this.getWalletBalance();
      if (result.success) {
        return { success: true, message: `Connected! Balance: GHS ${result.balance}` };
      }
      return { success: false, message: result.error || 'Connection failed' };
    } catch (err) {
      return { success: false, message: err.message };
    }
  }
};

module.exports = instantDataGHService;
