// ordersData.js
// Rewritten and cleaned version for KemDataplus
// - increasing numeric order IDs (next = lastOrderId + 1)
// - newest orders appear first in ordersData
// - exposes functions on window for compatibility with dashboard.js
// - ALL TIMES ARE IN UTC/GMT - day resets at midnight UTC

// --------------------
// UTC TIME HELPERS
// --------------------

// Get current UTC timestamp (ISO format)
function getCurrentTimestamp() {
  return new Date().toISOString();
}

// Get today's date in UTC (YYYY-MM-DD format)
function getTodayUTC() {
  const now = new Date();
  return now.toISOString().split('T')[0];
}

// Get UTC date string for X days ago
function getDateString(daysAgo) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - daysAgo);
  return date.toISOString().split('T')[0];
}

// Check if a date string/timestamp is from today (UTC)
function isToday(dateStr) {
  if (!dateStr) return false;
  try {
    const date = new Date(dateStr);
    const today = getTodayUTC();
    return date.toISOString().split('T')[0] === today;
  } catch (e) {
    return false;
  }
}

// Check if a date is within the current week (UTC, last 7 days)
function isThisWeek(dateStr) {
  if (!dateStr) return false;
  try {
    const date = new Date(dateStr);
    const now = new Date();
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    return date >= weekAgo && date <= now;
  } catch (e) {
    return false;
  }
}

// Get start of today in UTC (midnight UTC)
function getStartOfTodayUTC() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0));
}

// Get end of today in UTC (23:59:59.999 UTC)
function getEndOfTodayUTC() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 59, 59, 999));
}

// Format date for display (shows UTC time with GMT indicator)
function formatOrderDateTime(date) {
  const d = (date instanceof Date) ? date : new Date(date);
  const day = d.getUTCDate();
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const month = months[d.getUTCMonth()];
  const year = d.getUTCFullYear();
  const hours = String(d.getUTCHours()).padStart(2, '0');
  const minutes = String(d.getUTCMinutes()).padStart(2, '0');
  const suffix = getDayOfWeekSuffix(day);
  return `${day}${suffix} ${month} ${year} at ${hours}:${minutes} GMT`;
}

// Format date only (no time)
function formatDateOnly(date) {
  const d = (date instanceof Date) ? date : new Date(date);
  const day = d.getUTCDate();
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const month = months[d.getUTCMonth()];
  const year = d.getUTCFullYear();
  const suffix = getDayOfWeekSuffix(day);
  return `${day}${suffix} ${month} ${year}`;
}

function getDayOfWeekSuffix(day) {
  if (day > 3 && day < 21) return 'th';
  switch (day % 10) {
    case 1: return 'st';
    case 2: return 'nd';
    case 3: return 'rd';
    default: return 'th';
  }
}

// --------------------
// Default data
// --------------------
let ordersData; // will hold array of orders (newest first)
let cart;       // cart array (kept in localStorage by saveCart)
let walletData; // wallet object

const defaultOrdersData = [
  {
    id: '74770',
    agent: 'KEM - 5432',
    dateTime: formatOrderDateTime(new Date()),
    recipient: '0240000001',
    phones: ['0240000001'],
    network: 'MTN Non-Expiry Bundles',
    bundle: '10',
    total: 65,
    payment: 'completed',
    status: 'completed',
    createdAt: getCurrentTimestamp()
  },
  {
    id: '74771',
    agent: 'KEM - 5432',
    dateTime: formatOrderDateTime(new Date(Date.now() - 24 * 60 * 60 * 1000)),
    recipient: '0550000001',
    phones: ['0550000001', '0550000002', '0550000003'],
    network: 'Telecel Non-Expiry Bundles',
    bundle: '5',
    total: 105,
    payment: 'completed',
    status: 'processing',
    createdAt: getCurrentTimestamp()
  },
  {
    id: '74772',
    agent: 'KEM - 5432',
    dateTime: formatOrderDateTime(new Date(Date.now() - 48 * 60 * 60 * 1000)),
    recipient: '0200000001',
    phones: ['0200000001', '0200000002'],
    network: 'AirtelTigo Non-Expiry Bundles',
    bundle: '20',
    total: 264,
    payment: 'completed',
    status: 'pending',
    createdAt: getCurrentTimestamp()
  }
];

walletData = {
  balance: 500.00,
  transactions: [
    { id: 'TXN-001', date: getDateString(0), type: 'debit', amount: 65, description: 'Order KEM-00001' },
    { id: 'TXN-002', date: getDateString(1), type: 'credit', amount: 200, description: 'Top-up via Card' }
  ]
};

