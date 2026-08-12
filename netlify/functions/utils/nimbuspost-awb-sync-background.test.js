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
  assert.deepEqual(map.get('IC-20260812-FT7ER'), {
    awb: '40441745275542', courier: 'Xpressbees',
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
