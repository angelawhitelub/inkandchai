const test = require('node:test');
const assert = require('node:assert/strict');
const so = require('./screenshot-order');

const RAW = {
  chat_phone: '+91 863 961 1970', customer_name: 'shameera', phones: ['8639611970', '8328467295'],
  address: '9-29 nallachecheruvu sri Sathya Sai district andra pradesh', pincode: '515551',
  books: [{ title: 'Peer-e-Kamil (Urdu)', qty: 1 }], payment_mode: 'cod', paid_already: false, quoted_total_rs: 319, notes: '',
};

test('the chat number comes first, the second number is kept as an alternate, nothing doubled', () => {
  const f = so.normaliseExtraction(RAW);
  assert.equal(f.phone, '8639611970');
  assert.deepEqual(f.alt_phones, ['8328467295']);
  assert.equal(f.pincode, '515551');
  assert.equal(f.payment_mode, 'cod');
  assert.equal(f.quoted_total_rs, 319);
  assert.equal(so.fullAddress(f), '9-29 nallachecheruvu sri Sathya Sai district andra pradesh, 515551 (Alt phone: 8328467295)');
});

test('books become the request list; a comma inside a title cannot split it', () => {
  assert.equal(so.booksString([{ title: 'Ikigai', qty: 2 }, { title: 'Sapiens, A Brief History', qty: 1 }]), 'Ikigai ×2, Sapiens A Brief History');
});

test('junk from the model is dropped, not trusted', () => {
  const f = so.normaliseExtraction({ phones: ['12345', 'abc'], books: [{ title: 'x' }, null], payment_mode: 'upi', quoted_total_rs: 'free' });
  assert.equal(f.phone, '');
  assert.deepEqual(f.books, []);
  assert.equal(f.payment_mode, '');
  assert.equal(f.quoted_total_rs, null);
});

test('an order is created only with everything a courier needs, and prepaid only when paid', () => {
  const ok = { customer_name: 'Shameera', phone: '8639611970', address: '9-29 Nallacheruvu, Sri Sathya Sai', pincode: '515551', books: [{ title: 'Peer-e-Kamil', qty: 1 }], payment_mode: 'cod', amount_rupees: 319 };
  assert.deepEqual(so.validateForCreate(ok), []);
  assert.ok(so.validateForCreate({ ...ok, pincode: '', address: 'somewhere far away' }).some((p) => /pincode/.test(p)));
  assert.ok(so.validateForCreate({ ...ok, payment_mode: 'prepaid' }).some((p) => /Paid already/.test(p)));
  assert.deepEqual(so.validateForCreate({ ...ok, payment_mode: 'prepaid', paid_already: true }), []);
});

test('read: the endpoint reads, prices and lists existing orders, and writes nothing', async () => {
  const { _test: { handle } } = require('../admin-screenshot-order');
  const writes = [];
  const q = (data) => { const c = { select: () => c, in: () => c, or: () => c, gte: () => c, order: () => c, eq: () => c, ilike: () => c, limit: () => Promise.resolve({ data, error: null }), then: (ok) => ok({ data, error: null }) }; return c; };
  const db = { from: () => ({ ...q([]), insert: (r) => { writes.push(r); return q([]); }, update: (r) => { writes.push(r); return q([]); } }) };
  const res = await handle({ httpMethod: 'POST', body: JSON.stringify({ action: 'read', images: ['data:image/png;base64,AAAA'] }) },
    { skipAuth: true, db, read: async () => RAW });
  const out = JSON.parse(res.body);
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(out.fields.phone, '8639611970');
  assert.ok(out.existing);
  assert.equal(writes.length, 0);
});

test('read refuses anything that is not an image', async () => {
  const { _test: { handle } } = require('../admin-screenshot-order');
  const res = await handle({ httpMethod: 'POST', body: JSON.stringify({ action: 'read', images: ['https://evil.example/x.png'] }) }, { skipAuth: true, db: {}, read: async () => RAW });
  assert.equal(res.statusCode, 400);
});
