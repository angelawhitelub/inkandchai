const test = require('node:test');
const assert = require('node:assert/strict');
const { PDFDocument } = require('pdf-lib');
const { buildNotPickedPdf, pdfSafe } = require('./not-picked-up-pdf');

const row = (i, over = {}) => ({
  id: 'u' + i, order_id: 'IC-20260917-' + String(i).padStart(5, '0'), status: 'shipped', bucket: 'awaiting_pickup',
  created_at: '2026-09-17T08:00:00Z', age_hours: 24 * (3 + (i % 15)) + i % 24, books: 'Atomic Habits, Deep Work ×2',
  courier: 'Delhivery', tracking_id: '21025863355' + i, last_scan: 'Manifested', payment: 'cod', amount_rs: 499,
  customer_name: 'Riya Sharma', customer_phone: '9876543210', pincode: '411001', replacement: null, ...over,
});

test('text is folded to what Helvetica can draw', () => {
  assert.equal(pdfSafe('₹499 — “Deep Work” ×2'), 'Rs 499 - "Deep Work" x2');
  assert.equal(pdfSafe('गोदान by Premchand'), '? by Premchand');
  assert.equal(pdfSafe('Café\nNoir'), 'Café Noir');
});

test('the PDF lists every order, oldest first, across pages, whatever the titles', async () => {
  const rows = Array.from({ length: 140 }, (_, i) => row(i));
  rows.push(row(900, { books: 'मधुशाला ' + 'very long title '.repeat(30), age_hours: 24 * 40 }));
  rows.push(row(901, { bucket: 'not_booked', status: 'cod_pending', tracking_id: '', courier: '', age_hours: 50 }));
  rows.push(row(902, { payment: 'replacement', amount_rs: 0,
    replacement: { original_order_id: 'IC-20260901-AAAAA', original_payment: 'cod', missing_book: true, reason: 'missing_item' } }));
  const out = await buildNotPickedPdf(rows, { minDays: 2, generatedAt: new Date('2026-10-05T04:30:00Z') });
  assert.equal(out.count, 143);
  assert.equal(out.oldestDays, 40);
  assert.equal(out.notBooked, 1);
  const doc = await PDFDocument.load(out.bytes);
  assert.ok(doc.getPageCount() > 3, 'paginates');
});

test('an empty list still makes a PDF', async () => {
  const out = await buildNotPickedPdf([], { minDays: 3 });
  assert.equal(out.count, 0);
  assert.equal((await PDFDocument.load(out.bytes)).getPageCount(), 1);
});

test('books in more than one copy head the PDF and the email, most copies first', async () => {
  const rows = [
    row(1, { items: [{ title: 'Deep Work', qty: 2 }, { title: 'Atomic Habits', qty: 1 }] }),
    row(2, { items: [{ title: 'atomic habits', qty: 1 }] }),
    row(3, { items: [{ title: 'Deep Work', qty: 1 }, { title: 'Ikigai', qty: 1 }] }),
    row(4, { items: [{ title: 'गोदान', qty: 2 }] }),
  ];
  const out = await buildNotPickedPdf(rows, { minDays: 2 });
  assert.deepEqual(out.repeated.map((b) => [b.qty, b.title.toLowerCase(), b.orders]), [[3, 'deep work', 2], [2, 'atomic habits', 2], [2, 'गोदान', 1]]);

  // A long repeated list pushes the orders table onto later pages instead of overlapping it.
  const many = Array.from({ length: 300 }, (_, i) => row(i, { items: [{ title: `Book ${i}`, qty: 2 }] }));
  const big = await buildNotPickedPdf(many, { minDays: 2 });
  assert.equal(big.repeated.length, 300);
  assert.ok((await PDFDocument.load(big.bytes)).getPageCount() > 2);

  const { _test: report } = require('../not-picked-up-report-scheduled');
  const html = report.emailHtml({ count: 4, minDays: 2, oldestDays: 3, notBooked: 0, when: 'now', repeated: [{ title: 'Deep <Work>', qty: 3, orders: 2 }] });
  assert.match(html, /Books in more than one copy \(1\)/);
  assert.match(html, /Deep &lt;Work&gt;/);
  assert.doesNotMatch(report.emailHtml({ count: 1, minDays: 2, oldestDays: 3, notBooked: 0, when: 'now', repeated: [] }), /more than one copy/);
});
