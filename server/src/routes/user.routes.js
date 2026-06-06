const express = require('express');
const router = express.Router();
const userController = require('../controllers/user.controller');
const { authenticate, authorize } = require('../middleware/auth');
const { paginationValidation } = require('../middleware/validators');

// GET /api/users/me - Get current user
router.get('/me', authenticate, userController.getProfile);

// PUT /api/users/me - Update current user
router.put('/me', authenticate, userController.updateProfile);

// GET /api/users - Get all users (admin only)
router.get('/', authenticate, authorize('ADMIN'), paginationValidation, userController.getAllUsers);

// GET /api/users/:id - Get user by ID (admin only)
router.get('/:id', authenticate, authorize('ADMIN'), userController.getUserById);

// PUT /api/users/:id - Update user (admin only)
router.put('/:id', authenticate, authorize('ADMIN'), userController.updateUser);

// PUT /api/users/:id/reset-password - Reset user password (admin only)
router.put('/:id/reset-password', authenticate, authorize('ADMIN'), userController.resetUserPassword);

// POST /api/users/:id/unlock - Unlock locked account (admin only)
router.post('/:id/unlock', authenticate, authorize('ADMIN'), userController.unlockUser);

// DELETE /api/users/:id - Deactivate user (admin only)
router.delete('/:id', authenticate, authorize('ADMIN'), userController.deactivateUser);

module.exports = router;
