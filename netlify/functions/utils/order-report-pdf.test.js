const test = require('node:test');
const assert = require('node:assert/strict');
const { PDFDocument } = require('pdf-lib');
const R = require('./order-report-pdf');
const { handle } = require('../admin-order-report-pdf');

const ORDERS = [
  { id: 'IC-1', date: '10 Nov', customer: 'A', pay: 'COD', items: [{ title: 'Belonging', slug: 'belonging', qty: 1 }, { title: 'Ikigai', slug: 'ikigai', qty: 1 }] },
  { id: 'IC-2', date: '10 Nov', customer: 'B', pay: 'Prepaid', items: [{ title: 'Belonging', slug: 'belonging', qty: 3 }] },
  { id: 'IC-3', date: '11 Nov', customer: 'C', pay: 'COD', items: [{ title: 'गुनाहों का देवता', slug: 'gunahon-ka-devta', qty: 2 }, { title: 'Ikigai', qty: 1 }] },
];

test('books are summed per title, most copies first, with order counts', () => {
  const a = R.aggregate(R.normalise(ORDERS));
  assert.deepEqual(a.books.map((b) => [b.slug || b.title, b.qty, b.orders]), [['belonging', 4, 2], ['gunahon-ka-devta', 2, 1], ['ikigai', 1, 1], ['Ikigai', 1, 1]]);
  assert.equal(a.units, 8);
  assert.deepEqual(a.orders.map((o) => [o.id, o.qty]), [['IC-2', 3], ['IC-3', 3], ['IC-1', 2]]);
});

test('non-Latin titles fall back to the romanised slug', () => {
  assert.equal(R.displayTitle('गुनाहों का देवता', 'gunahon-ka-devta'), 'Gunahon Ka Devta *');
  assert.equal(R.displayTitle('Ikigai', 'ikigai'), 'Ikigai');
});

test('endpoint returns a real PDF and refuses an empty list', async () => {
  const r = await handle({ httpMethod: 'POST', body: JSON.stringify({ title: 'Unshipped orders report', orders: ORDERS }) }, { skipAuth: true, now: () => new Date('2026-11-11T07:00:00Z') });
  assert.equal(r.statusCode, 200);
  const body = JSON.parse(r.body);
  assert.equal(body.filename, 'inkandchai-unshipped-orders-report-2026-11-11.pdf');
  const doc = await PDFDocument.load(Buffer.from(body.pdf, 'base64'));
  assert.ok(doc.getPageCount() >= 1);
  assert.equal(body.summary.units, 8);
  const empty = await handle({ httpMethod: 'POST', body: JSON.stringify({ orders: [] }) }, { skipAuth: true });
  assert.equal(empty.statusCode, 400);
  const anon = await handle({ httpMethod: 'POST', headers: {}, body: JSON.stringify({ orders: ORDERS }) });
  assert.ok([401, 503].includes(anon.statusCode));
});
