const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MAX_NUMBERS_PER_SUBMISSION,
  normalizePhoneNumber,
  normalizePhoneNumbers,
  submitNumbers,
  buildSubmissionWhere
} = require('../src/services/number-verification.service');

test('normalizes common phone formatting without adding spaces', () => {
  assert.equal(normalizePhoneNumber(' 0244 689 575 '), '0244689575');
  assert.equal(normalizePhoneNumber('(024) 468-9575'), '0244689575');
  assert.equal(normalizePhoneNumber('+233 24 468 9575'), '+233244689575');
});

test('rejects headers, alphabetic cells, and implausible phone lengths', () => {
  assert.equal(normalizePhoneNumber('Phone Number'), null);
  assert.equal(normalizePhoneNumber('0244ABC9575'), null);
  assert.equal(normalizePhoneNumber('123456'), null);
  assert.equal(normalizePhoneNumber('1234567890123456'), null);
});

test('removes duplicates within one submitted list and reports invalid values', () => {
  assert.deepEqual(normalizePhoneNumbers([
    '0244 689 575',
    '0244689575',
    'not a phone',
    ''
  ]), {
    numbers: ['0244689575'],
    invalid: ['not a phone']
  });
});

test('submits unique normalized numbers as pending in one batch', async () => {
  let inserted;
  const fakePrisma = {
    numberVerificationSubmission: {
      async createMany({ data }) {
        inserted = data;
        return { count: data.length };
      }
    }
  };
  const result = await submitNumbers(fakePrisma, {
    userId: 'agent-1',
    values: ['0244 689 575', '0244689575', '0555546229'],
    source: 'EXCEL'
  });

  assert.equal(result.submittedCount, 2);
  assert.equal(result.duplicateCount, 1);
  assert.equal(result.invalidCount, 0);
  assert.ok(result.batchId);
  assert.deepEqual(inserted.map(row => row.phoneNumber), ['0244689575', '0555546229']);
  assert.ok(inserted.every(row => row.status === undefined && row.source === 'EXCEL' && row.submittedById === 'agent-1'));
  assert.equal(inserted[0].batchId, inserted[1].batchId);
});

test('rejects empty submissions and submissions over the row limit', async () => {
  const fakePrisma = { numberVerificationSubmission: { createMany: async () => ({ count: 0 }) } };
  await assert.rejects(
    submitNumbers(fakePrisma, { userId: 'agent-1', values: [], source: 'MANUAL' }),
    { status: 400 }
  );
  await assert.rejects(
    submitNumbers(fakePrisma, {
      userId: 'agent-1',
      values: Array(MAX_NUMBERS_PER_SUBMISSION + 1).fill('0244689575'),
      source: 'MANUAL'
    }),
    { status: 400 }
  );
});

test('builds safe admin filters and ignores unknown status values', () => {
  assert.deepEqual(buildSubmissionWhere({ status: 'VERIFIED', query: '0244' }), {
    status: 'VERIFIED',
    OR: [
      { phoneNumber: { contains: '0244', mode: 'insensitive' } },
      { submittedBy: { name: { contains: '0244', mode: 'insensitive' } } },
      { submittedBy: { email: { contains: '0244', mode: 'insensitive' } } },
      { submittedBy: { phone: { contains: '0244', mode: 'insensitive' } } }
    ]
  });
  assert.deepEqual(buildSubmissionWhere({ status: 'DELETE', query: '' }), {});
});
