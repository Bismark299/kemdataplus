/**
 * SMS SERVICE (mNotify Integration - API v2.0)
 * =============================================
 * Sends SMS notifications via mNotify Ghana API v2.0
 * 
 * mNotify API v2 Docs: https://docs.mnotify.com/
 * 
 * Required ENV variables:
 * - MNOTIFY_API_KEY: Your mNotify API key
 * - MNOTIFY_SENDER_ID: Sender ID (max 11 chars, e.g., "KemDataplus")
 */

const fs = require('fs');
const path = require('path');

// Load settings for smsNotify toggle
function getSettings() {
  try {
    const settingsPath = path.join(__dirname, '../../settings.json');
    if (fs.existsSync(settingsPath)) {
      return JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    }
  } catch (err) {
    console.error('[SMS] Error loading settings:', err.message);
  }
  return { adminSettings: { smsNotify: false } };
}

// mNotify API v2.0 Configuration
const MNOTIFY_CONFIG = {
  baseUrl: 'https://api.mnotify.com/api',
  apiKey: process.env.MNOTIFY_API_KEY || '',
  senderId: process.env.MNOTIFY_SENDER_ID || 'KemDataplus'
};

/**
 * Format phone number for mNotify (Ghana format)
 * Converts various formats to 233XXXXXXXXX
 */
function formatPhoneNumber(phone) {
  if (!phone) return null;
  
  // Remove all non-digits
  let cleaned = phone.replace(/\D/g, '');
  
  // Handle different formats
  if (cleaned.startsWith('233')) {
    // Already in international format
    return cleaned;
  } else if (cleaned.startsWith('0')) {
    // Local format: 0244123456 -> 233244123456
    return '233' + cleaned.substring(1);
  } else if (cleaned.length === 9) {
    // Just the number without prefix: 244123456 -> 233244123456
    return '233' + cleaned;
  }
  
  return cleaned;
}

/**
 * Send SMS via mNotify API v2.0
 * Uses POST method with JSON body
 */
async function sendSMS(phoneNumber, message) {
  // Check if SMS is enabled
  const settings = getSettings();
  if (!settings.adminSettings?.smsNotify) {
    console.log('[SMS] SMS notifications disabled in settings');
    return { success: false, reason: 'disabled' };
  }

  // Check API key
  if (!MNOTIFY_CONFIG.apiKey) {
    console.log('[SMS] mNotify API key not configured');
    return { success: false, reason: 'no_api_key' };
  }

  // Format phone number
  const formattedPhone = formatPhoneNumber(phoneNumber);
  if (!formattedPhone) {
    console.log('[SMS] Invalid phone number:', phoneNumber);
    return { success: false, reason: 'invalid_phone' };
  }

  try {
    // mNotify API v2.0 - POST with JSON body
    const url = `${MNOTIFY_CONFIG.baseUrl}/sms/quick?key=${MNOTIFY_CONFIG.apiKey}`;
    
    const body = {
      recipient: [formattedPhone],
      sender: MNOTIFY_CONFIG.senderId,
      message: message,
      is_schedule: false,
      schedule_date: ''
    };

    console.log(`[SMS] Sending to ${formattedPhone}: "${message.substring(0, 50)}..."`);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });

    const data = await response.json();
    console.log('[SMS] mNotify send response:', JSON.stringify(data));

    // mNotify v2 returns { status: "success", code: "1000" } on success
    if (data.status === 'success' || data.code === '1000' || data.code === 1000) {
      console.log(`[SMS] Sent successfully to ${formattedPhone}`);
      return { 
        success: true, 
        messageId: data.message_id,
        balance: data.balance 
      };
    } else {
      console.error('[SMS] mNotify error:', data);
      return { 
        success: false, 
        reason: 'api_error',
        error: data.message || data.status || 'Unknown error'
      };
    }

  } catch (error) {
    console.error('[SMS] Request failed:', error.message);
    return { 
      success: false, 
      reason: 'request_failed',
      error: error.message 
    };
  }
}

