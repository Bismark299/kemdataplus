const fs = require('fs');
const path = require('path');
const prisma = require('../lib/prisma');

const SETTINGS_FILE = path.join(__dirname, '../../settings.json');

const DB_KEY_ADMIN = 'adminSettings';
const DB_KEY_SITE  = 'siteSettings';

// In-memory cache — the single runtime source of truth.
// Populated at startup from DB (or file as fallback), then kept in sync.
let settingsCache = null;

// ─── DB helpers ──────────────────────────────────────────────────────────────

async function readSettingsFromDb() {
  try {
    const rows = await prisma.systemSettings.findMany({
      where: { key: { in: [DB_KEY_ADMIN, DB_KEY_SITE] } }
    });
    if (!rows || rows.length === 0) return null;
    const result = { adminSettings: {}, siteSettings: {} };
    for (const row of rows) {
      if (row.key === DB_KEY_ADMIN) result.adminSettings = row.value || {};
      if (row.key === DB_KEY_SITE)  result.siteSettings  = row.value || {};
    }
    return result;
  } catch (err) {
    console.error('[Settings] DB read error:', err.message);
    return null;
  }
}

async function writeSettingsToDb(settings) {
  try {
    await Promise.all([
      prisma.systemSettings.upsert({
        where:  { key: DB_KEY_ADMIN },
        update: { value: settings.adminSettings || {} },
        create: { key: DB_KEY_ADMIN, value: settings.adminSettings || {}, description: 'Admin settings (API keys, MoMo numbers, etc.)' }
      }),
      prisma.systemSettings.upsert({
        where:  { key: DB_KEY_SITE },
        update: { value: settings.siteSettings || {} },
        create: { key: DB_KEY_SITE,  value: settings.siteSettings  || {}, description: 'Site settings (feature toggles)' }
      })
    ]);
  } catch (err) {
    console.error('[Settings] DB write error:', err.message);
  }
}

// ─── File helpers (legacy / local dev) ───────────────────────────────────────

