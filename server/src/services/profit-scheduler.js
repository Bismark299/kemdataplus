/**
 * PROFIT PAYOUT SCHEDULER
 * =======================
 * Runs weekly on Fridays at 7:30 PM Ghana time (Africa/Accra)
 * 
 * Bulk MoMo payout - sends profits directly to agent MoMo wallets
 */

const profitPayoutService = require('../services/profit-payout.service');

let schedulerInterval = null;
let lastRunWeek = null;

// Days of week mapping
const DAYS = {
  'sunday': 0,
  'monday': 1,
  'tuesday': 2,
  'wednesday': 3,
  'thursday': 4,
  'friday': 5,
  'saturday': 6
};

/**
 * Get current time in Ghana timezone
 */
function getGhanaTime() {
  const now = new Date();
  // Ghana is UTC+0 (Africa/Accra), no daylight saving
  return {
    hours: now.getUTCHours(),
    minutes: now.getUTCMinutes(),
    dayOfWeek: now.getUTCDay(), // 0 = Sunday, 5 = Friday
    dateString: now.toISOString().split('T')[0],
    weekNumber: getWeekNumber(now)
  };
}

/**
 * Get ISO week number
 */
function getWeekNumber(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}

/**
 * Check if it's time to run the weekly batch
 */
function shouldRunBatch() {
  const settings = profitPayoutService.getSettings();
  const payoutDay = DAYS[settings.payoutDay?.toLowerCase()] ?? 5; // Default Friday
  const [targetHour, targetMinute] = (settings.payoutTime || '19:30').split(':').map(Number);
  
  const ghana = getGhanaTime();
  const currentMinuteOfDay = ghana.hours * 60 + ghana.minutes;
  const targetMinuteOfDay = targetHour * 60 + targetMinute;
  
  // Check if it's the right day
  const isPayoutDay = ghana.dayOfWeek === payoutDay;
  
  // Run within a 2-minute window
  const withinWindow = currentMinuteOfDay >= targetMinuteOfDay && currentMinuteOfDay < targetMinuteOfDay + 2;
  
  // Only run once per week
  const notRunThisWeek = lastRunWeek !== ghana.weekNumber;
  
  return isPayoutDay && withinWindow && notRunThisWeek && settings.autoProcess;
}

/**
 * Run the weekly batch
 */
async function runWeeklyBatch() {
  const ghana = getGhanaTime();
  console.log(`[Scheduler] Running weekly bulk MoMo payout at ${ghana.hours}:${ghana.minutes} Ghana time (Friday)`);
  
  lastRunWeek = ghana.weekNumber;
  
  try {
    const result = await profitPayoutService.processWeeklyBulkPayout();
    console.log(`[Scheduler] Weekly batch complete:`, result);
  } catch (err) {
    console.error('[Scheduler] Weekly batch processing failed:', err.message);
  }
}

/**
 * Start the scheduler
 */
function startScheduler() {
  const settings = profitPayoutService.getSettings();
  
  // Admin-triggered mode - no automatic scheduling
  if (!settings.autoProcess) {
    console.log(`[Scheduler] Weekly MoMo payouts set to ADMIN MANUAL mode`);
    console.log(`[Scheduler] Payout schedule: ${settings.payoutDay || 'Friday'} at ${settings.payoutTime || '19:30'} Ghana time`);
    console.log(`[Scheduler] Minimum payout: GH₵${settings.minPayout}`);
    console.log(`[Scheduler] Admin must trigger payouts from dashboard`);
    return;
  }
  
  // Auto-process mode
  console.log(`[Scheduler] Starting weekly MoMo payout scheduler (AUTO mode)`);
  console.log(`[Scheduler] Schedule: Every ${settings.payoutDay || 'Friday'} at ${settings.payoutTime || '19:30'} Ghana time`);
  console.log(`[Scheduler] Minimum payout: GH₵${settings.minPayout}`);
  
  // Check every minute
  schedulerInterval = setInterval(() => {
    if (shouldRunBatch()) {
      runWeeklyBatch();
    }
  }, 60000);
  
  // Check immediately on startup
  if (shouldRunBatch()) {
    runWeeklyBatch();
  }
}

/**
 * Stop the scheduler
 */
function stopScheduler() {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
    console.log('[Scheduler] Weekly payout scheduler stopped');
  }
}

/**
 * Get scheduler status
 */
function getSchedulerStatus() {
  const settings = profitPayoutService.getSettings();
  const ghana = getGhanaTime();
  
  const payoutDay = settings.payoutDay || 'friday';
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  
  return {
    running: !!schedulerInterval,
    mode: settings.mode,
    payoutDay: payoutDay.charAt(0).toUpperCase() + payoutDay.slice(1),
    payoutTime: settings.payoutTime || '19:30',
    timezone: settings.timezone || 'Africa/Accra',
    autoProcess: settings.autoProcess,
    minPayout: settings.minPayout,
    lastRunWeek,
    currentGhanaTime: `${ghana.hours.toString().padStart(2, '0')}:${ghana.minutes.toString().padStart(2, '0')}`,
    currentDay: dayNames[ghana.dayOfWeek],
    currentWeek: ghana.weekNumber
  };
}

/**
 * Force run the batch (for admin testing)
 */
async function forceRunBatch() {
  console.log('[Scheduler] Force running weekly batch...');
  return profitPayoutService.processWeeklyBulkPayout();
}

module.exports = {
  startScheduler,
  stopScheduler,
  getSchedulerStatus,
  runWeeklyBatch,
  forceRunBatch
};
