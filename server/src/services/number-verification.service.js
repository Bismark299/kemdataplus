const { randomUUID } = require('crypto');

const MAX_NUMBERS_PER_SUBMISSION = 500;
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
  const created = await prisma.numberVerificationSubmission.createMany({
    data: numbers.map(phoneNumber => ({
      batchId,
      phoneNumber,
      source,
      submittedById: userId
    }))
  });

  return {
    batchId,
    submittedCount: created.count,
    duplicateCount: values.length - invalid.length - numbers.length,
    invalidCount: invalid.length,
    invalid
  };
}

function buildSubmissionWhere({ status, query }) {
  const where = {};
  if (status && ['PENDING', 'VERIFIED', 'REJECTED'].includes(status)) where.status = status;
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

module.exports = {
  MAX_NUMBERS_PER_SUBMISSION,
  normalizePhoneNumber,
  normalizePhoneNumbers,
  submitNumbers,
  buildSubmissionWhere
};