function readSettingsFromFile() {
  if (!fs.existsSync(SETTINGS_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8'));
  } catch {
    return null;
  }
}

function writeSettingsToFile(settings) {
  try {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf-8');
  } catch (err) {
    // Silently ignore on read-only filesystems (e.g. production containers)
  }
}

// ─── Public sync helpers ──────────────────────────────────────────────────────

function readSettings() {
  if (settingsCache) return settingsCache;
  // Cold-start fallback: try file, then return empty defaults
  const fromFile = readSettingsFromFile();
  settingsCache = fromFile || { adminSettings: {}, siteSettings: {} };
  return settingsCache;
}

function writeSettings(settings) {
  settingsCache = settings;
  // Write to file for local dev convenience (best-effort)
  writeSettingsToFile(settings);
  // Persist to DB asynchronously (non-blocking — cache is already updated)
  writeSettingsToDb(settings).catch(() => {});
}

// ─── Startup initialiser (must be awaited before first use) ──────────────────

async function initSettings() {
  try {
    // 1. Try DB first
    const fromDb = await readSettingsFromDb();
    if (fromDb && (Object.keys(fromDb.adminSettings).length > 0 || Object.keys(fromDb.siteSettings).length > 0)) {
      settingsCache = fromDb;
      console.log('[Settings] Loaded from database');
      // Keep local file in sync (best-effort)
      writeSettingsToFile(fromDb);
      return;
    }

    // 2. DB empty — try file (first-run or migration from old deployment)
    const fromFile = readSettingsFromFile();
    if (fromFile) {
      settingsCache = fromFile;
      console.log('[Settings] Migrating from settings.json → database');
      await writeSettingsToDb(fromFile);
      return;
    }

    // 3. Nothing anywhere — start with empty defaults
    settingsCache = { adminSettings: {}, siteSettings: {} };
    console.log('[Settings] No saved settings found — using defaults');
  } catch (err) {
    console.error('[Settings] initSettings error:', err.message);
    // Ensure cache is at least defined
    if (!settingsCache) settingsCache = { adminSettings: {}, siteSettings: {} };
  }
}

// ─── Accessors used throughout the codebase ──────────────────────────────────

function getSiteSettings() {
  const settings = readSettings();
  return settings.siteSettings || {};
}

function getAdminSettings() {
  const settings = readSettings();
  return settings.adminSettings || {};
}

// ─── Route handlers ───────────────────────────────────────────────────────────

const settingsController = {
  getSettings: (req, res) => {
    try {
      res.json(readSettings());
    } catch (err) {
      console.error('Error reading settings:', err);
      res.status(500).json({ error: 'Failed to read settings' });
    }
  },

  getPublicSettings: (req, res) => {
    try {
      const settings = readSettings();
      res.json({
        momoNumbers:     settings.adminSettings?.momoNumbers || [],
        momoName:        settings.adminSettings?.adminName || 'KemDataplus',
        paystackEnabled: settings.siteSettings?.paystackEnabled !== false,
        momoClaimEnabled: settings.siteSettings?.momoClaimEnabled !== false,
        newRegistration: settings.siteSettings?.newRegistration !== false,
        maxExcelUpload:  settings.adminSettings?.maxExcelUpload || 50,
        maxBulkUpload:   settings.adminSettings?.maxBulkUpload || 50,
        storeDomain:     process.env.STORE_DOMAIN || null
      });
    } catch (err) {
      console.error('Error reading public settings:', err);
      res.status(500).json({ error: 'Failed to read settings' });
    }
  },

  updateSettings: (req, res) => {
    try {
      const { adminSettings, siteSettings } = req.body;
      if (!adminSettings || !siteSettings) {
        return res.status(400).json({ error: 'adminSettings and siteSettings are required' });
      }

      // Detect auto-sync toggling ON (false/undefined → true)
      const oldSettings = getSiteSettings();
      const mcbisToggledOn          = !oldSettings.mcbisAutoSync          && siteSettings.mcbisAutoSync;
      const ckgodswayToggledOn      = !oldSettings.ckgodswayAutoSync      && siteSettings.ckgodswayAutoSync;
      const instantdataghToggledOn  = !oldSettings.instantdataghAutoSync  && siteSettings.instantdataghAutoSync;

      // Detect main API toggle turning ON — any provider newly enabled should retry stuck PENDING orders
      const anyProviderToggledOn =
        (!oldSettings.instantdataghAPI && siteSettings.instantdataghAPI) ||
        (!oldSettings.ckgodswayAPI     && siteSettings.ckgodswayAPI)     ||
        (!oldSettings.datagatekeeperAPI && siteSettings.datagatekeeperAPI) ||
        (!oldSettings.mcbisAPI         && siteSettings.mcbisAPI);

      const settings = { adminSettings, siteSettings };
      writeSettings(settings);
      console.log('[Settings] Updated:', { mcbisAPI: siteSettings.mcbisAPI, instantdataghAPI: siteSettings.instantdataghAPI });

      // If any auto-sync or provider API just turned ON, fire a catch-up sync immediately (non-blocking)
      if (mcbisToggledOn || ckgodswayToggledOn || instantdataghToggledOn || anyProviderToggledOn) {
        console.log(`[Settings] Provider/sync enabled — triggering catch-up (MCBIS: ${mcbisToggledOn}, CKG: ${ckgodswayToggledOn}, IDG: ${instantdataghToggledOn}, anyAPI: ${anyProviderToggledOn})`);
        setImmediate(async () => {
          try {
            const orderGroupService = require('../services/order-group.service');
            const datahubService    = require('../services/datahub.service');
            await Promise.all([
              orderGroupService.syncAllProcessingItems({
                mcbisEnabled:          !!(siteSettings.mcbisAutoSync          && siteSettings.mcbisAPI),
                ckgodswayEnabled:      !!(siteSettings.ckgodswayAutoSync      && siteSettings.ckgodswayAPI),
                datagatekeeperEnabled: !!(siteSettings.datagatekeeperAPI),
                instantdataghEnabled:  !!(siteSettings.instantdataghAutoSync  && siteSettings.instantdataghAPI),
                catchUp: true
              }),
              // Retry stuck PENDING orders whenever any provider is newly enabled
              anyProviderToggledOn || instantdataghToggledOn || ckgodswayToggledOn
                ? orderGroupService.retryStuckPendingOrders()
                : Promise.resolve(),
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

  initSettings,
  getSiteSettings,
  getAdminSettings
};

module.exports = settingsController;
