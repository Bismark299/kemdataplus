const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const payer = require('../src/services/store-payer.service');

function loadService(name, dependencies, extra = {}) {
  const filename = path.join(__dirname, `../src/services/${name}.service.js`);
  const sandbox = {
    module: { exports: {} }, __dirname: path.dirname(filename),
    process: { env: { PAYSTACK_SECRET_KEY: 'test-only-key' } },
    console: { log() {}, warn() {}, error() {} },
    require(id) {
      if (Object.hasOwn(dependencies, id)) return dependencies[id];
      if (id === './store-payer.service') return payer;
      if (['crypto', 'fs', 'path'].includes(id)) return require(id);
      throw new Error(`Unexpected dependency: ${id}`);
    },
    ...extra
  };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), sandbox, { filename });
  return sandbox.module.exports;
}

const transaction = {
  status: 'success', channel: 'mobile_money', reference: 'payment-ref',
  amount: 500, authorization: { bin: '055XXX', last4: 'X149' },
  metadata: { type: 'storefront_order', storefrontOrderId: 'store-order' }
};

test('verified checkout exposes only extracted payer evidence, not raw authorization', async () => {
  const service = loadService('paystack', { '../lib/prisma': {} }, {
    fetch: async () => ({ ok: true, json: async () => ({ status: true, data: transaction }) })
  });
  const verified = await service.verifyPayment('payment-ref');
  assert.equal(verified.payerMomoNumber, '055****149');
  assert.equal(verified.channel, 'mobile_money');
  assert.equal(verified.reference, 'payment-ref');
  assert.equal(verified.authorization, undefined);
  assert.equal(verified.success, true);
});

test('repeated successful webhook forwards payment evidence even when payment was already recorded', async () => {
  const completions = [];
  const service = loadService('paystack', {
    '../lib/prisma': { storefrontOrder: { findUnique: async () => ({ paymentStatus: 'PAID' }) } },
    './storefront.service': {
      completePaystackOrder: async (...args) => { completions.push(args); return { orderId: 'main-order' }; }
    }
  });
  const result = await service.processWebhook({ event: 'charge.success', data: transaction });
  assert.equal(result.processed, true);
  assert.equal(completions.length, 1);
  assert.equal(completions[0][0], 'store-order');
  assert.equal(completions[0][1], 'payment-ref');
  assert.equal(completions[0][2], transaction);
});

test('already-fulfilled checkout captures payer without creating or sending a second order', async () => {
  const writes = [];
  const db = {
    storefrontOrder: {
      findUnique: async () => ({ id: 'store-order', orderId: 'existing-order' }),
      updateMany: async args => { writes.push(args); return { count: 1 }; }
    }
  };
  db.$transaction = async work => work(db);
  const service = loadService('storefront', { '../lib/prisma': db, './order-group.service': {} });
  const result = await service.completePaystackOrder('store-order', 'payment-ref', transaction);
  assert.equal(result.alreadyCompleted, true);
  assert.equal(result.orderId, 'existing-order');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].data.payerMomoNumber, '055****149');
  assert.deepEqual(Object.keys(writes[0].data), ['payerMomoNumber']);
});

test('owner-order authorization runs before reading or refreshing any payer details', async () => {
  let queried = false;
  const service = loadService('storefront', {
    '../lib/prisma': {
      storefront: { findFirst: async () => null },
      storefrontOrder: { findMany: async () => { queried = true; return []; } }
    }
  });
  await assert.rejects(service.getStoreOrders('other-store', 'agent'), /not authorized/);
  assert.equal(queried, false);
});

test('public customer tracking does not return payer evidence', async () => {
  const service = loadService('storefront', {
    '../lib/prisma': {
      storefrontOrder: { findMany: async () => [{
        id: 'store-order', payerMomoNumber: '055****149', customerPhone: '0240000000',
        paymentPhone: '0240000000', amount: 5, status: 'COMPLETED',
        bundle: { name: 'MTN 1GB', network: 'MTN', dataAmount: '1GB' },
        order: { status: 'COMPLETED' }, createdAt: new Date('2026-10-12T01:00:00Z')
      }] }
    }
  });
  const orders = await service.getCustomerOrders('store', '0240000000');
  assert.equal(orders.length, 1);
  assert.equal(orders[0].payerMomoNumber, undefined);
  assert.equal(orders[0].phone, '0240000000');
});

test('desktop/mobile payer rendering excludes old orders, distinguishes recipient, and escapes values', () => {
  const html = fs.readFileSync(path.join(__dirname, '../../client/pages/mystore.html'), 'utf8');
  const start = html.indexOf('function escapeOrderHtml(');
  const end = html.indexOf('function renderOrders(', start);
  const render = vm.runInNewContext(`${html.slice(start, end)}; renderOrderPayerDetails`);
  assert.equal(render({ createdAt: '2026-10-11T23:59:59Z' }), '');
  const content = render({
    createdAt: '2026-10-12T00:00:00Z', paymentPhone: '0240000000', payerMomoNumber: '055****149'
  });
  assert.match(content, /Data recipient:/);
  assert.match(content, /0240000000/);
  assert.match(content, /MoMo payer \(masked\)/);
  assert.match(content, /055\*\*\*\*149/);
  assert.match(render({ createdAt: '2026-10-12T00:00:00Z' }), /Not provided/);
  assert.doesNotMatch(render({
    createdAt: '2026-10-12T00:00:00Z', payerMomoNumber: '<script>'
  }), /<script>/);
  assert.equal((html.match(/renderOrderPayerDetails\(o\)/g) || []).length, 2);
});
