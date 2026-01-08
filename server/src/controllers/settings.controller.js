const fs = require('fs');
const path = require('path');

const SETTINGS_FILE = path.join(__dirname, '../../settings.json');

function readSettings() {
  if (!fs.existsSync(SETTINGS_FILE)) {
    return { adminSettings: {}, siteSettings: {} };
  }
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8'));
  } catch {
    return { adminSettings: {}, siteSettings: {} };
  }
}

function writeSettings(settings) {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf-8');
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
        momoName: settings.adminSettings?.adminName || 'KemDataplus'
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
      const settings = { adminSettings, siteSettings };
      writeSettings(settings);
      res.json({ success: true });
    } catch (err) {
      console.error('Error saving settings:', err);
      res.status(500).json({ error: 'Failed to save settings' });
    }
  }
};

module.exports = settingsController;
