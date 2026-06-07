/**
 * Shared sync state — prevents auto-sync and admin-triggered Sync All
 * from hitting external APIs simultaneously and causing rate-limit collisions.
 */
module.exports = {
  syncAllRunning: false
};
