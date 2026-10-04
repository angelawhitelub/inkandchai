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
