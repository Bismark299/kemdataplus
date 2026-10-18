const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MAX_NUMBERS_PER_SUBMISSION,
  normalizePhoneNumber,
  normalizePhoneNumbers,
  submitNumbers,
  buildSubmissionWhere,
  markPendingAsSubmitted,
  MAX_PENDING_COPY_ROWS
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
      async findMany() { return []; },
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
  assert.equal(result.alreadyHandledCount, 0);
  assert.equal(result.duplicateCount, 1);
  assert.equal(result.invalidCount, 0);
  assert.ok(result.batchId);
  assert.deepEqual(inserted.map(row => row.phoneNumber), ['0244689575', '0555546229']);
  assert.ok(inserted.every(row => row.status === 'PENDING' && row.source === 'EXCEL' && row.submittedById === 'agent-1'));
  assert.equal(inserted[0].batchId, inserted[1].batchId);
});

test('resubmitted numbers already sent or verified stay out of the pending queue', async () => {
  let inserted;
  const fakePrisma = {
    numberVerificationSubmission: {
      async findMany() {
        return [
          { phoneNumber: '0244689575', status: 'SUBMITTED' },
          { phoneNumber: '0555546229', status: 'VERIFIED' }
        ];
      },
      async createMany({ data }) {
        inserted = data;
        return { count: data.length };
      }
    }
  };
  const result = await submitNumbers(fakePrisma, {
    userId: 'agent-2',
    values: ['0244689575', '0555546229', '0201234567'],
    source: 'MANUAL'
  });

  assert.equal(result.alreadyHandledCount, 2);
  assert.deepEqual(inserted.map(row => row.status), ['SUBMITTED', 'VERIFIED', 'PENDING']);
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
  assert.equal(buildSubmissionWhere({ status: 'SUBMITTED', query: '' }).status, 'SUBMITTED');
  assert.deepEqual(buildSubmissionWhere({ status: 'DELETE', query: '' }), {});
});

test('copying pending entries marks them Submitted once and returns unique phone numbers', async () => {
  let queryValues;
  let update;
  const rows = [
    { id: 'one', phoneNumber: '0244689575' },
    { id: 'two', phoneNumber: '0244689575' },
    { id: 'three', phoneNumber: '0555546229' }
  ];
  const fakePrisma = {
    async $transaction(callback) {
      return callback({
        async $queryRaw(strings, ...values) {
          queryValues = { sql: strings.join('?'), values };
          return rows;
        },
        numberVerificationSubmission: {
          async updateMany(args) {
            update = args;
            return { count: args.where.id.in.length };
          }
        }
      });
    }
  };

  const result = await markPendingAsSubmitted(fakePrisma, { query: 'agent 1' });
  assert.deepEqual(result, {
    numbers: ['0244689575', '0555546229'],
    markedCount: 3
  });
  assert.deepEqual(update.where.id.in, ['one', 'two', 'three']);
  assert.equal(update.where.status, 'PENDING');
  assert.equal(update.data.status, 'SUBMITTED');
  assert.ok(queryValues.sql.includes('FOR UPDATE OF s'));
  assert.ok(queryValues.values.includes('agent 1'));
  assert.ok(queryValues.values.includes(MAX_PENDING_COPY_ROWS + 1));
});

test('does not mark pending entries when the copy set exceeds the safe limit', async () => {
  let updateCalled = false;
  const fakePrisma = {
    async $transaction(callback) {
      return callback({
        async $queryRaw() {
          return Array.from({ length: MAX_PENDING_COPY_ROWS + 1 }, (_, index) => ({
            id: `id-${index}`,
            phoneNumber: '0244689575'
          }));
        },
        numberVerificationSubmission: {
          async updateMany() { updateCalled = true; return { count: 0 }; }
        }
      });
    }
  };
  await assert.rejects(
    markPendingAsSubmitted(fakePrisma),
    { status: 413 }
  );
  assert.equal(updateCalled, false);
});
