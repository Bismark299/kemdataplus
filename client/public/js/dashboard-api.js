/**
 * Dashboard API Integration
 * This file handles all API calls for the user dashboard
 * Uses httpOnly cookies for authentication (no localStorage tokens)
 */

(function() {
  'use strict';

  const API_BASE = window.location.origin + '/api';
  
  // Check if logged in via API
  async function checkAuth() {
    try {
      const response = await fetch(`${API_BASE}/auth/me`, {
        credentials: 'include'
      });
      return response.ok;
    } catch (e) {
      return false;
    }
  }

  // Redirect to login if not authenticated
  async function requireAuth() {
    const isAuthenticated = await checkAuth();
    if (!isAuthenticated) {
      window.location.href = '/pages/login.html';
      return false;
    }
    
    // Check user role from cached data
    const currentUser = localStorage.getItem('currentUser');
    if (currentUser) {
      try {
        const user = JSON.parse(currentUser);
        if (user.role === 'ADMIN') {
          // Admins should use admin dashboard
          localStorage.removeItem('currentUser');
          alert('Admin accounts cannot access the client dashboard. Please use the Admin panel.');
          window.location.href = '/admin/dashboard.html';
          return false;
        }
      } catch (e) {
        // Invalid user data
      }
    }
    
    return true;
  }

  // API request helper (uses httpOnly cookies)
  async function apiRequest(endpoint, method = 'GET', data = null) {
    const options = {
      method,
      headers: {
        'Content-Type': 'application/json'
      },
      credentials: 'include' // Include httpOnly cookies
    };

    if (data) {
      options.body = JSON.stringify(data);
    }

    try {
      const response = await fetch(`${API_BASE}${endpoint}`, options);
      
      if (response.status === 401) {
        localStorage.removeItem('currentUser');
        window.location.href = '/pages/login.html';
        throw new Error('Session expired');
      }

      const result = await response.json();
      
      if (!response.ok) {
        throw new Error(result.error || 'Request failed');
      }

      return result;
    } catch (error) {
      console.error('API Error:', error);
      throw error;
    }
  }

  // ========== WALLET FUNCTIONS ==========
  
  async function getWalletBalance() {
    try {
      const data = await apiRequest('/wallet/balance');
      return data.balance || 0;
    } catch (error) {
      console.error('Failed to get wallet balance:', error);
      return 0;
    }
  }

  async function getWallet() {
    try {
      return await apiRequest('/wallet');
    } catch (error) {
      console.error('Failed to get wallet:', error);
      return null;
    }
  }

  // ========== BUNDLE FUNCTIONS ==========

  async function getBundles() {
    try {
      return await apiRequest('/bundles');
    } catch (error) {
      console.error('Failed to get bundles:', error);
      return [];
    }
  }

  async function getBundlesByNetwork(network) {
    try {
      return await apiRequest(`/bundles/network/${network}`);
    } catch (error) {
      console.error('Failed to get bundles for network:', error);
      return [];
    }
  }

  // ========== ORDER FUNCTIONS ==========

  // Legacy single order creation (still works)
  async function createOrder(bundleId, recipientPhone, quantity = 1) {
    return await apiRequest('/orders', 'POST', {
      bundleId,
      recipientPhone,
      quantity
    });
  }

  /**
   * NEW: Create order group (batch order)
   * @param {Array} items - Array of { bundleId, recipientPhone, quantity }
   * @param {string} idempotencyKey - Unique key to prevent duplicates
   * @returns {Object} - Order group with all items
   */
  async function createOrderGroup(items, idempotencyKey = null) {
    const key = idempotencyKey || `checkout-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    return await apiRequest('/order-groups', 'POST', {
      items,
      idempotencyKey: key
    });
  }

  /**
   * NEW: Get order groups (paginated)
   */
  async function getOrderGroups(page = 1, limit = 50) {
    try {
      return await apiRequest(`/order-groups?page=${page}&limit=${limit}`);
    } catch (error) {
      console.error('Failed to get order groups:', error);
      return { orders: [], pagination: {} };
    }
  }

  /**
   * NEW: Get single order group details
   */
  async function getOrderGroupDetails(orderId) {
    try {
      return await apiRequest(`/order-groups/${orderId}`);
    } catch (error) {
      console.error('Failed to get order details:', error);
      return null;
    }
  }

  /**
   * NEW: Cancel order group
   */
  async function cancelOrderGroup(orderId) {
    return await apiRequest(`/order-groups/${orderId}/cancel`, 'POST');
  }

  // Get orders using OrderGroup API (consistent with orders page)
  async function getOrders(page = 1, limit = 50) {
    try {
      const data = await apiRequest(`/order-groups?page=${page}&limit=${limit}`);
      // Flatten OrderGroups to items for backwards compatibility
      const flatOrders = [];
      // API returns 'orders' not 'orderGroups'
      const orderGroups = data.orders || data.orderGroups || [];
      
      orderGroups.forEach(group => {
        if (group.items && group.items.length > 0) {
          group.items.forEach(item => {
            flatOrders.push({
              id: item.id,
              displayId: group.orderId || group.displayId,
              recipientPhone: item.recipientPhone,
              bundleId: item.bundleId,
              status: item.status,
              reference: item.reference,
              totalPrice: item.totalPrice || item.unitPrice || item.price || (group.totalAmount / group.items.length),
              createdAt: group.createdAt,
              network: item.network || item.bundle?.network,
              dataAmount: item.dataAmount || item.bundle?.dataAmount
            });
          });
        }
      });
      return { orders: flatOrders, pagination: data.pagination || {} };
    } catch (error) {
      console.error('Failed to get orders:', error);
      return { orders: [], pagination: {} };
    }
  }

  async function cancelOrder(orderId) {
    return await apiRequest(`/orders/${orderId}/cancel`, 'POST');
  }

  // ========== USER FUNCTIONS ==========

  async function getProfile() {
    try {
      return await apiRequest('/users/me');
    } catch (error) {
      console.error('Failed to get profile:', error);
      return null;
    }
  }

  async function updateProfile(data) {
    return await apiRequest('/users/me', 'PUT', data);
  }

  // ========== CHECKOUT FUNCTION ==========

  // Cache for bundles to find IDs
  let bundleCache = null;

  /**
   * Get bundle ID by network and capacity
   */
  async function findBundleId(network, capacity) {
    // Load bundles if not cached
    if (!bundleCache) {
      bundleCache = await getBundles();
    }

    // Map display network names to API network names
    const networkMap = {
      'MTN': 'MTN',
      'Telecel': 'TELECEL',
      'TELECEL': 'TELECEL',
      'AirtelTigo': 'AIRTELTIGO',
      'AIRTELTIGO': 'AIRTELTIGO'
    };

    const apiNetwork = networkMap[network] || network.toUpperCase();
    const capacityStr = String(capacity);

    // Find matching bundle
    const bundle = bundleCache.find(b => {
      const bundleCapacity = b.dataAmount.match(/(\d+)/)?.[1] || '';
      return b.network === apiNetwork && bundleCapacity === capacityStr;
    });

    return bundle?.id || null;
  }

  /**
   * Process checkout for cart items using OrderGroup (batch) API
   * Creates a single order with multiple items - all share one Order ID
   * @param {Array} cartItems - Array of cart items with network, bundle (capacity), numbers
   * @returns {Object} - Result with success status, orderId, and items
   */
  async function processCheckout(cartItems) {
    if (!cartItems || cartItems.length === 0) {
      return { success: false, error: 'Cart is empty' };
    }

    // Load bundles for ID lookup
    bundleCache = await getBundles();

    // Build items array for OrderGroup API
    const orderItems = [];
    
    for (const item of cartItems) {
      const phones = item.numbers || [item.phone];
      
      // Find the bundle ID for this network/capacity combination
      const bundleId = await findBundleId(item.network, item.bundle);
      
      if (!bundleId) {
        return { 
          success: false, 
          error: `Bundle not found: ${item.network} ${item.bundle}GB` 
        };
      }
      
      // Add each phone as a separate order item
      for (const phone of phones) {
        orderItems.push({
          bundleId,
          recipientPhone: phone,
          quantity: 1
        });
      }
    }

    if (orderItems.length === 0) {
      return { success: false, error: 'No valid items to order' };
    }

    try {
      // Create OrderGroup (batch order) with all items
      const idempotencyKey = `checkout-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      const result = await createOrderGroup(orderItems, idempotencyKey);
      
      if (result.duplicate) {
        return {
          success: true,
          duplicate: true,
          orderId: result.order.orderId,
          message: 'Order already exists (duplicate prevention)',
          totalSpent: result.order.totalAmount,
          itemCount: result.order.itemCount
        };
      }
      
      return {
        success: true,
        orderId: result.order.orderId,
        itemCount: result.order.itemCount,
        totalSpent: result.order.totalAmount,
        items: result.order.items || [],
        message: result.message
      };
      
    } catch (error) {
      console.error('Checkout error:', error);
      
      // Handle specific errors
      if (error.message.includes('INSUFFICIENT_BALANCE') || error.message.includes('Insufficient')) {
        return { 
          success: false, 
          error: 'Insufficient wallet balance',
          code: 'INSUFFICIENT_BALANCE'
        };
      }
      
      return { 
        success: false, 
        error: error.message || 'Failed to create order'
      };
    }
  }

  // ========== ORDER STATS ==========

  async function getOrderStats() {
    try {
      const { orders } = await getOrders(1, 1000);
      
      const stats = {
        completed: 0,
        processing: 0,
        pending: 0,
        failed: 0,
        todaySales: 0,
        weeklySales: 0
      };

      const now = new Date();
      // Use UTC date for consistency
      const todayUTC = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString().split('T')[0];
      const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();

      orders.forEach(order => {
        const orderDate = new Date(order.createdAt);
        const orderDateUTC = orderDate.toISOString().split('T')[0];
        
        // Only count today's orders for status stats (fresh day, fresh start)
        if (orderDateUTC === todayUTC) {
          const status = (order.status || '').toUpperCase();
          if (status === 'COMPLETED') stats.completed++;
          else if (status === 'PROCESSING') stats.processing++;
          else if (status === 'PENDING') stats.pending++;
          else if (status === 'FAILED') stats.failed++;
        }

        // Calculate sales (today and weekly)
        const status = (order.status || '').toUpperCase();
        if (status === 'COMPLETED') {
          const price = order.totalPrice || 0;
          if (orderDateUTC === todayUTC) {
            stats.todaySales += price;
          }
          if (orderDate.toISOString() >= weekAgo) {
            stats.weeklySales += price;
          }
        }
      });

      return stats;
    } catch (error) {
      console.error('Failed to get order stats:', error);
      return { completed: 0, processing: 0, pending: 0, failed: 0, todaySales: 0, weeklySales: 0 };
    }
  }

  // ========== BUNDLE DATA TRANSFORMATION ==========

  /**
   * Transform API bundles to the format expected by dashboard.js
   */
  async function loadBundlesFromAPI() {
    try {
      const bundles = await getBundles();
      
      const PRICING = {};
      const BUNDLE_DATA = {};
      const NETWORK_STATUS = {};
      const AVAILABLE_BUNDLES = {};

      // Map network names
      const networkMap = {
        'MTN': 'MTN',
        'TELECEL': 'Telecel',
        'AIRTELTIGO': 'AirtelTigo'
      };

      bundles.forEach(bundle => {
        const displayNetwork = networkMap[bundle.network] || bundle.network;
        
        if (!PRICING[displayNetwork]) {
          PRICING[displayNetwork] = {};
          NETWORK_STATUS[displayNetwork] = false; // Start as false, will be set true if any bundle is active
          AVAILABLE_BUNDLES[displayNetwork] = [];
          BUNDLE_DATA[displayNetwork] = {
            networkActive: false,
            networkName: displayNetwork,
            bundles: []
          };
        }

        // Extract capacity number (e.g., "1GB" -> "1")
        const capacityMatch = bundle.dataAmount.match(/(\d+)/);
        const capacity = capacityMatch ? capacityMatch[1] : bundle.dataAmount;

        PRICING[displayNetwork][capacity] = bundle.price;
        
        if (bundle.isActive) {
          AVAILABLE_BUNDLES[displayNetwork].push(capacity);
          // Network is active if at least one bundle is active
          NETWORK_STATUS[displayNetwork] = true;
          BUNDLE_DATA[displayNetwork].networkActive = true;
        }

        BUNDLE_DATA[displayNetwork].bundles.push({
          id: bundle.id,
          capacity: capacity,
          capacityLabel: bundle.dataAmount,
          price: bundle.price,
          active: bundle.isActive,
          outOfStock: !bundle.isActive
        });
      });

      return { PRICING, BUNDLE_DATA, NETWORK_STATUS, AVAILABLE_BUNDLES };
    } catch (error) {
      console.error('Failed to load bundles from API:', error);
      return null;
    }
  }

  // ========== INITIALIZATION ==========

  async function initDashboard() {
    if (!requireAuth()) return;

    try {
      // Load user profile
      const profile = await getProfile();
      if (profile) {
        localStorage.setItem('user', JSON.stringify(profile));
        updateUserDisplay(profile);
      }

      // Load wallet balance
      const balance = await getWalletBalance();
      updateWalletDisplay(balance);

      // Load order stats
      const stats = await getOrderStats();
      updateStatsDisplay(stats);

      // Load bundles and update pricing
      const bundleData = await loadBundlesFromAPI();
      if (bundleData) {
        // Store for dashboard.js to use
        window.API_PRICING = bundleData.PRICING;
        window.API_BUNDLE_DATA = bundleData.BUNDLE_DATA;
        window.API_NETWORK_STATUS = bundleData.NETWORK_STATUS;
        window.API_AVAILABLE_BUNDLES = bundleData.AVAILABLE_BUNDLES;
        window.API_BUNDLES_LOADED = true;
      }

      console.log('✅ Dashboard API initialized');
    } catch (error) {
      console.error('Failed to initialize dashboard:', error);
    }
  }

  function updateUserDisplay(user) {
    const nameEl = document.getElementById('userName');
    const roleEl = document.getElementById('userRole');
    const agentCodeEl = document.getElementById('agentCode');
    
    if (nameEl) nameEl.textContent = user.name || 'User';
    if (roleEl) roleEl.textContent = user.role || 'AGENT';
    if (agentCodeEl) agentCodeEl.textContent = `${user.name?.split(' ')[0]?.toUpperCase() || 'USER'} - ${user.id?.slice(-4) || '0000'}`;
  }

  function updateWalletDisplay(balance) {
    const walletEl = document.getElementById('walletBalance');
    if (walletEl) {
      walletEl.textContent = `GHS ${Number(balance).toFixed(2)}`;
    }
  }

  function updateStatsDisplay(stats) {
    const completedEl = document.getElementById('completedCount');
    const processingEl = document.getElementById('processingCount');
    const pendingEl = document.getElementById('pendingCount');
    const todaySalesEl = document.getElementById('todaysSales');
    const weeklySalesEl = document.getElementById('weeklySales');

    if (completedEl) completedEl.textContent = stats.completed;
    if (processingEl) processingEl.textContent = stats.processing;
    if (pendingEl) pendingEl.textContent = stats.pending;
    if (todaySalesEl) todaySalesEl.textContent = `GHS ${stats.todaySales.toFixed(2)}`;
    if (weeklySalesEl) weeklySalesEl.textContent = `GHS ${stats.weeklySales.toFixed(2)}`;
  }

  // ========== EXPOSE GLOBAL FUNCTIONS ==========

  window.DashboardAPI = {
    checkAuth,
    requireAuth,
    apiRequest,
    getWalletBalance,
    getWallet,
    getBundles,
    getBundlesByNetwork,
    findBundleId,
    // Legacy order functions (backward compatibility)
    createOrder,
    getOrders,
    cancelOrder,
    // New OrderGroup batch functions
    createOrderGroup,
    getOrderGroups,
    getOrderGroupDetails,
    cancelOrderGroup,
    // Profile & utils
    getProfile,
    updateProfile,
    processCheckout,
    getOrderStats,
    loadBundlesFromAPI,
    initDashboard
  };

  // Auto-initialize when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initDashboard);
  } else {
    initDashboard();
  }

})();
