const { randomUUID } = require('crypto');

const MAX_NUMBERS_PER_SUBMISSION = 500;
const MAX_PENDING_COPY_ROWS = 50000;
const PHONE_NUMBER_PATTERN = /^\+?\d{7,15}$/;

function normalizePhoneNumber(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const trimmed = String(value).trim();
  if (!trimmed || /[a-z]/i.test(trimmed)) return null;

  // Remove common human formatting while retaining an optional leading +.
  const compact = trimmed.replace(/[\s().-]/g, '');
  if (!PHONE_NUMBER_PATTERN.test(compact)) return null;
  return compact;
}

function normalizePhoneNumbers(values) {
  const numbers = [];
  const seen = new Set();
  const invalid = [];

  for (const value of values) {
    const number = normalizePhoneNumber(value);
    if (!number) {
      if (String(value ?? '').trim()) invalid.push(String(value).trim().slice(0, 80));
      continue;
    }
    if (!seen.has(number)) {
      seen.add(number);
      numbers.push(number);
    }
  }

  return { numbers, invalid };
}

async function submitNumbers(prisma, { userId, values, source }) {
  if (!Array.isArray(values) || values.length === 0) {
    const error = new Error('Submit at least one phone number.');
    error.status = 400;
    throw error;
  }
  if (values.length > MAX_NUMBERS_PER_SUBMISSION) {
    const error = new Error(`A submission can contain at most ${MAX_NUMBERS_PER_SUBMISSION} numbers.`);
    error.status = 400;
    throw error;
  }

  const { numbers, invalid } = normalizePhoneNumbers(values);
  if (!numbers.length) {
    const error = new Error('No valid phone numbers were found.');
    error.status = 400;
    throw error;
  }

  const batchId = randomUUID();
  const previousHandled = await prisma.numberVerificationSubmission.findMany({
    where: {
      phoneNumber: { in: numbers },
      status: { in: ['SUBMITTED', 'VERIFIED'] }
    },
    orderBy: { createdAt: 'desc' },
    select: { phoneNumber: true, status: true }
  });
  const handledStatusByNumber = new Map();
  for (const item of previousHandled) {
    if (item.status === 'VERIFIED' || !handledStatusByNumber.has(item.phoneNumber)) {
      handledStatusByNumber.set(item.phoneNumber, item.status);
    }
  }
  const created = await prisma.numberVerificationSubmission.createMany({
    data: numbers.map(phoneNumber => ({
      batchId,
      phoneNumber,
      source,
      submittedById: userId,
      status: handledStatusByNumber.get(phoneNumber) || 'PENDING'
    }))
  });
  const alreadyHandledCount = numbers.filter(phoneNumber => handledStatusByNumber.has(phoneNumber)).length;

  return {
    batchId,
    submittedCount: created.count,
    alreadyHandledCount,
    duplicateCount: values.length - invalid.length - numbers.length,
    invalidCount: invalid.length,
    invalid
  };
}

function buildSubmissionWhere({ status, query }) {
  const where = {};
  if (status && ['PENDING', 'SUBMITTED', 'VERIFIED', 'REJECTED'].includes(status)) where.status = status;
  if (query) {
    where.OR = [
      { phoneNumber: { contains: query, mode: 'insensitive' } },
      { submittedBy: { name: { contains: query, mode: 'insensitive' } } },
      { submittedBy: { email: { contains: query, mode: 'insensitive' } } },
      { submittedBy: { phone: { contains: query, mode: 'insensitive' } } }
    ];
  }
  return where;
}

async function markPendingAsSubmitted(prisma, { query = '' } = {}) {
  const search = typeof query === 'string' ? query.trim().slice(0, 100) : '';

  return prisma.$transaction(async tx => {
    const rows = await tx.$queryRaw`
      SELECT s."id", s."phoneNumber"
      FROM "number_verification_submissions" AS s
      LEFT JOIN "users" AS u ON u."id" = s."submittedById"
      WHERE s."status" = 'PENDING'
        AND (
          ${search} = ''
          OR s."phoneNumber" ILIKE '%' || ${search} || '%'
          OR COALESCE(u."name", '') ILIKE '%' || ${search} || '%'
          OR COALESCE(u."email", '') ILIKE '%' || ${search} || '%'
          OR COALESCE(u."phone", '') ILIKE '%' || ${search} || '%'
        )
      ORDER BY s."createdAt" ASC, s."id" ASC
      LIMIT ${MAX_PENDING_COPY_ROWS + 1}
      FOR UPDATE OF s
    `;

    if (rows.length > MAX_PENDING_COPY_ROWS) {
      const error = new Error('Narrow your search to copy 50,000 or fewer pending entries at once.');
      error.status = 413;
      throw error;
    }

    if (!rows.length) return { numbers: [], markedCount: 0 };

    const update = await tx.numberVerificationSubmission.updateMany({
      where: {
        id: { in: rows.map(row => row.id) },
        status: 'PENDING'
      },
      data: { status: 'SUBMITTED' }
    });

    if (update.count !== rows.length) {
      const error = new Error('The pending queue changed while copying. Refresh the queue and try again.');
      error.status = 409;
      throw error;
    }

    return {
      numbers: [...new Set(rows.map(row => row.phoneNumber))],
      markedCount: update.count
    };
  });
}

module.exports = {
  MAX_NUMBERS_PER_SUBMISSION,
  MAX_PENDING_COPY_ROWS,
  normalizePhoneNumber,
  normalizePhoneNumbers,
  submitNumbers,
  buildSubmissionWhere,
  markPendingAsSubmitted
};
