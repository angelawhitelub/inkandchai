const test = require('node:test');
const assert = require('node:assert/strict');
const {
  paginationFromResponse, awbFromRow, orderNumberFromRow,
  collectRows, buildListUrl, fetchNimbusAwbMap,
} = require('../nimbuspost-awb-sync-background')._test;

test('reads the live NimbusPost shipment response shape', () => {
  const row = {
    order_number: 'IC-20260812-FT7ER',
    awb_number: '40441745275542',
    courier_name: 'Xpressbees',
    status: 'pending pickup',
  };
  assert.equal(orderNumberFromRow(row), 'IC-20260812-FT7ER');
  assert.equal(awbFromRow(row), '40441745275542');
  const map = new Map();
  assert.equal(collectRows({ status: true, count: 1430, data: [row] }, map), 1);
  // seq and created were added so a re-shipped order's NEWEST shipment wins
  // and a stale re-ship can skip the customer notification.
  assert.deepEqual(map.get('IC-20260812-FT7ER'), {
    awb: '40441745275542', courier: 'Xpressbees', seq: 0, created: '',
  });
});

test('derives every shipment page from count', () => {
  assert.deepEqual(paginationFromResponse({ count: 1430, data: [] }), {
    current: 0, last: 8,
  });
});

test('shipment requests use NimbusPost maximum accepted batch', () => {
  const url = buildListUrl({ url: 'https://ship.nimbuspost.com/api/shipments', params: {} }, 7);
  assert.equal(url.searchParams.get('page'), '7');
  assert.equal(url.searchParams.get('limit'), '200');
  assert.equal(url.searchParams.get('per_page'), '200');
});

test('AWB discovery prefers shipments and reads every reported page', async () => {
  const originalFetch = global.fetch;
  const requested = [];
  global.fetch = async (input) => {
    const url = new URL(input);
    requested.push(`${url.pathname}?page=${url.searchParams.get('page')}`);
    const page = Number(url.searchParams.get('page'));
    const rows = Array.from({ length: page < 3 ? 200 : 50 }, (_, index) => ({
      order_number: `IC-P${page}-${index}`,
      awb_number: `${page}${String(index).padStart(3, '0')}`,
    }));
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ count: 450, data: rows }),
    };
  };

  try {
    const result = await fetchNimbusAwbMap('test-key');
    assert.equal(result.map.size, 450);
    assert.deepEqual(requested, [
      '/api/shipments?page=1', '/api/shipments?page=2', '/api/shipments?page=3',
    ]);
  } finally {
    global.fetch = originalFetch;
  }
});

test('a re-push suffix maps back to the order, and a code that merely starts with C does not', () => {
  // Pushed as "<id>-c" after its panel draft was cancelled (nimbuspost-order-push suffix mode).
  assert.equal(orderNumberFromRow({ order_number: 'IC-20260925-10SZ9-c' }), 'IC-20260925-10SZ9');
  assert.equal(orderNumberFromRow({ order_number: 'IC-CW-20260925-N2LSO-C2' }), 'IC-CW-20260925-N2LSO');
  assert.equal(orderNumberFromRow({ order_number: 'IC-R-20260925-2U7MB-c' }), 'IC-R-20260925-2U7MB');
  // The 5-character code itself may be C + digits. That is not a suffix.
  assert.equal(orderNumberFromRow({ order_number: 'IC-20260924-C1234' }), 'IC-20260924-C1234');
  assert.equal(orderNumberFromRow({ order_number: 'IC-20260924-C9QN0' }), 'IC-20260924-C9QN0');

  const map = new Map();
  collectRows({ data: [{ order_number: 'IC-20260925-10SZ9-c', awb_number: '1234567890', id: 9 }] }, map);
  assert.equal(map.get('IC-20260925-10SZ9').awb, '1234567890');
});
