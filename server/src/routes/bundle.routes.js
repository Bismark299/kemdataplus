const express = require('express');
const router = express.Router();
const bundleController = require('../controllers/bundle.controller');
const { authenticate, authorize, optionalAuth } = require('../middleware/auth');

// GET /api/bundles - Get all bundles (admins see all, users see only bundles with price for their role)
router.get('/', optionalAuth, bundleController.getAllBundles);

// GET /api/bundles/network/:network - Get bundles by network (must be before :id route)
router.get('/network/:network', optionalAuth, bundleController.getBundlesByNetwork);

// GET /api/bundles/:id - Get bundle by ID
router.get('/:id', optionalAuth, bundleController.getBundleById);

// GET /api/bundles/:bundleId/price - Get price for current user's role
router.get('/:bundleId/price', authenticate, bundleController.getBundlePrice);

// POST /api/bundles - Create bundle (admin)
router.post('/', authenticate, authorize('ADMIN'), bundleController.createBundle);

// PUT /api/bundles/:id - Update bundle (admin)
router.put('/:id', authenticate, authorize('ADMIN'), bundleController.updateBundle);

// DELETE /api/bundles/:id - Delete bundle (admin) - soft delete
router.delete('/:id', authenticate, authorize('ADMIN'), bundleController.deleteBundle);

// DELETE /api/bundles/:bundleId/price/:role - Remove price for specific role (admin)
router.delete('/:bundleId/price/:role', authenticate, authorize('ADMIN'), bundleController.deleteRolePrice);

module.exports = router;
