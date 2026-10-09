const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadService(requests) {
  const filename = path.join(__dirname, '../src/services/datahub.service.js');
  const sandbox = {
    module: { exports: {} },
    __dirname: path.dirname(filename),
    process: { env: {} },
    console: { log() {}, warn() {}, error() {} },
    setTimeout,
    require(id) {
      if (id === 'axios') {
        return async request => {
          requests.push(request);
          return { status: 200, data: { message: 'Order created successfully', data: { status: 'pending' } } };
        };
      }
      if (id === 'fs') {
        return { readFileSync: () => JSON.stringify({ adminSettings: { mcbisApiToken: 'test-only-token' } }) };
      }
      if (id === '../lib/prisma') return {};
      if (id === '../controllers/settings.controller') return { getAdminSettings: () => ({}) };
      if (id === '../lib/mcbis-status-queue') {
        return { createStatusQueue: () => ({ run: (_reference, run) => run() }) };
      }
      if (['path', 'http', 'https'].includes(id)) return require(id);
      throw new Error(`Unexpected test dependency: ${id}`);
    }
  };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), sandbox, { filename });
  return sandbox.module.exports;
}

for (const network of ['MTN', 'mtn']) {
  test(`MCBIS placement sends uppercase MTN for input ${network}`, async () => {
    const requests = [];
    const service = loadService(requests);
    const result = await service.placeOrder({
      network, phone: '0500000000', amount: 1, orderId: 'mock-order'
    });
    assert.equal(result.success, true);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].method.toUpperCase(), 'POST');
    assert.ok(requests[0].url.endsWith('/placeOrder'));
    assert.equal(requests[0].data.network, 'MTN');
    assert.equal(requests[0].data.receiver, '0500000000');
    assert.equal(requests[0].data.amount, 1);
    assert.equal(requests[0].data.reference, result.reference);
  });
}
