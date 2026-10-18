const express = require('express');
const router = express.Router();
const { authenticate, authorize } = require('../middleware/auth');
const prisma = require('../lib/prisma');
const {
  buildSubmissionWhere,
  markPendingAsSubmitted
} = require('../services/number-verification.service');

router.use(authenticate, authorize('ADMIN'));

function getFilters(req) {
  const status = ['PENDING', 'SUBMITTED', 'VERIFIED', 'REJECTED'].includes(req.query.status)
    ? req.query.status
    : null;
  const query = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 100) : '';
  return { status, query };
}

router.get('/', async (req, res, next) => {
  try {
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const pageSize = 100;
    const where = buildSubmissionWhere(getFilters(req));
    const [submissions, total, counts] = await Promise.all([
      prisma.numberVerificationSubmission.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          submittedBy: {
            select: { id: true, name: true, email: true, phone: true, agentCode: true }
          }
        }
      }),
      prisma.numberVerificationSubmission.count({ where }),
      prisma.numberVerificationSubmission.groupBy({
        by: ['status'],
        _count: { _all: true }
      })
    ]);

    res.json({
      submissions,
      total,
      page,
      pageSize,
      counts: Object.fromEntries(counts.map(item => [item.status, item._count._all]))
    });
  } catch (error) {
    next(error);
  }
});

router.post('/copy-pending', async (req, res, next) => {
  try {
    const result = await markPendingAsSubmitted(prisma, { query: req.body?.query });
    res.json({
      numbers: result.numbers,
      copiedCount: result.numbers.length,
      markedCount: result.markedCount
    });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message });
    next(error);
  }
});

router.get('/export', async (req, res, next) => {
  try {
    const format = req.query.format === 'csv' ? 'csv' : 'txt';
    const where = buildSubmissionWhere(getFilters(req));
    const total = await prisma.numberVerificationSubmission.count({ where });
    if (total > 50000) {
      return res.status(413).json({ error: 'Narrow the filters to export 50,000 numbers or fewer.' });
    }
    const submissions = await prisma.numberVerificationSubmission.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: {
        submittedBy: {
          select: { name: true, email: true, agentCode: true }
        }
      }
    });

    if (format === 'txt') {
      res.type('text/plain; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="submitted-phone-numbers.txt"');
      return res.send(submissions.map(item => item.phoneNumber).join('\n'));
    }

    const csvCell = value => {
      const text = String(value ?? '');
      const safeText = /^[\t\r\n ]*[=+\-@]/.test(text) ? `'${text}` : text;
      return `"${safeText.replace(/"/g, '""')}"`;
    };
    const rows = [
      ['Phone number', 'Status', 'Source', 'Agent', 'Agent code', 'Submitted at', 'Review note'],
      ...submissions.map(item => [
        item.phoneNumber,
        item.status,
        item.source,
        item.submittedBy.name,
        item.submittedBy.agentCode,
        item.createdAt.toISOString(),
        item.reviewNote
      ])
    ];
    res.type('text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="number-verification-submissions.csv"');
    return res.send(rows.map(row => row.map(csvCell).join(',')).join('\r\n'));
  } catch (error) {
    next(error);
  }
});

router.patch('/:id', async (req, res, next) => {
  try {
    const { status, reviewNote } = req.body || {};
    if (!['VERIFIED', 'REJECTED', 'PENDING', 'SUBMITTED'].includes(status)) {
      return res.status(400).json({ error: 'Choose Pending, Submitted, Verified, or Rejected.' });
    }
    if (reviewNote != null && (typeof reviewNote !== 'string' || reviewNote.length > 500)) {
      return res.status(400).json({ error: 'Review note must be 500 characters or fewer.' });
    }

    const existing = await prisma.numberVerificationSubmission.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: 'Submission not found.' });
    if (status === 'SUBMITTED' && existing.status !== 'SUBMITTED') {
      return res.status(409).json({ error: 'Only the copy-for-verification action can mark a number Submitted.' });
    }
    if (status === 'PENDING' && existing.status !== 'PENDING') {
      return res.status(409).json({ error: 'A number that has left Pending cannot be moved back to Pending.' });
    }

    const submission = await prisma.numberVerificationSubmission.update({
      where: { id: req.params.id },
      data: {
        status,
        reviewNote: reviewNote?.trim() || null,
        reviewedById: status === 'PENDING' || status === 'SUBMITTED' ? null : req.user.id,
        reviewedAt: status === 'PENDING' || status === 'SUBMITTED' ? null : new Date()
      }
    });
    res.json({ submission });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
