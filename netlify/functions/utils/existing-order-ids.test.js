const test = require('node:test');
const assert = require('node:assert/strict');
const { existingOrderIds } = require('./existing-order-ids');

const fakeDb = (have, calls, fail = false) => ({
  from: () => ({ select: () => ({ in: async (_col, ids) => {
    calls.push(ids.length);
    return fail ? { data: null, error: { message: 'down' } } : { data: ids.filter(id => have.has(id)).map(id => ({ razorpay_order_id: id })), error: null };
  } }) }),
});

test('looks up hundreds of orders in a few queries, not one each', async () => {
  const ids = Array.from({ length: 450 }, (_, i) => `IC-${i}`);
  const calls = [];
  const r = await existingOrderIds(fakeDb(new Set(['IC-1', 'IC-449']), calls), [...ids, 'IC-1', null]);
  assert.deepEqual(calls, [200, 200, 50]);
  assert.deepEqual([...r.ids].sort(), ['IC-1', 'IC-449']);
});

test('an unreadable database is an error, never "all missing"', async () => {
  const r = await existingOrderIds(fakeDb(new Set(), [], true), ['IC-1']);
  assert.equal(r.error, 'down');
  assert.equal(r.ids, undefined);
});
