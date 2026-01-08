// API Integration for KemPlus Frontend
// Uses httpOnly cookies for authentication (no localStorage tokens)

const API_BASE_URL = window.location.origin + '/api';

class KemPlusAPI {
  constructor() {
    // No need to store token - it's in httpOnly cookie
  }

  // Make HTTP request with credentials (cookies)
  async request(endpoint, method = 'GET', data = null) {
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
      const response = await fetch(`${API_BASE_URL}${endpoint}`, options);
      
      if (!response.ok) {
        if (response.status === 401) {
          // Session expired, redirect to login
          localStorage.removeItem('currentUser');
          window.location.href = '/pages/login.html';
          throw new Error('Session expired');
        }
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || `API Error: ${response.statusText}`);
      }

      return await response.json();
    } catch (error) {
      console.error('API Request Failed:', error);
      throw error;
    }
  }

  // ===== AUTH ENDPOINTS =====
  async register(email, password, name, phone) {
    const response = await this.request('/auth/register', 'POST', {
      email,
      password,
      name,
      phone
    });
    if (response.user) {
      localStorage.setItem('currentUser', JSON.stringify(response.user));
    }
    return response;
  }

  async login(email, password) {
    const response = await this.request('/auth/login', 'POST', {
      email,
      password
    });
    if (response.user) {
      localStorage.setItem('currentUser', JSON.stringify(response.user));
    }
    return response;
  }

  async getMe() {
    return this.request('/auth/me');
  }

  async refreshToken() {
    return this.request('/auth/refresh', 'POST');
  }

  async logout() {
    try {
      await this.request('/auth/logout', 'POST');
    } catch (e) {
      // Ignore errors
    }
    localStorage.removeItem('currentUser');
    window.location.href = '/pages/login.html';
  }

  // ===== WALLET ENDPOINTS =====
  async getWallet() {
    return this.request('/wallet');
  }

  async getWalletBalance() {
    const response = await this.request('/wallet/balance');
    return response.balance;
  }

  async getWalletTransactions(page = 1, limit = 20) {
    return this.request(`/wallet/transactions?page=${page}&limit=${limit}`);
  }

  async requestDeposit(amount, paymentMethod, reference = null) {
    return this.request('/wallet/deposit', 'POST', {
      amount,
      paymentMethod,
      reference
    });
  }

  async transfer(recipientEmail, amount, description = '') {
    return this.request('/wallet/transfer', 'POST', {
      recipientEmail,
      amount,
      description
    });
  }

  // ===== BUNDLE ENDPOINTS =====
  async getBundles() {
    return this.request('/bundles');
  }

  async getBundlesByNetwork(network) {
    return this.request(`/bundles/network/${network}`);
  }

  async getBundlePrice(bundleId) {
    return this.request(`/bundles/${bundleId}/price`);
  }

  // ===== ORDER ENDPOINTS =====
  async createOrder(bundleId, recipientPhone, quantity = 1) {
    return this.request('/orders', 'POST', {
      bundleId,
      recipientPhone,
      quantity
    });
  }

  async getOrders(page = 1, limit = 20) {
    return this.request(`/orders?page=${page}&limit=${limit}`);
  }

  async getOrderById(orderId) {
    return this.request(`/orders/${orderId}`);
  }

  async cancelOrder(orderId) {
    return this.request(`/orders/${orderId}/cancel`, 'POST');
  }

  // ===== USER ENDPOINTS =====
  async getProfile() {
    return this.request('/users/me');
  }

  async updateProfile(data) {
    return this.request('/users/me', 'PUT', data);
  }
}

// Create global API instance
const kemApi = new KemPlusAPI();

// Export for module usage
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { KemPlusAPI, kemApi };
}
