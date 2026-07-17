const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeOrderNumber,
  orderRowsFromResponse,
  awbFromRow,
  orderNumberFromRow,
  collectRows,
} = require('./nimbuspost-awb-sync-background')._test;

test('reads NimbusPost shipment rows from the live response shape', () => {
  const payload = { status: true, count: 1, data: [{
    order_number: 'IC-20260716-51hzh',
    awb_number: '153768760446111',
    courier_name: 'DTDC Surface',
  }] };
  const rows = orderRowsFromResponse(payload);
  assert.equal(rows.length, 1);
  assert.equal(orderNumberFromRow(rows[0]), 'IC-20260716-51HZH');
  assert.equal(awbFromRow(rows[0]), '153768760446111');
});

test('collectRows builds an order-to-AWB map and ignores rows without AWBs', () => {
  const map = new Map();
  const added = collectRows({ data: [
    { order_number: ' IC-ONE ', awb_number: '111', courier_name: 'Delhivery' },
    { order_number: 'IC-TWO', status: 'new' },
  ] }, map);
  assert.equal(added, 1);
  assert.deepEqual(map.get(normalizeOrderNumber('ic-one')), { awb: '111', courier: 'Delhivery' });
  assert.equal(map.has('IC-TWO'), false);
});
