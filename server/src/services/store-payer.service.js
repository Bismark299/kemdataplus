// Ghana and UTC share this calendar-day boundary. Do not backfill earlier orders.
const PAYER_CAPTURE_START = new Date('2026-10-12T00:00:00Z');

function normalizePayerNumber(value) {
  if (typeof value !== 'string') return null;
  const number = value.trim().replace(/[\s-]/g, '').replace(/[xX]/g, '*');
  if (/^0\d{9}$/.test(number)) return number;
  if (/^\+?233\d{9}$/.test(number)) return `0${number.replace(/^\+?233/, '')}`;
  if (/^[\d*]{10}$/.test(number) && number.includes('*') && /\d/.test(number)) return number;
  return null;
}

// Read payment-instrument fields only; customer.phone/metadata are not proof of payer.
function extractPayerMomoNumber(payment) {
  if (payment?.status !== 'success' || payment.channel !== 'mobile_money') return null;
  const authorization = payment.authorization || {};
  const explicit = normalizePayerNumber(authorization.mobile_money_number);
  if (explicit) return explicit;
  const alreadyExtracted = normalizePayerNumber(payment.payerMomoNumber);
  if (alreadyExtracted) return alreadyExtracted;
  const bin = typeof authorization.bin === 'string' ? authorization.bin : '';
  const last4 = typeof authorization.last4 === 'string' ? authorization.last4 : '';
  if (!/^[\d*xX]{4}$/.test(last4) || !/\d/.test(last4)) return null;
  const prefix = /^[\d*xX]{6}$/.test(bin) ? bin : '******';
  return normalizePayerNumber(`${prefix}${last4}`);
}

async function captureStorePayerMomo(db, orderId, reference, payment) {
  const number = extractPayerMomoNumber(payment);
  if (!number || payment.reference !== reference) return { count: 0 };
  // A duplicate callback cannot erase a value. A verified full number may replace a mask.
  const replaceable = [{ payerMomoNumber: null }];
  if (!number.includes('*')) replaceable.push({ payerMomoNumber: { contains: '*' } });
  return db.storefrontOrder.updateMany({
    where: {
      id: orderId,
      createdAt: { gte: PAYER_CAPTURE_START },
      paystackReference: reference,
      OR: replaceable
    },
    data: { payerMomoNumber: number }
  });
}

// Enrich already-paid eligible orders on owner-view refresh, without touching
// fulfillment. Missing provider data is retried at most once per ten minutes.
const payerRefreshAttempts = new Map();
async function refreshStorePayers(db, orders, verifyPayment, log = console) {
  const now = Date.now();
  for (const [id, attemptedAt] of payerRefreshAttempts) {
    if (now - attemptedAt >= 10 * 60 * 1000) payerRefreshAttempts.delete(id);
  }
  const candidates = orders.filter(order =>
    new Date(order.createdAt) >= PAYER_CAPTURE_START &&
    order.paymentStatus === 'PAID' && order.paystackReference &&
    !order.payerMomoNumber && !payerRefreshAttempts.has(order.id)
  ).slice(0, 5);
  for (const order of candidates) payerRefreshAttempts.set(order.id, now);
  await Promise.all(candidates.map(async order => {
    try {
      const verified = await verifyPayment(order.paystackReference);
      await captureStorePayerMomo(db, order.id, order.paystackReference, verified);
    } catch {
      log.warn('[StorePayer] Payer details unavailable from payment verification; no fulfillment changes made');
    }
  }));
}

module.exports = { PAYER_CAPTURE_START, extractPayerMomoNumber, captureStorePayerMomo, refreshStorePayers };
