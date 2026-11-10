const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const C = require('./copyright-report');
const { handle } = require('../copyright-report');

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 1, 2, 3, 4]).toString('base64');
const good = (extra) => ({
  name: 'Asha Rao', email: 'Rights@Publisher.example', phone: '+91 98765 43210', organisation: 'Example Books',
  role: 'owner', product_url: 'https://inkandchai.in/product/some-book-123/', work: 'Some Book by A. Author, ISBN 9780000000000, we own it.',
  original_url: 'https://publisher.example/some-book', details: 'The cover image and the description are copied from our edition.',
  good_faith: true, accurate: true, signature: 'Asha Rao', images: [{ name: 'proof.jpg', data: 'data:image/jpeg;base64,' + JPEG }], ...extra,
});

function fakeDeps({ insertError = null, mailOk = true, count = 0 } = {}) {
  const calls = { inserts: [], mails: [], puts: [] };
  const q = { select: () => q, eq: () => q, gte: () => Promise.resolve({ count, error: null }) };
  return {
    calls,
    deps: {
      db: { from: () => ({ ...q, insert: async (row) => { calls.inserts.push(row); return { error: insertError }; } }) },
      sendEmail: async (m) => { calls.mails.push(m); return { ok: mailOk }; },
      ownerEmail: 'owner-private@example.test',
      putImage: async (key) => { calls.puts.push(key); },
      now: () => new Date('2026-11-10T12:00:00Z'),
    },
  };
}
const post = (body, deps, headers = {}) => handle({ httpMethod: 'POST', headers, body: JSON.stringify(body) }, deps)
  .then((r) => ({ status: r.statusCode, body: JSON.parse(r.body) }));

test('parseReport: required fields, our product links only, images checked', () => {
  assert.equal(C.parseReport(good()).ok, true);
  assert.equal(C.parseReport(good({ email: 'nope' })).field, 'email');
  assert.equal(C.parseReport(good({ product_url: 'https://other.example/product/x/' })).field, 'product_url');
  assert.equal(C.parseReport(good({ role: 'fan' })).field, 'role');
  assert.equal(C.parseReport(good({ good_faith: false })).field, 'good_faith');
  assert.equal(C.parseReport(good({ images: [{ data: Buffer.from('hello').toString('base64') }] })).field, 'images');
  assert.equal(C.parseReport(good({ images: [1, 2, 3, 4].map(() => ({ data: JPEG })) })).field, 'images');
  assert.equal(C.productSlug('/product/abc-1/'), 'abc-1');
});

test('a report is saved, emailed to the owner with images, and the reporter gets a receipt — the owner address never leaves the server', async () => {
  const { deps, calls } = fakeDeps();
  const r = await post(good(), deps);
  assert.equal(r.status, 200);
  assert.match(r.body.ref, /^CR-20261110-[A-Z2-9]{5}$/);
  assert.ok(!JSON.stringify(r.body).includes('owner-private'));
  assert.equal(calls.inserts[0].product_slug, 'some-book-123');
  assert.equal(calls.inserts[0].reporter_email, 'rights@publisher.example');
  assert.deepEqual(calls.puts, [`copyright/${r.body.ref}/1.jpg`]);
  const [owner, receipt] = calls.mails;
  assert.equal(owner.to, 'owner-private@example.test');
  assert.equal(owner.attachments.length, 1);
  assert.match(owner.html, /The cover image and the description/);
  assert.equal(receipt.to, 'rights@publisher.example');
  assert.ok(!receipt.html.includes('owner-private'));
  assert.match(receipt.html, /removing the product page/);
});

test('table missing → still emailed (marked not saved); nothing works → asked to retry', async () => {
  const a = fakeDeps({ insertError: { message: 'relation "copyright_reports" does not exist' } });
  const r = await post(good(), a.deps);
  assert.equal(r.status, 200);
  assert.match(a.calls.mails[0].html, /Not saved in Supabase/);
  const b = fakeDeps({ insertError: { message: 'down' }, mailOk: false });
  assert.equal((await post(good(), b.deps)).status, 503);
});

test('honeypot gets a fake success; foreign origins and too many reports are refused', async () => {
  const a = fakeDeps();
  const hp = await post(good({ website: 'spam.example' }), a.deps);
  assert.equal(hp.body.ok, true);
  assert.equal(a.calls.inserts.length + a.calls.mails.length, 0);
  assert.equal((await post(good(), fakeDeps().deps, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await post(good(), fakeDeps({ count: 5 }).deps, { 'cf-connecting-ip': '1.2.3.4' })).status, 429);
});

test('every product page gets the copyright note, and the page exists', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../../../worker/index.js'), 'utf8');
  const fn = src.slice(src.indexOf('function withQtySelector'), src.indexOf('async function withScarcity'));
  assert.match(fn, /\.on\('div\.details'/);
  assert.match(src, /report a copyright issue<\/a>/);
  const page = fs.readFileSync(path.resolve(__dirname, '../../../public/copyright/index.html'), 'utf8');
  assert.match(page, /copyright-report/);
  assert.ok(!/@gmail|kucha|9625836117/i.test(page));
});
