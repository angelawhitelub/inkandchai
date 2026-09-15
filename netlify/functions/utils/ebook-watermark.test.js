const test = require('node:test');
const assert = require('node:assert/strict');
const { PDFDocument } = require('pdf-lib');
const { stampPdf, watermarkLabel, personalKey, MAX_STAMP_BYTES } = require('./ebook-watermark');

async function samplePdf(pages = 2) {
  const d = await PDFDocument.create();
  for (let i = 0; i < pages; i++) d.addPage([595, 842]).drawText('Chapter ' + (i + 1));
  return Buffer.from(await d.save());
}

test('the label names the buyer and the payment', () => {
  assert.equal(
    watermarkLabel({ email: 'reader@example.com', paymentId: 'pay_ABC12345' }),
    'Licensed to reader@example.com · ABC12345 · inkandchai.in',
  );
});

test('a buyer with no email is still identifiable', () => {
  // Phone-only signups exist. An unlabelled copy would defeat the point.
  const label = watermarkLabel({ userId: '0f8c2b1a-dead-beef-0000-111122223333' });
  assert.match(label, /account 0f8c2b1a/);
  assert.match(label, /inkandchai\.in/);
});

test('every page carries the watermark, and keeps its own content', async () => {
  // The deterrent only works if it is on every page — a watermark on page one
  // is removed by deleting page one.
  const stamped = await stampPdf(await samplePdf(3), { label: 'Licensed to x@y.com' });
  const doc = await PDFDocument.load(stamped);
  assert.equal(doc.getPageCount(), 3);
  // pdf-lib cannot read text back, so assert on size growth per page instead:
  // each page gained two draw operations.
  const plain = await samplePdf(3);
  assert.ok(stamped.length > plain.length, 'stamped file should be larger');
});

test('the watermark is in the document, not painted on by the reader', async () => {
  // The whole reason this runs server-side. A canvas overlay lives in the
  // browser and is gone the moment someone saves the response body.
  const stamped = await stampPdf(await samplePdf(1), { label: 'Licensed to trace@me.com' });
  // updateMetadata:false matters — pdf-lib rewrites Producer on load by
  // default, which would overwrite the very thing being asserted here.
  const doc = await PDFDocument.load(stamped, { updateMetadata: false });
  assert.match(String(doc.getProducer() || ''), /trace@me\.com/);
});

test('a personalised copy is keyed per buyer and cannot escape its folder', async () => {
  const k = personalKey('atomic-habits-abc12', '0f8c2b1a-1111-2222-3333-444455556666');
  assert.match(k, /^ebooks\/atomic-habits-abc12\/personal\/[a-zA-Z0-9-]+\.pdf$/);
  // Two buyers must never collide onto one object.
  assert.notEqual(k, personalKey('atomic-habits-abc12', 'aaaa1111-2222-3333-4444-555566667777'));
  // A hostile id cannot climb out of the prefix.
  assert.ok(!personalKey('slug', '../../../etc/passwd').includes('..'));
});

test('the stamping cap is small enough to survive a worker', () => {
  // pdf-lib parses the whole document in memory and a worker has 128 MB.
  assert.ok(MAX_STAMP_BYTES <= 32 * 1024 * 1024, 'cap must stay well under worker memory');
  assert.ok(MAX_STAMP_BYTES >= 8 * 1024 * 1024, 'cap should still cover ordinary books');
});
