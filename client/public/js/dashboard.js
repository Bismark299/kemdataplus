/* dashboard.js — Updated full dashboard script
   Place at: ./js/dashboard.js
   Requirements:
    - ordersData.js should load BEFORE this file.
    - ordersData.js functions (initializeStorage, addOrder, saveOrders, saveCart, getWalletBalance, updateWalletBalance, getOrderStats, getWeeklySales, getTodaysSales)
      will be used if available; otherwise script falls back to localStorage.
*/

(function () {
  'use strict';

  /* --------------------------
     Configuration & state
  ---------------------------*/
  // Default PRICING as fallback if no admin data is available
  const DEFAULT_PRICING = {
    MTN: { '1': 4, '2': 8, '3': 12, '4': 16, '5': 20, '6': 24, '8': 32, '10': 38, '15': 57, '20': 76, '25': 95, '30': 114, '40': 152, '50': 190, '100': 380 },
    Telecel: { '1': 4, '2': 8, '3': 12, '4': 16, '5': 20, '6': 24, '8': 32, '10': 38, '15': 57, '20': 76, '25': 95, '30': 114, '40': 152, '50': 190, '100': 380 },
    AirtelTigo: { '1': 4.2, '2': 8.4, '3': 12.6, '4': 16.8, '5': 21, '6': 25.2, '8': 33.6, '10': 39.9, '15': 59.85, '20': 79.8, '25': 99.75, '30': 119.7, '40': 159.6, '50': 199.5, '100': 399 }
  };
  
  // Dynamic data loaded from admin panel
  let PRICING = {};
  let BUNDLE_DATA = {}; // Full bundle data from admin { networkKey: { networkActive, bundles: [{capacity, price, active, outOfStock}] } }
  let NETWORK_STATUS = {}; // { networkKey: boolean }
  let AVAILABLE_BUNDLES = {}; // { networkKey: ['1', '2', '5', ...] } - only active bundles
  
  const FALLBACK_BUNDLES = ['1','2','3','4','5','6','8','10','15','20','25','30','40','50','100'];
  let currentNetwork = 'MTN';
  let currentMode = 'single';
  let cart = []; // canonical cart used by this script (kept in sync with ordersData.js if available)
  let adminDataLoaded = false; // Track if we successfully loaded admin data

  /* --------------------------
     Short helpers
  ---------------------------*/
  const $ = sel => document.querySelector(sel);
  const $$ = sel => Array.from(document.querySelectorAll(sel));
  const safeParse = (s, def) => { try { return JSON.parse(s); } catch { return def; } };

  /* --------------------------
     DOM refs
  ---------------------------*/
  const refs = {
    networkTabs: $$('.network-tab'),
    modeBtns: $$('.mode-btn'),
    modeContents: $$('.mode-content'),
    phoneInput: $('#phoneNumber'),
    bundleSelect: $('#bundleSize'),
    addToCartBtn: $('#addToCartBtn'),
    bulkInput: $('#bulkInput'),
    bulkPreviewBtn: $('#bulkPreviewBtn'),
    bulkPreviewContainer: $('#bulkPreview'),
    bulkPreviewTable: $('#bulkPreviewTable'),
    bulkTotalCount: $('#bulkTotalCount'),
    bulkValidCount: $('#bulkValidCount'),
    bulkInvalidCount: $('#bulkInvalidCount'),
    bulkAddToCartBtn: $('#bulkAddToCartBtn'),
    excelFile: $('#excelFile'),
    excelUploadBtn: $('#excelUploadBtn'),
    excelPreviewContainer: $('#excelPreviewContainer'),
    excelTableBody: $('#excelTableBody'),
    addToCartExcelBtn: $('#addToCartExcelBtn'),
    cartItems: $('#cartItems'),
    cartCount: $('#cartCount'),
    cartTotalAmount: $('#cartTotalAmount'),
    cartTotalDiv: $('#cartTotal'),
    checkoutBtn: $('#checkoutBtn'),
    clearCartBtn: $('#clearCartBtn'),
    walletBalance: $('#walletBalance'),
    completedCount: $('#completedCount'),
    processingCount: $('#processingCount'),
    pendingCount: $('#pendingCount'),
    weeklySales: $('#weeklySales'),
    todaysSales: $('#todaysSales')
  };

  /* --------------------------
     Initialize (load storage, bind events)
  ---------------------------*/
  async function init() {
    console.log('🚀 Initializing Dashboard...');
    
    // Load bundles from API (required)
    if (typeof DashboardAPI !== 'undefined') {
      try {
        console.log('📡 Loading bundles from API...');
        const apiBundles = await DashboardAPI.loadBundlesFromAPI();
        if (apiBundles && Object.keys(apiBundles.BUNDLE_DATA || apiBundles).length > 0) {
          console.log('✅ Loaded bundles from API');
          
          // Handle both formats: {PRICING, BUNDLE_DATA, ...} or direct BUNDLE_DATA
          const bundleData = apiBundles.BUNDLE_DATA || apiBundles;
          
          PRICING = apiBundles.PRICING || {};
          BUNDLE_DATA = bundleData;
          NETWORK_STATUS = apiBundles.NETWORK_STATUS || {};
          AVAILABLE_BUNDLES = apiBundles.AVAILABLE_BUNDLES || {};
          
          // Process API bundle data if not already processed
          if (!apiBundles.PRICING) {
            Object.keys(bundleData).forEach(networkKey => {
              const networkData = bundleData[networkKey];
              if (!PRICING[networkKey]) PRICING[networkKey] = {};
              if (NETWORK_STATUS[networkKey] === undefined) {
                NETWORK_STATUS[networkKey] = networkData.networkActive !== false;
              }
              if (!AVAILABLE_BUNDLES[networkKey]) AVAILABLE_BUNDLES[networkKey] = [];
              
              if (networkData.bundles) {
                networkData.bundles.forEach(bundle => {
                  const cap = String(bundle.capacity).replace(/\D/g, '') || bundle.capacity;
                  PRICING[networkKey][cap] = bundle.price;
                  if (!bundle.outOfStock && !AVAILABLE_BUNDLES[networkKey].includes(cap)) {
                    AVAILABLE_BUNDLES[networkKey].push(cap);
                  }
                });
              }
            });
          }
          adminDataLoaded = true;
        } else {
          console.warn('⚠️ No bundles from API, using defaults');
          useDefaultPricing();
        }
      } catch (e) {
        console.error('❌ API bundle load failed:', e);
        useDefaultPricing();
      }
    } else {
      console.error('❌ DashboardAPI not available');
      useDefaultPricing();
    }
    
    // Initialize cart as empty array (cart is session-only)
    cart = [];

    bindNetworkTabs();
    bindModeButtons();
    bindSingleAdd();
    bindBulkPreview();
    bindBulkAdd();
    bindExcel();
    bindCartButtons();
    bindProfileDropdown();

    // initial UI state
    showMode(currentMode);
    highlightNetwork(currentNetwork);
    
    // Update bundle dropdown based on availability
    updateBundleOptions(currentNetwork);
    
    // Update network status indicators
    updateNetworkStatusUI();

    renderCart();
    refreshStats();
    
    console.log('✅ Dashboard initialized');
  }
  
  /* --------------------------
     Use default pricing (fallback when API fails)
  ---------------------------*/
  function useDefaultPricing() {
    PRICING = {...DEFAULT_PRICING};
    NETWORK_STATUS = { 'MTN': true, 'Telecel': true, 'AirtelTigo': true };
    AVAILABLE_BUNDLES = {
      'MTN': [...FALLBACK_BUNDLES],
      'Telecel': [...FALLBACK_BUNDLES],
      'AirtelTigo': [...FALLBACK_BUNDLES]
    };
    BUNDLE_DATA = {};
    Object.keys(DEFAULT_PRICING).forEach(net => {
      BUNDLE_DATA[net] = {
        networkActive: true,
        networkName: net,
        bundles: FALLBACK_BUNDLES.map(cap => ({
          capacity: cap,
          capacityLabel: cap + ' GB',
          price: DEFAULT_PRICING[net][cap],
          active: true,
          outOfStock: false
        }))
      };
    });
  }
  
  /* --------------------------
     Update Network Status UI
  ---------------------------*/
  function updateNetworkStatusUI() {
    const indicator = $('#networkStatusIndicator');
    if (!indicator) return;
    
    // Check if ALL networks are offline
    const allNetworks = ['MTN', 'Telecel', 'AirtelTigo'];
    const allNetworksOffline = allNetworks.every(net => NETWORK_STATUS[net] === false);
    
    const isActive = NETWORK_STATUS[currentNetwork] !== false;
    
    if (allNetworksOffline) {
      // All networks are OFF - show prominent OUT OF STOCK message
      indicator.style.display = 'flex';
      indicator.style.background = 'linear-gradient(135deg, #fef2f2, #fee2e2)';
      indicator.style.border = '2px solid #ef4444';
      indicator.style.padding = '20px';
      indicator.style.borderRadius = '12px';
      indicator.style.marginBottom = '20px';
      indicator.innerHTML = `
        <span class="status-dot inactive" style="background: #ef4444; width: 14px; height: 14px; animation: pulse 1.5s infinite;"></span>
        <span class="status-text" style="color: #b91c1c; font-weight: 600; font-size: 1.1rem;">
          <i class="fas fa-exclamation-triangle" style="margin-right: 8px;"></i>
          OUT OF STOCK - All networks are currently unavailable. Please check back later.
        </span>
      `;
    } else if (!isActive) {
      // Only current network is OFF
      indicator.style.display = 'flex';
      indicator.style.background = '';
      indicator.style.border = '';
      indicator.style.padding = '';
      indicator.style.borderRadius = '';
      indicator.style.marginBottom = '';
      indicator.innerHTML = `
        <span class="status-dot inactive"></span>
        <span class="status-text">${currentNetwork} is currently OFFLINE - All bundles unavailable</span>
      `;
    } else {
      indicator.style.display = 'none';
    }
    
    // Also update network tab styling
    refs.networkTabs = $$('.network-tab'); // Refresh refs
    refs.networkTabs.forEach(tab => {
      const net = tab.dataset.network;
      const netActive = NETWORK_STATUS[net] !== false;
      tab.classList.toggle('network-inactive', !netActive);
    });
  }
  
  /* --------------------------
     Update Bundle Options Dropdown
  ---------------------------*/
  function updateBundleOptions(network) {
    if (!refs.bundleSelect) {
      refs.bundleSelect = $('#bundleSize');
      if (!refs.bundleSelect) return;
    }
    
    console.log(`🔄 Updating bundle options for ${network}...`);
    
    const networkData = BUNDLE_DATA[network];
    const networkActive = NETWORK_STATUS[network] !== false;
    const networkPricing = PRICING[network] || DEFAULT_PRICING[network] || DEFAULT_PRICING.MTN;
    
    let optionsHtml = '<option value="">-- Choose Bundle --</option>';
    
    // If we have admin data for this network, use it
    if (networkData && networkData.bundles && networkData.bundles.length > 0) {
      // Sort bundles by capacity (ascending order)
      const sortedBundles = [...networkData.bundles].sort((a, b) => {
        const capA = parseInt(a.capacity) || 0;
        const capB = parseInt(b.capacity) || 0;
        return capA - capB;
      });
      
      sortedBundles.forEach(bundle => {
        const isOutOfStock = !networkActive || bundle.outOfStock;
        const price = bundle.price || networkPricing[bundle.capacity] || 0;
        
        if (isOutOfStock) {
          optionsHtml += `<option value="${bundle.capacity}" disabled class="out-of-stock">${bundle.capacity} GB - GHS ${price.toFixed(2)} (OUT OF STOCK)</option>`;
        } else {
          optionsHtml += `<option value="${bundle.capacity}">${bundle.capacity} GB - GHS ${price.toFixed(2)}</option>`;
        }
      });
    } else {
      // Fallback to default bundles
      console.log(`⚠️ No admin bundles for ${network}, using defaults`);
      FALLBACK_BUNDLES.forEach(bundleSize => {
        const price = networkPricing[bundleSize] || DEFAULT_PRICING.MTN[bundleSize] || 0;
        optionsHtml += `<option value="${bundleSize}">${bundleSize} GB - GHS ${price.toFixed(2)}</option>`;
      });
    }
    
    refs.bundleSelect.innerHTML = optionsHtml;
    
    // Show warning if network is inactive
    if (!networkActive) {
      showInlineNotice(`⚠️ ${network} network is currently OFFLINE. All bundles are unavailable.`, 'error');
    }
    
    console.log(`✅ Bundle options updated for ${network}`);
  }

  /* --------------------------
     Network tabs
  ---------------------------*/
  function bindNetworkTabs() {
    refs.networkTabs = $$('.network-tab'); // Refresh refs
    refs.networkTabs.forEach(tab => {
      tab.addEventListener('click', () => {
        const net = tab.dataset.network;
        if (!net) return;
        currentNetwork = net;
        highlightNetwork(net);
        updateBundleOptions(net); // Update bundle dropdown when network changes
        updateNetworkStatusUI();
        recalcCartPrices();
        renderCart();
      });
    });
  }
  function highlightNetwork(net) {
    refs.networkTabs = $$('.network-tab'); // Refresh refs
    refs.networkTabs.forEach(t => t.classList.toggle('active', t.dataset.network === net));
  }

  /* --------------------------
     Mode buttons (single / bulk / excel)
  ---------------------------*/
  function bindModeButtons() {
    refs.modeBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        const mode = btn.dataset.mode;
        if (!mode) return;
        currentMode = mode;
        showMode(mode);
        clearFieldErrors();
      });
    });
  }
  function showMode(mode) {
    currentMode = mode;
    refs.modeBtns.forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
    refs.modeContents.forEach(c => c.style.display = 'none');
    const el = document.getElementById(mode + 'Mode');
    if (el) el.style.display = 'block';
  }

  /* --------------------------
     Single mode add-to-cart
  ---------------------------*/
  function bindSingleAdd() {
    if (!refs.addToCartBtn) return;
    refs.addToCartBtn.addEventListener('click', () => {
      clearFieldErrors();
      const phone = refs.phoneInput ? (refs.phoneInput.value || '').trim() : '';
      const bundle = refs.bundleSelect ? (refs.bundleSelect.value || '') : '';

      if (!/^\d{10}$/.test(phone)) {
        showFieldError('phoneError', 'Enter a valid 10-digit phone number');
        return;
      }
      
      if (!bundle) {
        showFieldError('bundleError', 'Select a bundle size');
        return;
      }
      
      // Check if network is active
      if (!isNetworkActive(currentNetwork)) {
        showFieldError('bundleError', `${currentNetwork} network is currently offline`);
        showInlineNotice(`❌ ${currentNetwork} network is OFFLINE. Please select a different network.`, 'error');
        return;
      }
      
      // Check if bundle is out of stock
      if (isBundleOutOfStock(currentNetwork, bundle)) {
        showFieldError('bundleError', 'This bundle is currently out of stock');
        showInlineNotice('❌ Bundle is out of stock. Please select a different bundle.', 'error');
        return;
      }

      const price = getPrice(currentNetwork, bundle);
      const item = {
        id: Date.now() + Math.floor(Math.random()*1000),
        network: currentNetwork,
        bundle,
        numbers: [phone],
        price: Number(price.toFixed(2)),
        mode: 'single'
      };

      cart.push(item);
      persistCart();
      renderCart();
      showInlineNotice('Added to cart', 'success');
    });
  }

  /* --------------------------
     Bulk parse/preview/add
  ---------------------------*/
  let lastBulkParsed = [];
  function bindBulkPreview() {
    if (!refs.bulkPreviewBtn) return;
    refs.bulkPreviewBtn.addEventListener('click', () => {
      const txt = refs.bulkInput ? refs.bulkInput.value : '';
      lastBulkParsed = parseBulk(txt);
      renderBulkPreview(lastBulkParsed);
    });
  }

  function parseBulk(input) {
    const lines = (input || '').split('\n').map(l => l.trim()).filter(Boolean);
    const seen = new Set();
    const out = [];
    
    // Check if current network is active
    const networkActive = isNetworkActive(currentNetwork);

    // Phone validation: 10 digits starting with 0, OR 9 digits not starting with 0
    const isValidPhone = (ph) => /^0\d{9}$/.test(ph) || /^[1-9]\d{8}$/.test(ph);
    // Normalize phone to 10 digits (add leading 0 if 9 digits)
    const normalizePhone = (ph) => /^[1-9]\d{8}$/.test(ph) ? '0' + ph : ph;

    lines.forEach(line => {
      const parts = line.split(/\s+/);
      const rawPhone = parts[0] || '';
      const bundle = parts[1] || '';
      const phoneOk = isValidPhone(rawPhone);
      const phone = phoneOk ? normalizePhone(rawPhone) : rawPhone;
      const bundleOk = bundle && !isNaN(parseInt(bundle));
      const dup = seen.has(phone);
      if (!dup && phoneOk) seen.add(phone);
      
      // Check stock availability
      const outOfStock = !networkActive || isBundleOutOfStock(currentNetwork, bundle);
      
      let isValid = phoneOk && bundleOk && !dup && !outOfStock;
      let reason = '';
      
      if (!isValid) {
        if (dup) reason = 'Duplicate';
        else if (!phoneOk) reason = 'Invalid phone';
        else if (!bundleOk) reason = 'Invalid bundle';
        else if (!networkActive) reason = 'Network offline';
        else if (outOfStock) reason = 'Out of stock';
      }
      
      out.push({ phone, bundle, isValid, reason, outOfStock });
    });

    return out;
  }

  function renderBulkPreview(parsed) {
    if (!refs.bulkPreviewContainer) return;
    refs.bulkPreviewContainer.style.display = 'block';
    refs.bulkPreviewTable.innerHTML = '';
    const total = parsed.length;
    const valid = parsed.filter(p => p.isValid).length;
    const invalid = total - valid;
    const outOfStockCount = parsed.filter(p => p.outOfStock).length;

    if (refs.bulkTotalCount) refs.bulkTotalCount.textContent = total;
    if (refs.bulkValidCount) refs.bulkValidCount.textContent = valid;
    if (refs.bulkInvalidCount) refs.bulkInvalidCount.textContent = invalid;

    parsed.forEach(row => {
      const tr = document.createElement('tr');
      if (!row.isValid) tr.classList.add('row-invalid');
      if (row.outOfStock) tr.classList.add('row-out-of-stock');
      // XSS Protection: Use textContent instead of innerHTML for user data
      const tdPhone = document.createElement('td');
      tdPhone.textContent = row.phone;
      const tdBundle = document.createElement('td');
      tdBundle.textContent = row.bundle;
      const tdStatus = document.createElement('td');
      tdStatus.textContent = row.isValid ? '✓ Valid' : '✗ ' + row.reason;
      tr.appendChild(tdPhone);
      tr.appendChild(tdBundle);
      tr.appendChild(tdStatus);
      refs.bulkPreviewTable.appendChild(tr);
    });

    if (refs.bulkAddToCartBtn) {
      refs.bulkAddToCartBtn.disabled = valid === 0;
      refs.bulkAddToCartBtn.textContent = `Add ${valid} Items to Cart`;
    }
    
    // Show warning if items are out of stock
    if (outOfStockCount > 0) {
      showInlineNotice(`⚠️ ${outOfStockCount} item(s) are out of stock and will not be added`, 'error');
    }
  }

  function bindBulkAdd() {
    if (!refs.bulkAddToCartBtn) return;
    refs.bulkAddToCartBtn.addEventListener('click', () => {
      const good = lastBulkParsed.filter(p => p.isValid);
      if (!good.length) return showInlineNotice('No valid items to add', 'error');

      good.forEach(v => {
        const price = getPrice(currentNetwork, v.bundle);
        cart.push({
          id: Date.now()+Math.floor(Math.random()*1000),
          network: currentNetwork,
          bundle: v.bundle,
          numbers: [v.phone],
          price: Number(price.toFixed(2)),
          mode: 'bulk'
        });
      });

      lastBulkParsed = [];
      if (refs.bulkInput) refs.bulkInput.value = '';
      if (refs.bulkPreviewContainer) refs.bulkPreviewContainer.style.display = 'none';
      persistCart();
      renderCart();
      showInlineNotice('Bulk items added to cart', 'success');
    });
  }

  /* --------------------------
     Excel handler (SheetJS)
  ---------------------------*/
  let lastExcelParsed = [];
  function bindExcel() {
    if (!refs.excelFile) return;
    refs.excelFile.addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      if (refs.excelUploadBtn) refs.excelUploadBtn.disabled = !file;
      // show filename if present
      const nameSpan = document.getElementById('fileNameDisplay');
      if (nameSpan) nameSpan.textContent = file ? file.name : 'Choose Excel File (.xlsx or .csv)';
    });

    if (refs.excelUploadBtn) {
      refs.excelUploadBtn.addEventListener('click', () => {
        const file = refs.excelFile.files && refs.excelFile.files[0];
        if (!file) return showInlineNotice('Please select a file', 'error');
        parseExcel(file);
      });
    }

    if (refs.addToCartExcelBtn) {
      refs.addToCartExcelBtn.addEventListener('click', () => {
        const valid = lastExcelParsed.filter(p => p.isValid);
        if (!valid.length) return showInlineNotice('No valid items to add', 'error');
        valid.forEach(v => {
          const price = getPrice(currentNetwork, v.bundle);
          cart.push({
            id: Date.now()+Math.floor(Math.random()*1000),
            network: currentNetwork,
            bundle: v.bundle,
            numbers: [v.phone],
            price: Number(price.toFixed(2)),
            mode: 'excel'
          });
        });
        lastExcelParsed = [];
        if (refs.excelFile) refs.excelFile.value = '';
        if (refs.excelPreviewContainer) refs.excelPreviewContainer.style.display = 'none';
        persistCart();
        renderCart();
        showInlineNotice('Excel items added to cart', 'success');
      });
    }
  }

  function parseExcel(file) {
    const reader = new FileReader();
    reader.onload = function(e) {
      try {
        const data = e.target.result;
        let rows = [];
        if (file.name.endsWith('.xlsx') || file.type.includes('spreadsheet')) {
          const wb = XLSX.read(data, { type: 'binary' });
          const sheet = wb.Sheets[wb.SheetNames[0]];
          rows = XLSX.utils.sheet_to_json(sheet, { header: 1 });
        } else {
          // csv/text fallback
          rows = data.split('\n').map(r => r.split(/[,\t|]+/).map(c => c.trim()));
        }
        lastExcelParsed = processExcel(rows);
        renderExcelPreview(lastExcelParsed);
      } catch (err) {
        console.error(err);
        showInlineNotice('Error parsing file', 'error');
      }
    };
    reader.readAsBinaryString(file);
  }

  function processExcel(rows) {
    const seen = new Set();
    const out = [];
    const networkActive = isNetworkActive(currentNetwork);

    // Phone validation: 10 digits starting with 0, OR 9 digits not starting with 0
    const isValidPhone = (ph) => /^0\d{9}$/.test(ph) || /^[1-9]\d{8}$/.test(ph);
    // Normalize phone to 10 digits (add leading 0 if 9 digits)
    const normalizePhone = (ph) => /^[1-9]\d{8}$/.test(ph) ? '0' + ph : ph;
    
    rows.forEach((r, i) => {
      if (!r || r.length === 0) return;
      if (i === 0 && String(r[0]||'').toLowerCase().includes('phone')) return;
      const rawPhone = String(r[0] || '').trim();
      const bundle = String(r[1] || '').trim();
      if (!rawPhone) return;
      const phoneOk = isValidPhone(rawPhone);
      const phone = phoneOk ? normalizePhone(rawPhone) : rawPhone;
      const dup = seen.has(phone);
      if (!dup && phoneOk) seen.add(phone);
      
      const bundleOk = bundle && !isNaN(parseInt(bundle));
      const outOfStock = !networkActive || isBundleOutOfStock(currentNetwork, bundle);
      
      const ok = phoneOk && bundleOk && !dup && !outOfStock;
      let reason = '';
      if (!ok) {
        if (dup) reason = 'Duplicate';
        else if (!phoneOk) reason = 'Invalid phone';
        else if (!bundleOk) reason = 'Invalid bundle';
        else if (!networkActive) reason = 'Network offline';
        else if (outOfStock) reason = 'Out of stock';
      }
      
      out.push({ phone, bundle, quantity: r[2] || 1, isValid: ok, reason, outOfStock });
    });
    return out;
  }

  function renderExcelPreview(parsed) {
    if (!refs.excelPreviewContainer) return;
    refs.excelPreviewContainer.style.display = 'block';
    if (!refs.excelTableBody) return;
    refs.excelTableBody.innerHTML = '';
    
    const outOfStockCount = parsed.filter(p => p.outOfStock).length;
    
    parsed.forEach(item => {
      const tr = document.createElement('tr');
      if (!item.isValid) tr.classList.add('row-invalid');
      if (item.outOfStock) tr.classList.add('row-out-of-stock');
      // XSS Protection: Use textContent instead of innerHTML for user data
      const tdPhone = document.createElement('td');
      tdPhone.textContent = item.phone;
      const tdBundle = document.createElement('td');
      tdBundle.textContent = item.bundle;
      const tdQty = document.createElement('td');
      tdQty.textContent = item.quantity;
      const tdStatus = document.createElement('td');
      tdStatus.textContent = item.isValid ? 'Valid' : item.reason;
      tr.appendChild(tdPhone);
      tr.appendChild(tdBundle);
      tr.appendChild(tdQty);
      tr.appendChild(tdStatus);
      refs.excelTableBody.appendChild(tr);
    });
    const validCount = parsed.filter(p => p.isValid).length;
    const total = parsed.length;
    document.getElementById('totalNumbers') && (document.getElementById('totalNumbers').textContent = total);
    document.getElementById('validNumbers') && (document.getElementById('validNumbers').textContent = validCount);
    document.getElementById('invalidNumbers') && (document.getElementById('invalidNumbers').textContent = total - validCount);
    
    // Show warning if items are out of stock
    if (outOfStockCount > 0) {
      showInlineNotice(`⚠️ ${outOfStockCount} item(s) are out of stock and will not be added`, 'error');
    }
    if (refs.addToCartExcelBtn) { refs.addToCartExcelBtn.disabled = validCount === 0; refs.addToCartExcelBtn.textContent = `Add ${validCount} Valid Items to Cart`; }
  }

  /* --------------------------
     Cart rendering & persistence
  ---------------------------*/
  function persistCart() {
    // Cart is session-only - just sync to global variable
    window.cart = cart;
    console.log('🛒 Cart updated:', cart.length, 'items');
  }

  function recalcCartPrices() {
    cart = cart.map(item => {
      const price = getPrice(item.network || currentNetwork, item.bundle);
      return Object.assign({}, item, { price: Number(price.toFixed(2)) });
    });
    persistCart();
  }

  function renderCart() {
    if (!refs.cartItems) return;
    refs.cartItems.innerHTML = '';
    const countEl = refs.cartCount;
    const totalEl = refs.cartTotalAmount;
    const totalDiv = refs.cartTotalDiv;
    const checkoutBtn = refs.checkoutBtn;
    const clearBtn = refs.clearCartBtn;

    if (!cart.length) {
      refs.cartItems.innerHTML = '<div class="empty-cart">Cart is empty</div>';
      if (countEl) countEl.textContent = '(0)';
      if (totalDiv) totalDiv.style.display = 'none';
      if (checkoutBtn) checkoutBtn.style.display = 'none';
      if (clearBtn) clearBtn.style.display = 'none';
      persistCart();
      return;
    }

    let total = 0;
    const html = cart.map(item => {
      total += (item.price || 0);
      const phones = (item.numbers || []).join(', ');
      return `<div class="cart-item"><div class="cart-item-info"><strong>${item.network}</strong><br><small style="color:#666;word-break:break-word;">${phones}</small><br>${item.bundle}<br><span class="cart-item-price">GHS ${(item.price||0).toFixed(2)}</span></div><button class="cart-remove" data-id="${item.id}" title="Delete"><i class="fas fa-trash-alt"></i></button></div>`;
    }).join('');

    refs.cartItems.innerHTML = html;
    if (countEl) countEl.textContent = `(${cart.length})`;
    if (totalEl) totalEl.textContent = `GHS ${total.toFixed(2)}`;
    if (totalDiv) totalDiv.style.display = 'flex';
    if (checkoutBtn) checkoutBtn.style.display = 'block';
    if (clearBtn) clearBtn.style.display = 'block';

    // attach remove handlers (delegation safe)
    refs.cartItems.querySelectorAll('.cart-remove').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.id;
        cart = cart.filter(i => String(i.id) !== String(id));
        persistCart();
        renderCart();
      });
    });

    persistCart();
  }

  /* --------------------------
     Cart buttons - clear & checkout
  ---------------------------*/
  function bindCartButtons() {
    if (refs.clearCartBtn) {
      refs.clearCartBtn.addEventListener('click', () => {
        if (!cart.length) { showInlineNotice('Cart is already empty'); return; }
        if (!confirm('Are you sure you want to clear the cart?')) return;
        cart = [];
        persistCart();
        renderCart();
        showInlineNotice('Cart cleared', 'success');
      });
    }

    if (refs.checkoutBtn) {
      refs.checkoutBtn.addEventListener('click', checkoutHandler);
    }
  }

  async function checkoutHandler() {
    if (!cart.length) return showInlineNotice('Cart is empty', 'error');

    const total = cart.reduce((s,i) => s + (i.price || 0), 0);

    // Check if DashboardAPI is available (API mode - required)
    if (typeof DashboardAPI === 'undefined') {
      showInlineNotice('API not available. Please refresh the page.', 'error');
      return;
    }
    
    try {
      // Use the API for checkout
      const result = await DashboardAPI.processCheckout(cart);
      
      if (result.success) {
        // Clear cart & update UI
        cart = [];
        persistCart();
        renderCart();
        
        // Update wallet display from API
        updateWalletDisplay();
        
        // Show success message only (no redirect)
        showInlineNotice('Order placed successfully!', 'success');
      } else {
        showInlineNotice(result.error || 'Checkout failed', 'error');
      }
    } catch (error) {
      console.error('Checkout error:', error);
      showInlineNotice('Checkout failed: ' + error.message, 'error');
    }
  }

  /* --------------------------
     Utilities & UI helpers
  ---------------------------*/
  function getPrice(network, bundle) {
    if (PRICING[network] && PRICING[network][bundle] !== undefined) return PRICING[network][bundle];
    if (DEFAULT_PRICING[network] && DEFAULT_PRICING[network][bundle] !== undefined) return DEFAULT_PRICING[network][bundle];
    return (DEFAULT_PRICING.MTN[bundle] || 0);
  }
  
  function isBundleOutOfStock(network, bundle) {
    // First check network status
    if (NETWORK_STATUS[network] === false) {
      console.log(`🚫 ${network} network is inactive`);
      return true;
    }
    
    // Then check bundle data
    const networkData = BUNDLE_DATA[network];
    if (!networkData) {
      console.log(`⚠️ No data for ${network}, assuming available`);
      return false; // If no admin data, assume available
    }
    
    // Find the specific bundle
    const bundleInfo = networkData.bundles.find(b => b.capacity === String(bundle));
    if (bundleInfo) {
      const isOutOfStock = bundleInfo.outOfStock === true;
      if (isOutOfStock) {
        console.log(`🚫 Bundle ${bundle}GB on ${network} is out of stock`);
      }
      return isOutOfStock;
    }
    
    // If bundle not found in admin data but network is active, check if we have any active bundles
    if (AVAILABLE_BUNDLES[network] && AVAILABLE_BUNDLES[network].length > 0) {
      // Bundle not in available list means it's out of stock
      const isAvailable = AVAILABLE_BUNDLES[network].includes(String(bundle));
      if (!isAvailable) {
        console.log(`🚫 Bundle ${bundle}GB not in available list for ${network}`);
      }
      return !isAvailable;
    }
    
    return false; // Default to available if no admin restrictions
  }
  
  function isNetworkActive(network) {
    return NETWORK_STATUS[network] !== false;
  }

  function showFieldError(id, message) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = message;
    el.classList.add('show');
  }
  function clearFieldErrors() {
    $$('.error-msg').forEach(e => { e.textContent = ''; e.classList.remove('show'); });
  }

  function showInlineNotice(msg, type = 'info') {
    // Create or reuse toast element
    let toast = document.getElementById('dashboardToast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'dashboardToast';
      toast.style.cssText = `
        position: fixed;
        bottom: 20px;
        right: 20px;
        background: ${type === 'error' ? '#f44336' : type === 'success' ? '#4CAF50' : '#024959'};
        color: white;
        padding: 15px 25px;
        border-radius: 8px;
        box-shadow: 0 4px 12px rgba(0,0,0,0.2);
        z-index: 9999;
        font-size: 0.95rem;
        max-width: 350px;
        opacity: 0;
        transform: translateY(20px);
        transition: all 0.3s ease;
      `;
      document.body.appendChild(toast);
    }
    
    // Update toast color based on type
    toast.style.background = type === 'error' ? '#f44336' : type === 'success' ? '#4CAF50' : '#024959';
    toast.textContent = msg;
    
    // Show toast
    setTimeout(() => {
      toast.style.opacity = '1';
      toast.style.transform = 'translateY(0)';
    }, 10);
    
    // Hide after 3 seconds
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(20px)';
    }, 3000);
  }

  async function updateWalletDisplay() {
    // Use API for wallet and order stats
    if (typeof DashboardAPI === 'undefined') {
      console.warn('DashboardAPI not available');
      return;
    }
    
    try {
      const apiBalance = await DashboardAPI.getWalletBalance();
      if (apiBalance !== null && refs.walletBalance) {
        refs.walletBalance.textContent = 'GHS ' + Number(apiBalance).toFixed(2);
      }
      
      // Also update order stats from API
      const stats = await DashboardAPI.getOrderStats();
      if (stats) {
        if (refs.completedCount) refs.completedCount.textContent = stats.completed || 0;
        if (refs.processingCount) refs.processingCount.textContent = stats.processing || 0;
        if (refs.pendingCount) refs.pendingCount.textContent = stats.pending || 0;
        if (refs.weeklySales) refs.weeklySales.textContent = 'GHS ' + Number(stats.weeklyTotal || 0).toFixed(2);
        if (refs.todaysSales) refs.todaysSales.textContent = 'GHS ' + Number(stats.todayTotal || 0).toFixed(2);
      }
    } catch (e) {
      console.error('Failed to fetch wallet/stats from API:', e);
    }
  }

  function refreshStats() {
    updateWalletDisplay();
  }

  function bindProfileDropdown() {
    const profileBtn = $('#profileBtn');
    const dropdown = $('#dropdownMenu');
    if (!profileBtn || !dropdown) return;
    profileBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      dropdown.style.display = dropdown.style.display === 'block' ? 'none' : 'block';
    });
    document.addEventListener('click', () => { dropdown.style.display = 'none'; });
  }

  /* --------------------------
     Initialization call
  ---------------------------*/
  document.addEventListener('DOMContentLoaded', init);

  /* Expose a tiny API for debugging (optional)
     window.__kd_debug__ = { getCart: () => cart, setNetwork: (n)=>{currentNetwork=n;recalcCartPrices();renderCart();} };
  */

})();
