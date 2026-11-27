const test = require('node:test');
const assert = require('node:assert/strict');
const wp = require('./warehouse-pick');
const ah = require('../admin-warehouse')._test;

const PEER = 'Peer e Kamil in Roman English ( Roman Urdu) by Umera Ahmad: From the writer of Dar e Nijat';
const AAB = 'Aab-E-Hayat Novel in Roman Urdu ( Roman English) by Umera Ahmad : From the writer of Dar e Nijat';

test('short and long names of one book match; editions do not', () => {
  assert.ok(wp.similarity('Peer e Kamil Roman English', PEER) >= wp.MATCH_AT);
  assert.ok(wp.similarity('The Power of Now', 'The Power of Now By Eckhart Tolle [Paperback] [2020] Eckhart Tolle') >= wp.MATCH_AT);
  assert.equal(wp.similarity('The Alchemist', '(Hindi) Alchemist'), 0);
  assert.ok(wp.similarity('Peer e Kamil Roman English', AAB) < wp.MATCH_AT);
  assert.ok(wp.similarity('Ikigai', 'Ikigai: The Japanese secret to a long and happy life') >= wp.MATCH_AT);
  assert.equal(wp.similarity('Urdu Aab-E-Hayat', AAB), 0);
  assert.ok(wp.similarity('Rich', 'Rich Dad Poor Dad by Robert Kiyosaki') < wp.MATCH_AT);
  assert.equal(wp.bestMatch('Psychology of Money', ['The Psychology of Money', 'The Psychology of Money Special Edition (Hindi) by Morgan Housel']).title, 'The Psychology of Money');
});

test('inventory adds, merges near names, sets and removes', () => {
  let { inventory } = wp.applyToInventory({}, [{ title: PEER, qty: 3 }]);
  ({ inventory } = wp.applyToInventory(inventory, [{ title: 'Peer e Kamil in Roman English (Roman Urdu) by Umera Ahmad', qty: 2 }]));
  assert.equal(Object.keys(inventory).length, 1);
  assert.equal(Object.values(inventory)[0].qty, 5);
  ({ inventory } = wp.applyToInventory(inventory, [{ title: PEER, qty: 1 }], { mode: 'set' }));
  assert.equal(Object.values(inventory)[0].qty, 1);
  ({ inventory } = wp.applyToInventory(inventory, [{ title: PEER, qty: 0 }], { mode: 'set' }));
  assert.equal(Object.keys(inventory).length, 0);
});

const row = (id, at, items, over = {}) => ({ order_id: id, created_at: at, bucket: 'awaiting_pickup', tracking_id: 'AWB' + id, courier: 'Delhivery', items: items.map(([title, qty]) => ({ title, qty })), ...over });

test('oldest orders take the shelf first; partly-there orders are flagged', () => {
  const { inventory } = wp.applyToInventory({}, [{ title: PEER, qty: 2 }, { title: AAB, qty: 1 }]);
  const rows = [
    row('C', '2026-11-25', [[PEER, 1]]),
    row('A', '2026-11-21', [[PEER, 1], [AAB, 1]]),
    row('B', '2026-11-22', [[PEER, 1], [AAB, 1]]),
    row('D', '2026-11-23', [[PEER, 1], ['Secrets of Divine Love', 1]]),
    row('E', '2026-11-20', [['Atomic Habits', 1]]),
    row('F', '2026-11-20', [[PEER, 1]], { courier: 'DTDC Surface' }),
    row('G', '2026-11-20', [[PEER, 1]], { bucket: 'not_booked', tracking_id: '' }),
  ];
  const r = wp.allocate(rows, inventory);
  assert.deepEqual(r.ready.map((o) => o.order_id), ['A', 'C']);
  assert.deepEqual(r.flagged.map((o) => o.order_id), ['B', 'D']);
  assert.equal(r.flagged[0].missing[0].reason, 'not enough copies');
  assert.equal(r.flagged[1].missing[0].title, 'Secrets of Divine Love');
  assert.equal(r.flagged[1].missing[0].reason, 'not in the warehouse');
  assert.equal(r.skipped.dtdc, 1);
  assert.deepEqual(r.not_booked.map((o) => o.order_id), ['G']);
  const peer = r.shelf.find((x) => x.title === PEER);
  assert.equal(peer.used, 2);
  const again = wp.allocate(rows, inventory, { extracted: { A: 'x' }, skipDtdc: false });
  assert.equal(again.skipped.extracted, 1);
  assert.ok(again.ready.some((o) => o.order_id === 'F'));
});

