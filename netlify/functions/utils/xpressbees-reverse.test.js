const test = require('node:test');
const assert = require('node:assert/strict');
const { buildReversePayload, bookReverseForReturn, reverseOrderId } = require('./xpressbees-reverse');

const ret = {
  id: 'r1',
  order_display_id: 'IC-20260902-J8RS4',
  customer_name: 'Aditya Patil',
  customer_phone: '+91 90751 80041',
  amount_paise: 63000,
  items: [{ title: 'The Off-Campus Series Complete Collection', qty: 1, price: 630 }],
};
const addr = { addr1: '12 MG Road, Kothrud', city: 'Pune', state: 'Maharashtra', pincode: '411038' };

test('collects from the customer and returns to our warehouse', () => {
  const p = buildReversePayload(ret, addr, 'Books');
  assert.equal(p.order_id, 'R-20260902-J8RS4');
  assert.equal(p.request_auto_pickup, 'yes');
  assert.equal(p.consignee.name, 'Aditya Patil');
  assert.equal(p.consignee.pincode, '411038');
  assert.equal(p.consignee.phone, '9075180041');
  assert.equal(p.pickup.pincode, '110006');
  assert.ok(p.pickup.warehouse_name.length <= 20);
  assert.equal(p.categories, 'Books');
  assert.equal(p.product_amount, '630');
  assert.equal(p.qccheck, '0');
});

test('order id stays within XpressBees\' 20 characters', () => {
  assert.ok(reverseOrderId({ order_display_id: 'IC-R-CW-20260902-ABCDEFG' }).length <= 20);
});

test('moves on only past a category rejection', async () => {
  delete process.env.XPRESSBEES_REVERSE_CATEGORY;
  const seen = [];
  const bookReverse = async (p) => {
    seen.push(p.categories);
    if (p.categories === 'Books') throw new Error('XpressBees reverse booking failed: Categories is invalid');
    return { awb_number: '24344990100056' };
  };
  const r = await bookReverseForReturn(ret, addr, { bookReverse });
  assert.equal(r.shipment.awb_number, '24344990100056');
  assert.deepEqual(seen, ['Books', 'Books & Stationery']);
});

test('any other rejection stops at once — it may not have been harmless', async () => {
  let calls = 0;
  const bookReverse = async () => { calls += 1; throw new Error('XpressBees reverse booking failed: Pincode not serviceable'); };
  await assert.rejects(bookReverseForReturn(ret, addr, { bookReverse }), /not serviceable/);
  assert.equal(calls, 1);
});

test('a pinned category is the only one tried', async () => {
  process.env.XPRESSBEES_REVERSE_CATEGORY = 'Selection';
  const seen = [];
  await assert.rejects(bookReverseForReturn(ret, addr, { bookReverse: async (p) => { seen.push(p.categories); throw new Error('Categories is invalid'); } }), /XPRESSBEES_REVERSE_CATEGORY/);
  assert.deepEqual(seen, ['Selection']);
  delete process.env.XPRESSBEES_REVERSE_CATEGORY;
});
