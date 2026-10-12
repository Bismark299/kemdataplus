const test = require('node:test');
const assert = require('node:assert/strict');
const { extractPayerMomoNumber, captureStorePayerMomo, PAYER_CAPTURE_START, refreshStorePayers } =
  require('../src/services/store-payer.service');

const payment = (authorization = {}) => ({
  status: 'success', channel: 'mobile_money', reference: 'verified-ref', authorization
});

test('uses the documented Paystack masked instrument number, not recipient/customer metadata', () => {
  assert.equal(extractPayerMomoNumber({
    ...payment({ bin: '055XXX', last4: 'X149' }),
    customer: { phone: '0240000000' }, metadata: { customerPhone: '0240000000' }
  }), '055****149');
});

test('supports explicit full instrument numbers and safely masks a last-four-only response', () => {
  assert.equal(extractPayerMomoNumber(payment({ mobile_money_number: '+233550000000' })), '0550000000');
  assert.equal(extractPayerMomoNumber(payment({ last4: '0123' })), '******0123');
});

test('does not identify a card number, unsuccessful payment, or customer phone as MoMo payer', () => {
  assert.equal(extractPayerMomoNumber({ ...payment({ last4: '1234' }), channel: 'card' }), null);
  assert.equal(extractPayerMomoNumber({ ...payment({ last4: '1234' }), status: 'failed' }), null);
  assert.equal(extractPayerMomoNumber({ ...payment(), customer: { phone: '0550000000' } }), null);
  assert.equal(extractPayerMomoNumber(payment({ last4: 'XXXX' })), null);
  assert.equal(extractPayerMomoNumber(payment({ mobile_money_number: '<script>' })), null);
});

function fakeDatabase(order) {
  const calls = [];
  return {
    calls,
    storefrontOrder: {
      async updateMany({ where, data }) {
        calls.push({ where, data });
        if (order.id !== where.id || order.paystackReference !== where.paystackReference ||
            order.createdAt < where.createdAt.gte) return { count: 0 };
        const replaceable = order.payerMomoNumber == null ||
          (where.OR.length > 1 && order.payerMomoNumber.includes('*'));
        if (!replaceable) return { count: 0 };
        Object.assign(order, data);
        return { count: 1 };
      }
    }
  };
}

test('capture begins at midnight today, excludes older orders, and matches the saved reference', async () => {
  for (const [createdAt, savedReference, expected] of [
    [new Date('2026-10-11T23:59:59.999Z'), 'verified-ref', 0],
    [new Date(PAYER_CAPTURE_START), 'verified-ref', 1],
    [new Date(PAYER_CAPTURE_START), 'other-ref', 0]
  ]) {
    const db = fakeDatabase({ id: 'order', createdAt, paystackReference: savedReference });
    const result = await captureStorePayerMomo(db, 'order', 'verified-ref', payment({ last4: '1234' }));
    assert.equal(result.count, expected);
  }
});

test('repeated or empty confirmations never erase payer evidence; a full number may upgrade a mask', async () => {
  const order = { id: 'order', createdAt: PAYER_CAPTURE_START, paystackReference: 'verified-ref' };
  const db = fakeDatabase(order);
  assert.equal((await captureStorePayerMomo(db, 'order', 'verified-ref', payment({ last4: '0000' }))).count, 1);
  assert.equal((await captureStorePayerMomo(db, 'order', 'verified-ref', payment())).count, 0);
  assert.equal((await captureStorePayerMomo(db, 'order', 'verified-ref', payment({ last4: '9999' }))).count, 0);
  assert.equal(order.payerMomoNumber, '******0000');
  assert.equal((await captureStorePayerMomo(db, 'order', 'verified-ref',
    payment({ mobile_money_number: '0550000000' }))).count, 1);
  assert.equal(order.payerMomoNumber, '0550000000');
  assert.equal((await captureStorePayerMomo(db, 'order', 'different-ref',
    payment({ mobile_money_number: '0551111111' }))).count, 0);
  assert.equal(order.payerMomoNumber, '0550000000');
});

test('owner refresh verifies only eligible paid orders, is bounded, and does not repeat missing-data checks', async () => {
  const orders = Array.from({ length: 7 }, (_, index) => ({
    id: `refresh-${index}`, createdAt: PAYER_CAPTURE_START, paymentStatus: 'PAID',
    paystackReference: `ref-${index}`, payerMomoNumber: null
  }));
  const skipped = [
    { ...orders[0], id: 'old', createdAt: new Date('2026-10-11T23:59:59Z') },
    { ...orders[0], id: 'unpaid', paymentStatus: 'PENDING' },
    { ...orders[0], id: 'known', payerMomoNumber: '055****149' }
  ];
  const refs = [];
  const db = { storefrontOrder: { updateMany: async () => { throw new Error('No number means no write'); } } };
  const verify = async ref => { refs.push(ref); return { status: 'success', channel: 'mobile_money', reference: ref }; };
  await refreshStorePayers(db, [...skipped, ...orders], verify);
  assert.equal(refs.length, 5);
  await refreshStorePayers(db, [...skipped, ...orders], verify);
  assert.equal(refs.length, 7);
  await refreshStorePayers(db, [...skipped, ...orders], verify);
  assert.equal(refs.length, 7);
});
