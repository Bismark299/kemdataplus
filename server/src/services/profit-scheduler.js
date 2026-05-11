/**
 * PROFIT PAYOUT SCHEDULER
 * =======================
 * Runs weekly on Fridays at 7:30 PM Ghana time (Africa/Accra)
 * 
 * Bulk MoMo payout - sends profits directly to agent MoMo wallets
 * 
 * Also runs a background checker every 5 minutes to verify stuck
 * PROCESSING withdrawals with Paystack (in case webhooks fail)
 */

const profitPayoutService = require('../services/profit-payout.service');
const paystackService = require('../services/paystack.service');
const prisma = require('../lib/prisma');

let schedulerInterval = null;
let stuckCheckerInterval = null;
let lastRunWeek = null;

// Check stuck PROCESSING withdrawals every 5 minutes
const STUCK_CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

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
 * Check and complete stuck PROCESSING withdrawals
 * This runs every 5 minutes as a fallback for failed webhooks
 */
async function checkStuckWithdrawals() {
  try {
    // Find PROCESSING withdrawals older than 2 minutes
    const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000);
    
    const stuckPayouts = await prisma.agentPayout.findMany({
      where: {
        status: 'PROCESSING',
        updatedAt: { lt: twoMinutesAgo }
      },
      include: {
        user: { select: { id: true, name: true, email: true } }
      }
    });
    
    if (stuckPayouts.length === 0) return;
    
    console.log(`[StuckChecker] Found ${stuckPayouts.length} PROCESSING withdrawal(s) to verify`);
    
    for (const payout of stuckPayouts) {
      try {
        // Try to get transfer status from Paystack
        const transferCode = payout.transferCode || payout.reference;
        const result = await paystackService.getTransferStatus(transferCode);
        
        if (!result.success) {
          // Try verify by reference
          const verifyResult = await paystackService.verifyTransfer(payout.reference);
          if (verifyResult.success) {
            await processStuckResult(payout, verifyResult.status);
          } else {
            console.log(`[StuckChecker] Could not verify ${payout.reference}: ${verifyResult.error}`);
          }
          continue;
        }
        
        await processStuckResult(payout, result.status, result.transferCode);
        
      } catch (err) {
        console.error(`[StuckChecker] Error checking ${payout.reference}:`, err.message);
      }
    }
  } catch (err) {
    console.error('[StuckChecker] Error in stuck withdrawals check:', err.message);
  }
}

/**
 * Process the result from Paystack status check
 */
async function processStuckResult(payout, paystackStatus, transferCode) {
  console.log(`[StuckChecker] ${payout.reference}: Paystack status = ${paystackStatus}`);
  
  if (paystackStatus === 'success') {
    // Mark as completed
    await prisma.$transaction(async (tx) => {
      // Mark profits as paid
      const profits = await tx.pendingProfit.findMany({
        where: { userId: payout.userId, status: 'PENDING' },
        orderBy: { createdAt: 'asc' }
      });
      
      let remaining = payout.amount;
      const profitIdsToMark = [];
      for (const profit of profits) {
        if (remaining <= 0) break;
        profitIdsToMark.push(profit.id);
        remaining -= profit.amount;
      }
      
      if (profitIdsToMark.length > 0) {
        await tx.pendingProfit.updateMany({
          where: { id: { in: profitIdsToMark } },
          data: { status: 'PAID', payoutId: payout.id }
        });
      }
      
      await tx.agentPayout.update({
        where: { id: payout.id },
        data: {
          status: 'COMPLETED',
          processedAt: new Date(),
          transferCode: transferCode || payout.transferCode,
          reviewNotes: (payout.reviewNotes || '') + '\nAuto-completed by stuck checker (webhook missed)'
        }
      });
    });
    
    console.log(`[StuckChecker] ✅ ${payout.reference} marked as COMPLETED`);
    
  } else if (paystackStatus === 'failed' || paystackStatus === 'reversed') {
    // Refund and mark as failed
    await prisma.$transaction(async (tx) => {
      await tx.agentPayout.update({
        where: { id: payout.id },
        data: {
          status: 'FAILED',
          failureReason: `Paystack status: ${paystackStatus}`,
          reviewNotes: (payout.reviewNotes || '') + '\nAuto-failed by stuck checker'
        }
      });
      
      // Refund as new pending profit
      await tx.pendingProfit.create({
        data: {
          userId: payout.userId,
          amount: payout.amount,
          description: `Refund: Failed withdrawal ${payout.reference}`,
          status: 'PENDING'
        }
      });
    });
    
    console.log(`[StuckChecker] ❌ ${payout.reference} marked as FAILED, GH₵${payout.amount} refunded as pending profit`);
    
  } else {
    console.log(`[StuckChecker] ${payout.reference} still pending on Paystack (${paystackStatus})`);
  }
}

/**
 * Start the stuck withdrawals checker
 */
function startStuckChecker() {
  if (stuckCheckerInterval) {
    clearInterval(stuckCheckerInterval);
  }
  
  console.log(`[StuckChecker] Starting background checker (every 5 minutes)`);
  
  // Run every 5 minutes
  stuckCheckerInterval = setInterval(checkStuckWithdrawals, STUCK_CHECK_INTERVAL_MS);
  
  // Run once after 30 seconds on startup
  setTimeout(checkStuckWithdrawals, 30000);
}

/**
 * Start the scheduler
 */
function startScheduler() {
  const settings = profitPayoutService.getSettings();
  
  // Always start the stuck checker (regardless of auto/manual mode)
  startStuckChecker();
  
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
  if (stuckCheckerInterval) {
    clearInterval(stuckCheckerInterval);
    stuckCheckerInterval = null;
    console.log('[StuckChecker] Background checker stopped');
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
  forceRunBatch,
  checkStuckWithdrawals,
  startStuckChecker
};
