/**
 * Session Timeout Manager
 * Auto-logout users after period of inactivity
 * Include this script in all authenticated pages
 */

(function() {
  'use strict';

  // Configuration - timeout in minutes
  const SESSION_TIMEOUT_MINUTES = 30; // 30 minutes of inactivity
  const WARNING_BEFORE_LOGOUT_SECONDS = 60; // Show warning 60 seconds before logout
  
  const TIMEOUT_MS = SESSION_TIMEOUT_MINUTES * 60 * 1000;
  const WARNING_MS = WARNING_BEFORE_LOGOUT_SECONDS * 1000;
  
  let timeoutId = null;
  let warningTimeoutId = null;
  let warningModal = null;
  let countdownInterval = null;
  
  // Events that reset the timeout (user activity)
  const ACTIVITY_EVENTS = [
    'mousedown',
    'mousemove',
    'keydown',
    'scroll',
    'touchstart',
    'click',
    'focus'
  ];
  
  // Initialize session timeout
  function init() {
    // Don't run on login/public pages
    if (isPublicPage()) {
      return;
    }
    
    createWarningModal();
    resetTimeout();
    
    // Add activity listeners
    ACTIVITY_EVENTS.forEach(event => {
      document.addEventListener(event, onUserActivity, { passive: true });
    });
    
    // Listen for activity from other tabs
    window.addEventListener('storage', onStorageChange);
    
    // Update last activity on load
    updateLastActivity();
    
    console.log(`[Session] Auto-logout enabled: ${SESSION_TIMEOUT_MINUTES} minutes`);
  }
  
  // Check if current page is public (no auth required)
  function isPublicPage() {
    const publicPages = [
      '/pages/login.html',
      '/pages/forgot-password.html',
      '/pages/reset-password.html',
      '/public/store.html'
    ];
    const path = window.location.pathname;
    return publicPages.some(page => path.includes(page));
  }
  
  // Reset the timeout on user activity
  function onUserActivity() {
    // Don't reset if warning modal is showing
    if (warningModal && warningModal.style.display === 'flex') {
      return;
    }
    resetTimeout();
    updateLastActivity();
  }
  
  // Handle storage changes from other tabs
  function onStorageChange(e) {
    if (e.key === 'lastActivity') {
      resetTimeout();
    }
    if (e.key === 'logout') {
      // Another tab triggered logout
      performLogout(false);
    }
  }
  
  // Update last activity timestamp in localStorage (for cross-tab sync)
  function updateLastActivity() {
    localStorage.setItem('lastActivity', Date.now().toString());
  }
  
  // Reset the timeout timer
  function resetTimeout() {
    // Clear existing timeouts
    if (timeoutId) clearTimeout(timeoutId);
    if (warningTimeoutId) clearTimeout(warningTimeoutId);
    if (countdownInterval) clearInterval(countdownInterval);
    
    // Hide warning if showing
    hideWarningModal();
    
    // Set warning timeout (fires before actual logout)
    warningTimeoutId = setTimeout(() => {
      showWarningModal();
    }, TIMEOUT_MS - WARNING_MS);
    
    // Set logout timeout
    timeoutId = setTimeout(() => {
      performLogout(true);
    }, TIMEOUT_MS);
  }
  
  // Create warning modal
  function createWarningModal() {
    // Check if already exists
    if (document.getElementById('sessionWarningModal')) {
      warningModal = document.getElementById('sessionWarningModal');
      return;
    }
    
    warningModal = document.createElement('div');
    warningModal.id = 'sessionWarningModal';
    warningModal.innerHTML = `
      <div class="session-warning-content">
        <div class="session-warning-icon">
          <i class="fas fa-clock"></i>
        </div>
        <h3>Session Expiring</h3>
        <p>You will be logged out in <span id="sessionCountdown">${WARNING_BEFORE_LOGOUT_SECONDS}</span> seconds due to inactivity.</p>
        <div class="session-warning-buttons">
          <button id="sessionStayBtn" class="btn-stay">Stay Logged In</button>
          <button id="sessionLogoutBtn" class="btn-logout-now">Logout Now</button>
        </div>
      </div>
    `;
    
    // Add styles
    const style = document.createElement('style');
    style.textContent = `
      #sessionWarningModal {
        display: none;
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: rgba(0, 0, 0, 0.7);
        z-index: 100000;
        align-items: center;
        justify-content: center;
        backdrop-filter: blur(4px);
      }
      
      .session-warning-content {
        background: white;
        padding: 32px;
        border-radius: 16px;
        text-align: center;
        max-width: 400px;
        width: 90%;
        box-shadow: 0 20px 60px rgba(0,0,0,0.3);
        animation: sessionPopIn 0.3s ease;
      }
      
      @keyframes sessionPopIn {
        from {
          opacity: 0;
          transform: scale(0.9) translateY(-20px);
        }
        to {
          opacity: 1;
          transform: scale(1) translateY(0);
        }
      }
      
      .session-warning-icon {
        width: 64px;
        height: 64px;
        background: #fef3c7;
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        margin: 0 auto 16px;
        font-size: 28px;
        color: #f59e0b;
      }
      
      .session-warning-content h3 {
        margin: 0 0 12px;
        color: #1e293b;
        font-size: 1.3rem;
      }
      
      .session-warning-content p {
        margin: 0 0 24px;
        color: #64748b;
        font-size: 0.95rem;
        line-height: 1.5;
      }
      
      #sessionCountdown {
        font-weight: 700;
        color: #ef4444;
        font-size: 1.1rem;
      }
      
      .session-warning-buttons {
        display: flex;
        gap: 12px;
        justify-content: center;
      }
      
      .session-warning-buttons button {
        padding: 12px 24px;
        border-radius: 8px;
        font-weight: 600;
        cursor: pointer;
        transition: all 0.2s;
        font-size: 0.9rem;
      }
      
      .btn-stay {
        background: #024959;
        color: white;
        border: none;
      }
      
      .btn-stay:hover {
        background: #036c7f;
      }
      
      .btn-logout-now {
        background: white;
        color: #64748b;
        border: 1px solid #e2e8f0;
      }
      
      .btn-logout-now:hover {
        background: #f8fafc;
        color: #ef4444;
        border-color: #ef4444;
      }
    `;
    
    document.head.appendChild(style);
    document.body.appendChild(warningModal);
    
    // Add button listeners
    document.getElementById('sessionStayBtn').addEventListener('click', () => {
      resetTimeout();
      updateLastActivity();
    });
    
    document.getElementById('sessionLogoutBtn').addEventListener('click', () => {
      performLogout(true);
    });
  }
  
  // Show warning modal with countdown
  function showWarningModal() {
    if (!warningModal) return;
    
    warningModal.style.display = 'flex';
    
    let secondsLeft = WARNING_BEFORE_LOGOUT_SECONDS;
    const countdownEl = document.getElementById('sessionCountdown');
    
    countdownInterval = setInterval(() => {
      secondsLeft--;
      if (countdownEl) {
        countdownEl.textContent = secondsLeft;
      }
      if (secondsLeft <= 0) {
        clearInterval(countdownInterval);
      }
    }, 1000);
  }
  
  // Hide warning modal
  function hideWarningModal() {
    if (warningModal) {
      warningModal.style.display = 'none';
    }
    if (countdownInterval) {
      clearInterval(countdownInterval);
    }
    // Reset countdown display
    const countdownEl = document.getElementById('sessionCountdown');
    if (countdownEl) {
      countdownEl.textContent = WARNING_BEFORE_LOGOUT_SECONDS;
    }
  }
  
  // Perform logout
  async function performLogout(showMessage) {
    // Clear intervals
    if (timeoutId) clearTimeout(timeoutId);
    if (warningTimeoutId) clearTimeout(warningTimeoutId);
    if (countdownInterval) clearInterval(countdownInterval);
    
    // Notify other tabs
    localStorage.setItem('logout', Date.now().toString());
    
    // Clear local storage
    localStorage.removeItem('currentUser');
    localStorage.removeItem('adminUser');
    localStorage.removeItem('adminLoggedIn');
    localStorage.removeItem('lastActivity');
    
    // Call logout API to clear httpOnly cookie
    try {
      await fetch('/api/auth/logout', {
        method: 'POST',
        credentials: 'include'
      });
    } catch (e) {
      // Ignore errors
    }
    
    // Determine redirect based on current page
    const isAdminPage = window.location.pathname.includes('/admin/');
    const loginPage = isAdminPage ? '/admin/dashboard.html' : '/pages/login.html';
    
    // Show message if requested
    if (showMessage) {
      sessionStorage.setItem('sessionExpired', 'true');
    }
    
    // Redirect to login
    window.location.href = loginPage;
  }
  
  // Initialize on DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
  
  // Expose for manual control if needed
  window.SessionTimeout = {
    reset: resetTimeout,
    logout: performLogout,
    getTimeoutMinutes: () => SESSION_TIMEOUT_MINUTES
  };
  
})();
