const express = require('express');
const router = express.Router();
const settingsController = require('../controllers/settings.controller');
const { authenticate, authorize } = require('../middleware/auth');

// GET /api/settings - Get all settings (admin only)
router.get('/', authenticate, authorize('ADMIN'), settingsController.getSettings);

// PUT /api/settings - Update settings (admin only)
router.put('/', authenticate, authorize('ADMIN'), settingsController.updateSettings);

module.exports = router;
