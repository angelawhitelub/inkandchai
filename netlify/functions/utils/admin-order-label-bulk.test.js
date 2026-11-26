const test = require('node:test');
const assert = require('node:assert');
const { _test: L } = require('../admin-order-label');

test('bulk: refuses an empty or oversized selection', async () => {
  const none = await L.handleBulk({ httpMethod: 'POST', body: JSON.stringify({ orders: [{ awb: '' }, { awb: 'bad awb!' }] }) });
  assert.equal(none.statusCode, 400);
  const many = Array.from({ length: 201 }, (_, i) => ({ awb: 'AWB' + (100000 + i) }));
  const big = await L.handleBulk({ httpMethod: 'POST', body: JSON.stringify({ orders: many }) });
  assert.equal(big.statusCode, 400);
  assert.match(JSON.parse(big.body).error, /At most 200/);
});

test('bulk: AWBs no courier has come back as missing, never as a PDF', async () => {
  const xbFail = { fetch: async () => { throw new Error('offline'); } };
  const got = await L.bulkLabels([{ awb: 'DTDC123456', order: 'IC-1', courier: 'DTDC' }], { ...xbFail, nimbuspost: {}, v2Fetch: null });
  assert.equal(got.pdf, undefined);
  assert.equal(got.missing.length, 1);
  assert.equal(got.missing[0].awb, 'DTDC123456');
});

test('shownAwbs: an unreadable file shows nothing', async () => {
  const seen = await L.shownAwbs(new Uint8Array([1, 2, 3]), ['143449611831971']);
  assert.equal(seen.size, 0);
});
