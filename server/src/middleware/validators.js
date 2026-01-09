const { body, param, query, validationResult } = require('express-validator');

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      error: 'Validation failed',
      details: errors.array()
    });
  }
  next();
};

// Strong password validator
const strongPassword = (value) => {
  if (value.length < 8) {
    throw new Error('Password must be at least 8 characters');
  }
  if (!/[A-Z]/.test(value)) {
    throw new Error('Password must contain at least one uppercase letter');
  }
  if (!/[a-z]/.test(value)) {
    throw new Error('Password must contain at least one lowercase letter');
  }
  if (!/[0-9]/.test(value)) {
    throw new Error('Password must contain at least one number');
  }
  return true;
};

// Sanitize input to prevent XSS
const sanitizeInput = (value) => {
  if (typeof value === 'string') {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#x27;');
  }
  return value;
};

// Auth validators
const registerValidation = [
  body('email').isEmail().normalizeEmail().withMessage('Valid email required'),
  body('password').custom(strongPassword),
  body('name').trim().notEmpty().escape().withMessage('Name is required'),
  body('phone').optional().isMobilePhone().withMessage('Valid phone number required'),
  validate
];

const loginValidation = [
  body('email').isEmail().normalizeEmail().withMessage('Valid email required'),
  body('password').notEmpty().withMessage('Password is required'),
  validate
];

// Order validators
const createOrderValidation = [
  body('bundleId').notEmpty().escape().withMessage('Bundle ID is required'),
  body('recipientPhone').isMobilePhone().withMessage('Valid phone number required'),
  body('quantity').optional().isInt({ min: 1 }).withMessage('Quantity must be at least 1'),
  validate
];

// Wallet validators
const depositValidation = [
  body('amount').isFloat({ min: 1 }).withMessage('Amount must be at least 1'),
  body('paymentMethod').isIn(['momo', 'bank', 'card']).withMessage('Invalid payment method'),
  body('reference').optional().isString().escape(),
  validate
];

// Settings validators
const settingsValidation = [
  body('adminSettings').optional().isObject(),
  body('siteSettings').optional().isObject(),
  body('adminSettings.adminEmail').optional().isEmail(),
  body('adminSettings.momoNumbers').optional().isArray(),
  validate
];

// Pagination validator
const paginationValidation = [
  query('page').optional().isInt({ min: 1 }).toInt(),
  query('limit').optional().isInt({ min: 1, max: 1000 }).toInt(),
  validate
];

module.exports = {
  validate,
  registerValidation,
  loginValidation,
  createOrderValidation,
  depositValidation,
  settingsValidation,
  paginationValidation,
  sanitizeInput
};