// --------------------
// Storage helpers
// --------------------
function safeParse(v, fallback) {
  try { return JSON.parse(v); } catch (e) { return fallback; }
}

function saveOrders() {
  if (!Array.isArray(ordersData)) ordersData = [];
  localStorage.setItem('orders', JSON.stringify(ordersData));
}

function saveCart() {
  try {
    localStorage.setItem('cart', JSON.stringify(cart || []));
  } catch (e) {
    console.error('saveCart error', e);
  }
}

function saveWallet() {
  try {
    localStorage.setItem('walletBalance', String(walletData.balance));
  } catch (e) {
    console.error('saveWallet error', e);
  }
}

// --------------------
// Order ID logic
// --------------------
function _getStoredLastOrderId() {
  const v = localStorage.getItem('lastOrderId');
  if (!v) return null;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

function _setStoredLastOrderId(n) {
  localStorage.setItem('lastOrderId', String(n));
}

function computeInitialLastOrderId(initialOrders) {
  // Determine the largest numeric id in existing orders
  let maxId = null;
  if (Array.isArray(initialOrders) && initialOrders.length) {
    initialOrders.forEach(o => {
      const n = parseInt(o.id, 10);
      if (Number.isFinite(n)) {
        if (maxId === null || n > maxId) maxId = n;
      }
    });
  }
  // If no orders present, return null so initializeStorage can choose a starting id
  return maxId;
}

function getNextOrderId() {
  // Use stored lastOrderId if present; else compute from ordersData
  let lastId = _getStoredLastOrderId();
  if (lastId === null) {
    // compute from current ordersData
    const computed = computeInitialLastOrderId(ordersData || []);
    lastId = computed !== null ? computed : 74772; // fallback baseline (so next becomes 74773)
  }
  const next = lastId + 1;
  _setStoredLastOrderId(next);
  return String(next);
}

// --------------------
// Public API: initializeStorage
// --------------------
function initializeStorage() {
  // Load orders
  const savedOrders = safeParse(localStorage.getItem('orders'), null);
  if (Array.isArray(savedOrders) && savedOrders.length) {
    // ensure createdAt exists for date sorting
    ordersData = savedOrders.map(o => Object.assign({}, o, { createdAt: o.createdAt || getCurrentTimestamp() }));
  } else {
    // clone defaults to avoid mutation
    ordersData = defaultOrdersData.map(o => Object.assign({}, o));
    // persist defaults
    saveOrders();
  }

  // Ensure ordersData is sorted newest-first based on numeric id (highest first)
  ordersData.sort((a, b) => parseInt(b.id, 10) - parseInt(a.id, 10));

  // Initialize lastOrderId if absent
  if (!_getStoredLastOrderId()) {
    const computed = computeInitialLastOrderId(ordersData);
    const initial = computed !== null ? computed : 74772;
    _setStoredLastOrderId(initial);
  }

  // Load cart
  cart = safeParse(localStorage.getItem('cart'), []);
  if (!Array.isArray(cart)) cart = [];

  // Load wallet balance (persisted separately)
  loadWalletBalance();

  // Expose to global (compat)
  window.ordersData = ordersData;
  window.cart = cart;
  window.walletData = walletData;
}

// --------------------
// Add order (from cart item)
// --------------------
function addOrder(cartItem) {
  // cartItem is expected to have: numbers (array), network (string), bundle (string), price (number), mode (string)
  const id = getNextOrderId();
  const order = {
    id: id,
    agent: 'KEM - 5432', // you can change this dynamically if needed
    dateTime: formatOrderDateTime(new Date()),
    recipient: (Array.isArray(cartItem.numbers) && cartItem.numbers[0]) ? cartItem.numbers[0] : (cartItem.recipient || ''),
    phones: Array.isArray(cartItem.numbers) ? cartItem.numbers : [cartItem.recipient || ''],
    network: getNetworkDisplayName(cartItem.network),
    bundle: cartItem.bundle,
    total: Number(cartItem.price || 0),
    payment: cartItem.payment || 'completed',
    status: cartItem.status || 'processing',
    createdAt: getCurrentTimestamp()
  };

  // Insert at beginning so newest-first order is maintained
  ordersData.unshift(order);
  saveOrders();

  // Keep window.ordersData synced
  window.ordersData = ordersData;

  return order;
}

// --------------------
// Helpers for networks
// --------------------
function getNetworkDisplayName(network) {
  const networkNames = {
    'MTN': 'MTN Non-Expiry Bundles',
    'Telecel': 'Telecel Non-Expiry Bundles',
    'AirtelTigo': 'AirtelTigo Non-Expiry Bundles'
  };
  if (!network) return 'Unknown Network';
  return networkNames[network] || network + ' Non-Expiry Bundles';
}

// --------------------
// Order stats and sales
// --------------------
function getOrderStats() {
  const stats = { completed: 0, processing: 0, pending: 0, total: 0 };
  if (!Array.isArray(ordersData)) return stats;
  ordersData.forEach(order => {
    if (order.status === 'completed') stats.completed++;
    else if (order.status === 'processing') stats.processing++;
    else if (order.status === 'pending') stats.pending++;
    stats.total++;
  });
  return stats;
}

function getTodaysSales() {
  const todayUTC = getTodayUTC();
  let total = 0;
  (ordersData || []).forEach(order => {
    try {
      const orderDate = new Date(order.createdAt || order.dateTime);
      const orderDateStr = orderDate.toISOString().split('T')[0];
      if (orderDateStr === todayUTC && order.status === 'completed') {
        total += Number(order.total || 0);
      }
    } catch (e) { /* ignore parse errors */ }
  });
  return total;
}

function getWeeklySales() {
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  let total = 0;
  (ordersData || []).forEach(order => {
    try {
      const orderDate = new Date(order.createdAt || order.dateTime);
      if (orderDate >= weekAgo && orderDate <= now && order.status === 'completed') {
        total += Number(order.total || 0);
      }
    } catch (e) { /* ignore parse errors */ }
  });
  return total;
}

// Get today's order count (UTC)
function getTodaysOrderCount() {
  const todayUTC = getTodayUTC();
  let count = 0;
  (ordersData || []).forEach(order => {
    try {
      const orderDate = new Date(order.createdAt || order.dateTime);
      const orderDateStr = orderDate.toISOString().split('T')[0];
      if (orderDateStr === todayUTC) {
        count++;
      }
    } catch (e) { /* ignore parse errors */ }
  });
  return count;
}

// Get today's data usage in GB (UTC)
function getTodaysDataGB() {
  const todayUTC = getTodayUTC();
  let totalGB = 0;
  (ordersData || []).forEach(order => {
    try {
      const orderDate = new Date(order.createdAt || order.dateTime);
      const orderDateStr = orderDate.toISOString().split('T')[0];
      if (orderDateStr === todayUTC) {
        totalGB += parseFloat(order.bundle) || 0;
      }
    } catch (e) { /* ignore parse errors */ }
  });
  return totalGB;
}

// --------------------
// Wallet functions
// --------------------
function getWalletBalance() {
  return walletData && typeof walletData.balance === 'number' ? walletData.balance : 0;
}

function updateWalletBalance(amount) {
  walletData.balance = Number((walletData.balance + Number(amount || 0)).toFixed(2));
  // push transaction for trace
  const txn = {
    id: 'TXN-' + Math.floor(Math.random() * 900000 + 100000),
    date: getDateString(0),
    type: amount >= 0 ? 'credit' : 'debit',
    amount: Math.abs(Number(amount || 0)),
    description: amount >= 0 ? 'Top-up' : 'Order payment'
  };
  walletData.transactions = walletData.transactions || [];
  walletData.transactions.unshift(txn);
  saveWallet();
  // persist wallet balance separately
  localStorage.setItem('walletBalance', String(walletData.balance));
}

// Load wallet balance from localStorage (if present)
function loadWalletBalance() {
  const saved = localStorage.getItem('walletBalance');
  if (saved !== null) {
    const b = parseFloat(saved);
    if (!Number.isNaN(b)) walletData.balance = b;
  }
  // ensure walletData exists on window
  window.walletData = walletData;
}

// --------------------
// Bulk parsing (used by dashboard bulk mode)
// Input format: "0240000000 2" (phone [whitespace] bundle)
// --------------------
function parseBulkInput(input) {
  if (!input || typeof input !== 'string') return [];
  const lines = input.split('\n').map(l => l.trim()).filter(Boolean);
  const seen = new Set();
  const results = [];

  // Phone validation: 10 digits starting with 0, OR 9 digits not starting with 0
  const isValidPhone = (phone) => {
    if (/^0\d{9}$/.test(phone)) return true;  // Starts with 0, total 10 digits
    if (/^[1-9]\d{8}$/.test(phone)) return true;  // Doesn't start with 0, total 9 digits
    return false;
  };

  // Normalize phone to 10 digits (add leading 0 if 9 digits)
  const normalizePhone = (phone) => {
    if (/^[1-9]\d{8}$/.test(phone)) return '0' + phone;
    return phone;
  };

  lines.forEach((line) => {
    const parts = line.trim().split(/\s+/);
    if (!parts.length) return;
    const rawPhone = parts[0];
    const bundle = parts[1] || '';
    const phoneOk = isValidPhone(rawPhone);
    const phone = phoneOk ? normalizePhone(rawPhone) : rawPhone;
    const bundleOk = ['1', '5', '10', '20', '50'].includes(bundle);
    const duplicate = seen.has(phone);
    if (!duplicate && phoneOk) seen.add(phone);
    const isValid = phoneOk && bundleOk && !duplicate;
    const reason = isValid ? '' : (duplicate ? 'Duplicate' : (!phoneOk ? 'Invalid phone' : 'Invalid bundle'));
    results.push({ phone, bundle, isValid, reason });
  });

  return results;
}

// --------------------
// Excel parsing helpers (SheetJS expected in page)
// rows: array of arrays
// --------------------
function processExcelData(rows) {
  const seen = new Set();
  const results = [];

  // Phone validation: 10 digits starting with 0, OR 9 digits not starting with 0
  const isValidPhone = (phone) => {
    if (/^0\d{9}$/.test(phone)) return true;  // Starts with 0, total 10 digits
    if (/^[1-9]\d{8}$/.test(phone)) return true;  // Doesn't start with 0, total 9 digits
    return false;
  };

  // Normalize phone to 10 digits (add leading 0 if 9 digits)
  const normalizePhone = (phone) => {
    if (/^[1-9]\d{8}$/.test(phone)) return '0' + phone;
    return phone;
  };

  rows.forEach((r, i) => {
    if (!r || r.length === 0) return;
    // skip header heuristics
    if (i === 0 && String(r[0] || '').toLowerCase().includes('phone')) return;
    const rawPhone = String(r[0] || '').trim();
    const bundle = String(r[1] || '').trim();
    if (!rawPhone) return;
    const phoneOk = isValidPhone(rawPhone);
    const phone = phoneOk ? normalizePhone(rawPhone) : rawPhone;
    const duplicate = seen.has(phone);
    if (!duplicate && phoneOk) seen.add(phone);
    const isValid = phoneOk && ['1','5','10','20','50'].includes(bundle) && !duplicate;
    const reason = isValid ? '' : (duplicate ? 'Duplicate' : (!phoneOk ? 'Invalid phone' : 'Invalid bundle'));
    results.push({ phone, bundle, quantity: r[2] || 1, isValid, reason });
  });
  return results;
}

// --------------------
// Expose functions to global window for compatibility
// --------------------
window.initializeStorage = initializeStorage;
window.addOrder = addOrder;
window.saveOrders = saveOrders;
window.saveCart = saveCart;
window.getOrderStats = getOrderStats;
window.getTodaysSales = getTodaysSales;
window.getWeeklySales = getWeeklySales;
window.getTodaysOrderCount = getTodaysOrderCount;
window.getTodaysDataGB = getTodaysDataGB;
window.getWalletBalance = getWalletBalance;
window.updateWalletBalance = updateWalletBalance;
window.loadWalletBalance = loadWalletBalance;
window.parseBulkInput = parseBulkInput;
window.processExcelData = processExcelData;
window.getNextOrderId = getNextOrderId;
// UTC Time helpers
window.getCurrentTimestamp = getCurrentTimestamp;
window.getTodayUTC = getTodayUTC;
window.getDateString = getDateString;
window.isToday = isToday;
window.isThisWeek = isThisWeek;
window.getStartOfTodayUTC = getStartOfTodayUTC;
window.getEndOfTodayUTC = getEndOfTodayUTC;
window.formatOrderDateTime = formatOrderDateTime;
window.formatDateOnly = formatDateOnly;

// Initialize immediately when file loads if not done by page
// Note: dashboard.js calls initializeStorage() explicitly on DOMContentLoaded,
// but keep a safe autoinit here if it's not called.
(function safeInit() {
  try {
    if (typeof window !== 'undefined' && !Array.isArray(window.ordersData)) {
      initializeStorage();
    }
  } catch (e) {
    console.error('ordersData initialization error', e);
  }
})();
