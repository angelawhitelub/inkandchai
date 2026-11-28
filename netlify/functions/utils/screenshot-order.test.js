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

// ── duplicate screenshots (28 Nov 2026) ──
const SHA_A = 'a'.repeat(64), SHA_B = 'b'.repeat(64);
const DH = '0f'.repeat(32);                       // 128 one-bits: detailed
const DH_NEAR = 'ff' + '0f'.repeat(31);           // 4 bits away
const DH_FAR = 'f0'.repeat(32);                   // every bit different

test('hamming counts differing bits, and refuses mismatched lengths', () => {
  assert.equal(so.hamming(DH, DH), 0);
  assert.equal(so.hamming(DH, DH_NEAR), 4);
  assert.equal(so.hamming(DH, DH_FAR), 256);
  assert.equal(so.hamming(DH, 'ab'), Infinity);
});

test('a used screenshot is found again: same file exactly, or a near copy', () => {
  const store = so.rememberUsed({}, [{ sha: SHA_A, dhash: DH }], 'IAC-1', Date.parse('2026-11-20T10:00:00Z'));
  const used = so.findUsed(store, [
    { id: 's1', sha: SHA_A, dhash: DH_FAR },        // same bytes
    { id: 's2', sha: SHA_B, dhash: DH_NEAR },       // re-saved / re-compressed copy
    { id: 's3', sha: SHA_B, dhash: DH_FAR },        // a different chat
  ]);
  assert.deepEqual(used.s1, { order_id: 'IAC-1', at: '2026-11-20T10:00:00.000Z', exact: true });
  assert.equal(used.s2.exact, false);
  assert.equal(used.s2.order_id, 'IAC-1');
  assert.equal(used.s3, undefined);
});

test('near-blank pictures are never matched by look, only by exact file', () => {
  const blank = '0'.repeat(64), almost = '01' + '0'.repeat(62);
  const store = so.rememberUsed({}, [{ sha: SHA_A, dhash: blank }], 'IAC-2');
  assert.deepEqual(so.findUsed(store, [{ id: 'x', sha: SHA_B, dhash: almost }]), {});
  assert.equal(so.detailed(blank), false);
  assert.equal(so.detailed(DH), true);
});

test('remembered screenshots fall off after 90 days; junk hashes are not stored', () => {
  const old = so.rememberUsed({}, [{ sha: SHA_A, dhash: DH }], 'OLD', Date.parse('2026-07-01T00:00:00Z'));
  const next = so.rememberUsed(old, [{ sha: SHA_B, dhash: DH }, { sha: 'nope', dhash: DH }], 'NEW', Date.parse('2026-11-28T00:00:00Z'));
  assert.deepEqual(Object.keys(next), [SHA_B]);
});

test('seen: reads the remembered list and writes nothing', async () => {
  const { _test: { handle } } = require('../admin-screenshot-order');
  const store = so.rememberUsed({}, [{ sha: SHA_A, dhash: DH }], 'IAC-9');
  let writes = 0;
  const kv = { get: async () => ({ hashes: store }), setJSON: async () => { writes += 1; } };
  const res = await handle({ httpMethod: 'POST', body: JSON.stringify({ action: 'seen', prints: [{ id: 'p1', sha: SHA_A }, { id: 'p2', sha: SHA_B, dhash: DH_FAR }] }) },
    { skipAuth: true, db: {}, kv });
  assert.equal(res.statusCode, 200);
  const used = JSON.parse(res.body).used;
  assert.equal(used.p1.order_id, 'IAC-9');
  assert.equal(used.p2, undefined);
  assert.equal(writes, 0);
});

test('seen: an empty or broken store means nothing was used', async () => {
  const { _test: { handle } } = require('../admin-screenshot-order');
  const kv = { get: async () => { throw new Error('down'); } };
  const res = await handle({ httpMethod: 'POST', body: JSON.stringify({ action: 'seen', prints: [{ id: 'p1', sha: SHA_A }] }) }, { skipAuth: true, db: {}, kv });
  assert.deepEqual(JSON.parse(res.body).used, {});
});