/**
 * Send payout completion SMS to agent
 */
async function sendPayoutCompletedSMS(agentPhone, agentName, amount, reference) {
  const message = `Hi ${agentName || 'Agent'}, your withdrawal of GHC ${amount.toFixed(2)} has been sent to your MoMo account. Ref: ${reference}. Thank you for using KemDataplus!`;
  
  return await sendSMS(agentPhone, message);
}

/**
 * Send payout failed SMS to agent
 */
async function sendPayoutFailedSMS(agentPhone, agentName, amount, reason) {
  const message = `Hi ${agentName || 'Agent'}, your withdrawal of GHC ${amount.toFixed(2)} could not be processed. ${reason ? `Reason: ${reason}. ` : ''}Please contact support or try again. - KemDataplus`;
  
  return await sendSMS(agentPhone, message);
}

/**
 * Send withdrawal request received SMS
 */
async function sendWithdrawalRequestSMS(agentPhone, agentName, amount) {
  const message = `Hi ${agentName || 'Agent'}, your withdrawal request of GHC ${amount.toFixed(2)} has been received and is being processed. You'll be notified once it's sent. - KemDataplus`;
  
  return await sendSMS(agentPhone, message);
}

/**
 * Send profit credited SMS
 */
async function sendProfitCreditedSMS(agentPhone, agentName, amount, orderId) {
  const message = `Hi ${agentName || 'Agent'}, GHC ${amount.toFixed(2)} profit has been credited to your wallet from order #${orderId?.slice(-6) || 'N/A'}. - KemDataplus`;
  
  return await sendSMS(agentPhone, message);
}

/**
 * Get mNotify account balance (API v2.0)
 */
async function getBalance() {
  if (!MNOTIFY_CONFIG.apiKey) {
    return { success: false, reason: 'no_api_key' };
  }

  try {
    // mNotify API v2.0 balance endpoint
    const url = `${MNOTIFY_CONFIG.baseUrl}/balance/sms?key=${MNOTIFY_CONFIG.apiKey}`;
    
    console.log('[SMS] Fetching balance from mNotify v2...');
    console.log('[SMS] URL:', url.replace(MNOTIFY_CONFIG.apiKey, 'API_KEY_HIDDEN'));
    
    const response = await fetch(url, {
      method: 'GET',
      headers: { 
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      }
    });

    const text = await response.text();
    console.log('[SMS] mNotify raw response:', text);
    
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      // If response is just a number
      const num = parseFloat(text);
      if (!isNaN(num)) {
        return { success: true, balance: num, bonus: 0 };
      }
      return { success: false, error: 'Invalid response format' };
    }
    
    console.log('[SMS] mNotify balance response:', JSON.stringify(data));
    
    // mNotify v2 can return balance in different formats:
    // 1. { status: 'success', balance: 100, bonus: 0 }
    // 2. { balance: '100', bonus: '0' }
    // 3. { sms_balance: 100 }
    // 4. Just a number
    
    // Handle direct number response
    if (typeof data === 'number') {
      return { success: true, balance: data, bonus: 0 };
    }
    
    // Handle object response with status
    if (data.status === 'success' || data.balance !== undefined || data.sms_balance !== undefined) {
      return { 
        success: true, 
        balance: parseFloat(data.balance || data.sms_balance) || 0,
        bonus: parseFloat(data.bonus) || 0
      };
    }

    return { success: false, error: data.message || data.error || 'Unknown error' };
  } catch (error) {
    console.error('[SMS] Error fetching balance:', error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Check if SMS is configured and enabled
 */
function isEnabled() {
  const settings = getSettings();
  return settings.adminSettings?.smsNotify && !!MNOTIFY_CONFIG.apiKey;
}

module.exports = {
  sendSMS,
  sendPayoutCompletedSMS,
  sendPayoutFailedSMS,
  sendWithdrawalRequestSMS,
  sendProfitCreditedSMS,
  getBalance,
  isEnabled,
  formatPhoneNumber
};
