/**
 * JOB QUEUE SERVICE
 * ===================
 * Simple in-memory job queue for background processing of payouts.
 * Handles:
 * - Batch payout processing with rate limiting
 * - Automatic retries for failed jobs
 * - Job status tracking
 * 
 * Note: This is an in-memory queue. For production with multiple servers,
 * consider using Redis-backed solutions like Bull or BullMQ.
 */

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const alertService = require('./alert.service');
const auditService = require('./audit.service');

// Job queue storage
const jobQueue = {
  pending: [],
  processing: null,
  completed: [],
  failed: [],
  isProcessing: false,
  stats: {
    totalProcessed: 0,
    totalSuccess: 0,
    totalFailed: 0,
    lastProcessedAt: null
  }
};

// Configuration
const CONFIG = {
  RATE_LIMIT_MS: 2000,        // 2 seconds between payouts (Paystack rate limit)
  MAX_RETRIES: 3,             // Maximum retry attempts
  RETRY_DELAY_MS: 5000,       // Wait 5 seconds before retry
  MAX_BATCH_SIZE: 50,         // Maximum payouts per batch
  CLEANUP_AFTER_HOURS: 24     // Clean up completed jobs after 24 hours
};

/**
 * Add a payout job to the queue
 */
function addJob(payoutId, adminId, options = {}) {
  const job = {
    id: `job_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    payoutId,
    adminId,
    otp: options.otp,
    priority: options.priority || 'normal', // 'high', 'normal', 'low'
    status: 'pending',
    attempts: 0,
    maxRetries: options.maxRetries || CONFIG.MAX_RETRIES,
    createdAt: new Date(),
    startedAt: null,
    completedAt: null,
    error: null,
    result: null
  };

  // Add to queue based on priority
  if (job.priority === 'high') {
    jobQueue.pending.unshift(job);
  } else {
    jobQueue.pending.push(job);
  }

  console.log(`[JobQueue] Added job ${job.id} for payout ${payoutId}`);
  
  // Start processing if not already running
  if (!jobQueue.isProcessing) {
    processNextJob();
  }

  return job;
}

/**
 * Add multiple payout jobs as a batch
 */
function addBatch(payoutIds, adminId, options = {}) {
  const batchId = `batch_${Date.now()}`;
  const jobs = [];

  // Limit batch size
  const limitedIds = payoutIds.slice(0, CONFIG.MAX_BATCH_SIZE);

  for (const payoutId of limitedIds) {
    const job = addJob(payoutId, adminId, {
      ...options,
      batchId
    });
    job.batchId = batchId;
    jobs.push(job);
  }

  console.log(`[JobQueue] Added batch ${batchId} with ${jobs.length} jobs`);

  return {
    batchId,
    jobCount: jobs.length,
    jobs: jobs.map(j => ({ id: j.id, payoutId: j.payoutId }))
  };
}

/**
 * Process the next job in queue
 */
async function processNextJob() {
  // Check if already processing or queue is empty
  if (jobQueue.isProcessing || jobQueue.pending.length === 0) {
    return;
  }

  jobQueue.isProcessing = true;
  const job = jobQueue.pending.shift();
  jobQueue.processing = job;
  job.status = 'processing';
  job.startedAt = new Date();
  job.attempts++;

  console.log(`[JobQueue] Processing job ${job.id} (attempt ${job.attempts})`);

  try {
    // Get the payout service (lazy load to avoid circular deps)
    const profitPayoutService = require('./profit-payout.service');
    
    // Process the withdrawal
    const result = await profitPayoutService.processWithdrawalRequest(
      job.payoutId,
      job.adminId,
      job.otp
    );

    // Mark as completed
    job.status = 'completed';
    job.completedAt = new Date();
    job.result = {
      success: true,
      transferCode: result.transfer?.transfer_code,
      reference: result.transfer?.reference
    };

    jobQueue.completed.push(job);
    jobQueue.stats.totalProcessed++;
    jobQueue.stats.totalSuccess++;
    jobQueue.stats.lastProcessedAt = new Date();

    console.log(`[JobQueue] Job ${job.id} completed successfully`);

    // Log audit
    await auditService.log({
      action: 'PAYOUT_PROCESS',
      userId: job.adminId,
      targetId: job.payoutId,
      targetType: 'PayoutRequest',
      details: {
        source: 'job_queue',
        jobId: job.id,
        attempt: job.attempts
      }
    });

  } catch (error) {
    console.error(`[JobQueue] Job ${job.id} failed:`, error.message);

    // Check if should retry
    if (job.attempts < job.maxRetries) {
      job.status = 'retry';
      job.error = error.message;
      
      // Re-add to queue after delay
      setTimeout(() => {
        job.status = 'pending';
        jobQueue.pending.push(job);
        console.log(`[JobQueue] Job ${job.id} re-queued for retry (attempt ${job.attempts + 1})`);
        
        if (!jobQueue.isProcessing) {
          processNextJob();
        }
      }, CONFIG.RETRY_DELAY_MS);

    } else {
      // Max retries exceeded
      job.status = 'failed';
      job.completedAt = new Date();
      job.error = error.message;
      
      jobQueue.failed.push(job);
      jobQueue.stats.totalProcessed++;
      jobQueue.stats.totalFailed++;
      
      console.log(`[JobQueue] Job ${job.id} failed permanently after ${job.attempts} attempts`);

      // Create alert for failed payout
      await alertService.payoutFailed(job.payoutId, error.message, {
        jobId: job.id,
        attempts: job.attempts,
        source: 'job_queue'
      });

      // Update payout status to failed
      await prisma.payoutRequest.update({
        where: { id: job.payoutId },
        data: { 
          status: 'FAILED',
          notes: `Job queue failed after ${job.attempts} attempts: ${error.message}`
        }
      });
    }
  }

  // Clear current processing
  jobQueue.processing = null;
  jobQueue.isProcessing = false;

  // Rate limit: wait before processing next job
  if (jobQueue.pending.length > 0) {
    setTimeout(() => {
      processNextJob();
    }, CONFIG.RATE_LIMIT_MS);
  }
}

/**
 * Get queue status
 */
function getStatus() {
  return {
    pending: jobQueue.pending.length,
    processing: jobQueue.processing ? {
      id: jobQueue.processing.id,
      payoutId: jobQueue.processing.payoutId,
      startedAt: jobQueue.processing.startedAt,
      attempts: jobQueue.processing.attempts
    } : null,
    completed: jobQueue.completed.length,
    failed: jobQueue.failed.length,
    isProcessing: jobQueue.isProcessing,
    stats: jobQueue.stats
  };
}

/**
 * Get job by ID
 */
function getJob(jobId) {
  // Check all queues
  const allJobs = [
    ...jobQueue.pending,
    ...(jobQueue.processing ? [jobQueue.processing] : []),
    ...jobQueue.completed,
    ...jobQueue.failed
  ];
  
  return allJobs.find(j => j.id === jobId);
}

/**
 * Get batch status
 */
function getBatchStatus(batchId) {
  const allJobs = [
    ...jobQueue.pending,
    ...(jobQueue.processing ? [jobQueue.processing] : []),
    ...jobQueue.completed,
    ...jobQueue.failed
  ];
  
  const batchJobs = allJobs.filter(j => j.batchId === batchId);
  
  if (batchJobs.length === 0) {
    return null;
  }

  return {
    batchId,
    totalJobs: batchJobs.length,
    pending: batchJobs.filter(j => j.status === 'pending').length,
    processing: batchJobs.filter(j => j.status === 'processing').length,
    completed: batchJobs.filter(j => j.status === 'completed').length,
    failed: batchJobs.filter(j => j.status === 'failed').length,
    retry: batchJobs.filter(j => j.status === 'retry').length,
    jobs: batchJobs.map(j => ({
      id: j.id,
      payoutId: j.payoutId,
      status: j.status,
      attempts: j.attempts,
      error: j.error
    }))
  };
}

/**
 * Cancel a pending job
 */
function cancelJob(jobId) {
  const index = jobQueue.pending.findIndex(j => j.id === jobId);
  if (index === -1) {
    return { success: false, error: 'Job not found or already processing' };
  }

  const job = jobQueue.pending.splice(index, 1)[0];
  job.status = 'cancelled';
  job.completedAt = new Date();
  jobQueue.completed.push(job);

  console.log(`[JobQueue] Job ${jobId} cancelled`);
  return { success: true, job };
}

/**
 * Clear completed/failed jobs older than cleanup threshold
 */
function cleanup() {
  const cutoff = new Date(Date.now() - CONFIG.CLEANUP_AFTER_HOURS * 60 * 60 * 1000);
  
  const completedBefore = jobQueue.completed.length;
  const failedBefore = jobQueue.failed.length;
  
  jobQueue.completed = jobQueue.completed.filter(j => j.completedAt > cutoff);
  jobQueue.failed = jobQueue.failed.filter(j => j.completedAt > cutoff);
  
  const cleaned = (completedBefore - jobQueue.completed.length) + (failedBefore - jobQueue.failed.length);
  
  if (cleaned > 0) {
    console.log(`[JobQueue] Cleaned up ${cleaned} old jobs`);
  }
  
  return { cleaned };
}

/**
 * Get recent job history (for admin view)
 */
function getHistory(limit = 50) {
  const allCompleted = [...jobQueue.completed, ...jobQueue.failed]
    .sort((a, b) => new Date(b.completedAt) - new Date(a.completedAt))
    .slice(0, limit);
  
  return allCompleted.map(j => ({
    id: j.id,
    payoutId: j.payoutId,
    status: j.status,
    attempts: j.attempts,
    createdAt: j.createdAt,
    completedAt: j.completedAt,
    error: j.error,
    result: j.result
  }));
}

// Start cleanup interval (run every hour)
setInterval(cleanup, 60 * 60 * 1000);

module.exports = {
  addJob,
  addBatch,
  getStatus,
  getJob,
  getBatchStatus,
  cancelJob,
  cleanup,
  getHistory,
  CONFIG
};
