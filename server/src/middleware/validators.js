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

// Auth validators
const registerValidation = [
  body('email').isEmail().normalizeEmail().withMessage('Valid email required'),
  body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
  body('name').trim().notEmpty().withMessage('Name is required'),
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
  body('bundleId').notEmpty().withMessage('Bundle ID is required'),
  body('recipientPhone').isMobilePhone().withMessage('Valid phone number required'),
  body('quantity').optional().isInt({ min: 1 }).withMessage('Quantity must be at least 1'),
  validate
];

// Wallet validators
const depositValidation = [
  body('amount').isFloat({ min: 1 }).withMessage('Amount must be at least 1'),
  body('paymentMethod').isIn(['momo', 'bank', 'card']).withMessage('Invalid payment method'),
  body('reference').optional().isString(),
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
  paginationValidation
};
