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
    const settings = readSettings();
    res.json(settings);
  },

  // PUT /api/settings
  updateSettings: (req, res) => {
    const { adminSettings, siteSettings } = req.body;
    if (!adminSettings || !siteSettings) {
      return res.status(400).json({ error: 'adminSettings and siteSettings are required' });
    }
    const settings = { adminSettings, siteSettings };
    writeSettings(settings);
    res.json({ success: true });
  }
};

module.exports = settingsController;