test('printing takes the books off the shelf', () => {
  const { inventory } = wp.applyToInventory({}, [{ title: PEER, qty: 2 }, { title: AAB, qty: 1 }]);
  const r = wp.allocate([row('A', '2026-11-21', [[PEER, 1], [AAB, 1]])], inventory);
  const d = wp.deduct(inventory, r.ready);
  assert.equal(Object.values(d.inventory).length, 1);
  assert.equal(Object.values(d.inventory)[0].qty, 1);
  assert.equal(d.taken.length, 2);
});

test('photo rows: exact known title from the model, else our own match', () => {
  const known = [PEER, AAB, '(Hindi) Alchemist'];
  const rows = ah.scanRows({ books: [
    { title: 'PEER-E-KAMIL', count: 4, known: PEER },
    { title: 'Aab-e-Hayat Roman Urdu', count: 2, known: null },
    { title: 'Alchemist', language: 'Hindi', count: 1, known: null },
    { title: 'unreadable', count: 1 },
  ] }, known);
  assert.equal(rows[0].match.title, PEER);
  assert.equal(rows[0].count, 4);
  assert.equal(rows[1].match.title, AAB);
  assert.equal(rows[2].match.title, '(Hindi) Alchemist');
  assert.ok(rows[3].unreadable);
  assert.equal(ah.scanRows({ books: [{ title: 'X', count: 1 }] }, known, { single: true, qty: 6 })[0].count, 6);
});

test('admin-warehouse: add, match, print, undo against a fake store', async () => {
  const kv = new Map();
  const store = {
    get: async (k) => (kv.has(k) ? JSON.parse(kv.get(k)) : null),
    setJSON: async (k, v) => { kv.set(k, JSON.stringify(v)); },
    delete: async (k) => { kv.delete(k); },
  };
  process.env.ADMIN_SECRET = process.env.ADMIN_SECRET || 'test-secret';
  const headers = { 'x-admin-key': process.env.ADMIN_SECRET };
  const rows = [row('A', '2026-11-21', [[PEER, 1], [AAB, 1]]), row('B', '2026-11-22', [[PEER, 1], ['Atomic Habits', 1]])];
  const deps = { store, waitingRows: async () => rows };
  const call = async (method, body, query) => JSON.parse((await ah.handle({ httpMethod: method, headers, body: body && JSON.stringify(body), queryStringParameters: query }, deps)).body);
  assert.equal((await call('POST', { action: 'add', items: [{ title: 'Peer e Kamil Roman English', qty: 2 }, { title: AAB, qty: 1 }] })).books, 3);
  let m = await call('GET', null, { action: 'match' });
  assert.deepEqual(m.ready.map((o) => o.order_id), ['A']);
  assert.deepEqual(m.flagged.map((o) => o.order_id), ['B']);
  const p = await call('POST', { action: 'printed', orders: m.ready });
  assert.equal(p.books_left, 1);
  m = await call('GET', null, { action: 'match' });
  assert.equal(m.ready.length, 0);
  assert.equal(m.skipped.extracted, 1);
  assert.equal((await call('POST', { action: 'undo' })).restored, 1);
  m = await call('GET', null, { action: 'match' });
  assert.deepEqual(m.ready.map((o) => o.order_id), ['A']);
  assert.equal((await call('POST', { action: 'clear' })).error, 'confirm:true required');
});
