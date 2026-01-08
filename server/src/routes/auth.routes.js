const express = require('express');
const router = express.Router();
const authController = require('../controllers/auth.controller');
const { authenticate } = require('../middleware/auth');
const { registerValidation, loginValidation } = require('../middleware/validators');

// POST /api/auth/register
router.post('/register', registerValidation, authController.register);

// POST /api/auth/login
router.post('/login', loginValidation, authController.login);

// GET /api/auth/me - Get current user info
router.get('/me', authenticate, authController.getMe);

// POST /api/auth/refresh
router.post('/refresh', authController.refreshToken);

// POST /api/auth/logout
router.post('/logout', authController.logout);

// POST /api/auth/forgot-password - Request password reset
router.post('/forgot-password', authController.forgotPassword);

// GET /api/auth/reset-password/:token - Verify reset token
router.get('/reset-password/:token', authController.verifyResetToken);

// POST /api/auth/reset-password - Reset password with token
router.post('/reset-password', authController.resetPassword);

module.exports = router;
