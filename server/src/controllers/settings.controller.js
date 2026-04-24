const fs = require('fs');
const path = require('path');

const SETTINGS_FILE = path.join(__dirname, '../../settings.json');

// In-memory cache for settings (faster access, no file I/O delay)
let settingsCache = null;

function readSettings() {
  // Return cache if available
  if (settingsCache) {
    return settingsCache;
  }
  
  // Read from file
  if (!fs.existsSync(SETTINGS_FILE)) {
    settingsCache = { adminSettings: {}, siteSettings: {} };
    return settingsCache;
  }
  try {
    settingsCache = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8'));
    return settingsCache;
  } catch {
    settingsCache = { adminSettings: {}, siteSettings: {} };
    return settingsCache;
  }
}

function writeSettings(settings) {
  // Update cache immediately
  settingsCache = settings;
  // Write to file (for persistence across restarts)
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf-8');
}

// Export function for other modules to check settings
function getSiteSettings() {
  const settings = readSettings();
  return settings.siteSettings || {};
}

function getAdminSettings() {
  const settings = readSettings();
  return settings.adminSettings || {};
}

const settingsController = {
  // GET /api/settings
  getSettings: (req, res) => {
    try {
      const settings = readSettings();
      res.json(settings);
    } catch (err) {
      console.error('Error reading settings:', err);
      res.status(500).json({ error: 'Failed to read settings' });
    }
  },

  // GET /api/settings/public - Public settings (MoMo numbers, etc.)
  getPublicSettings: (req, res) => {
    try {
      const settings = readSettings();
      // Only return public-safe settings
      res.json({
        momoNumbers: settings.adminSettings?.momoNumbers || [],
        momoName: settings.adminSettings?.adminName || 'KemDataplus',
        paystackEnabled: settings.siteSettings?.paystackEnabled !== false,
        momoClaimEnabled: settings.siteSettings?.momoClaimEnabled !== false,
        newRegistration: settings.siteSettings?.newRegistration !== false,
        // Upload limits for client dashboard
        maxExcelUpload: settings.adminSettings?.maxExcelUpload || 50,
        maxBulkUpload: settings.adminSettings?.maxBulkUpload || 50
      });
    } catch (err) {
      console.error('Error reading public settings:', err);
      res.status(500).json({ error: 'Failed to read settings' });
    }
  },

  // PUT /api/settings
  updateSettings: (req, res) => {
    try {
      const { adminSettings, siteSettings } = req.body;
      if (!adminSettings || !siteSettings) {
        return res.status(400).json({ error: 'adminSettings and siteSettings are required' });
      }

      // Detect auto-sync toggling ON (false/undefined → true)
      const oldSettings = getSiteSettings();
      const mcbisToggledOn = !oldSettings.mcbisAutoSync && siteSettings.mcbisAutoSync;
      const ckgodswayToggledOn = !oldSettings.ckgodswayAutoSync && siteSettings.ckgodswayAutoSync;

      const settings = { adminSettings, siteSettings };
      writeSettings(settings);
      console.log('[Settings] Updated:', { mcbisAPI: siteSettings.mcbisAPI, mcbisAutoSync: siteSettings.mcbisAutoSync });

      // If either auto-sync just turned ON, fire a catch-up sync immediately (non-blocking)
      if (mcbisToggledOn || ckgodswayToggledOn) {
        console.log(`[Settings] Auto-sync re-enabled (MCBIS: ${mcbisToggledOn}, CKGodsway: ${ckgodswayToggledOn}) — triggering catch-up sync`);
        setImmediate(async () => {
          try {
            const orderGroupService = require('../services/order-group.service');
            const datahubService = require('../services/datahub.service');
            // Run both catch-up passes concurrently
            await Promise.all([
              orderGroupService.syncAllProcessingItems({
                mcbisEnabled: !!(siteSettings.mcbisAutoSync && siteSettings.mcbisAPI),
                ckgodswayEnabled: !!(siteSettings.ckgodswayAutoSync && siteSettings.ckgodswayAPI),
                catchUp: true
              }),
              mcbisToggledOn && siteSettings.mcbisAPI
                ? datahubService.syncAllPendingOrders({ catchUp: true })
                : Promise.resolve()
            ]);
            console.log('[Settings] Catch-up sync complete');
          } catch (err) {
            console.error('[Settings] Catch-up sync error:', err.message);
          }
        });
      }

      res.json({ success: true });
    } catch (err) {
      console.error('Error saving settings:', err);
      res.status(500).json({ error: 'Failed to save settings' });
    }
  },
  
  // Export helper functions
  getSiteSettings,
  getAdminSettings
};

module.exports = settingsController;
