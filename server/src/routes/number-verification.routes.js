const express = require('express');
const router = express.Router();
const { authenticate, authorize } = require('../middleware/auth');
const prisma = require('../lib/prisma');
const {
  MAX_NUMBERS_PER_SUBMISSION,
  submitNumbers
} = require('../services/number-verification.service');

const SUBMITTER_ROLES = ['AGENT', 'SUPER_AGENT', 'DEALER', 'SUPER_DEALER', 'PARTNER'];

router.post('/', authenticate, authorize(...SUBMITTER_ROLES), async (req, res, next) => {
  try {
    const source = req.body?.source === 'EXCEL' ? 'EXCEL' : 'MANUAL';
    const result = await submitNumbers(prisma, {
      userId: req.user.id,
      values: req.body?.numbers,
      source
    });
    res.status(201).json({ ...result, maxNumbers: MAX_NUMBERS_PER_SUBMISSION });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message });
    next(error);
  }
});

router.get('/mine', authenticate, authorize(...SUBMITTER_ROLES), async (req, res, next) => {
  try {
    const submissions = await prisma.numberVerificationSubmission.findMany({
      where: { submittedById: req.user.id },
      orderBy: { createdAt: 'desc' },
      take: 500,
      select: {
        id: true,
        batchId: true,
        phoneNumber: true,
        source: true,
        status: true,
        reviewNote: true,
        createdAt: true,
        reviewedAt: true
      }
    });
    res.json({ submissions });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
