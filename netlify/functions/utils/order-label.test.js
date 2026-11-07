'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PDFDocument, PDFName } = require('pdf-lib');
const { _test: ep } = require('../admin-order-label');

const run = (x, y, t) => `BT ${x} ${y} Td (${[...t].map((c) => `\\000${c}`).join('')}) Tj ET\n`;
async function pdfWith(awbs) {
  const doc = await PDFDocument.create();
  for (const awb of awbs) {
    const page = doc.addPage([286.3, 436.5]);
    const ref = doc.context.register(doc.context.flateStream(run(10, 300, 'Order No: IC-X') + run(150, 260, awb)));
    page.node.set(PDFName.of('Contents'), ref);
  }
  return doc.save();
}
const deps = (bytes, { status = true, httpStatus = 200 } = {}) => ({
  login: async () => 'tok',
  ucpFetch: async () => ({ httpStatus, data: { status, data: 'https://xb-ucp-files-s3.xbees.in/labels/x.pdf', message: status ? '' : 'Invalid AWB' } }),
  fetch: async () => ({ ok: true, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) }),
});

test('returns the label when the page shows the AWB', async () => {
  const bytes = await pdfWith(['143449611592728']);
  const got = await ep.xpressBeesLabel('143449611592728', deps(bytes));
  assert.ok(got.pdf);
  assert.equal((await PDFDocument.load(got.pdf)).getPageCount(), 1);
});

test('refuses a label that shows a different AWB', async () => {
  const bytes = await pdfWith(['143449611500000']);
  const got = await ep.xpressBeesLabel('143449611592728', deps(bytes));
  assert.equal(got.pdf, undefined);
  assert.equal(got.notFound, true);
  assert.match(got.reason, /does not show AWB/);
});

test('keeps only the matching page of a multi-page PDF', async () => {
  const bytes = await pdfWith(['111111111', '143449611592728']);
  const got = await ep.xpressBeesLabel('143449611592728', deps(bytes));
  const doc = await PDFDocument.load(got.pdf);
  assert.equal(doc.getPageCount(), 1);
});

test('an XpressBees refusal is "not found", not a crash', async () => {
  const bytes = await pdfWith(['1']);
  const got = await ep.xpressBeesLabel('7D130601918', deps(bytes, { status: false }));
  assert.equal(got.notFound, true);
  assert.match(got.reason, /Invalid AWB/);
});

test('a refused login is a real error', async () => {
  const bytes = await pdfWith(['1']);
  await assert.rejects(ep.xpressBeesLabel('143449611592728', deps(bytes, { httpStatus: 401 })), /refused the API login/);
});

test('AWBs are cleaned before matching', () => {
  assert.equal(ep.cleanAwb(' 7d130601918 '), '7D130601918');
});

test('a shipped AWB label from shipment.xpressbees.com is accepted', async () => {
  const bytes = await pdfWith(['143449611592728']);
  const d = deps(bytes);
  d.ucpFetch = async () => ({ httpStatus: 200, data: { status: true, data: 'https://shipment.xpressbees.com/assets/x.pdf' } });
  assert.ok((await ep.xpressBeesLabel('143449611592728', d)).pdf);
  d.ucpFetch = async () => ({ httpStatus: 200, data: { status: true, data: 'https://evil.example.com/xpressbees.com/x.pdf' } });
  assert.equal((await ep.xpressBeesLabel('143449611592728', d)).notFound, true);
});

// ── NimbusPost Partner API ──────────────────────────────────────────────────
const npDeps = (bytes, rows) => ({
  v2Fetch: async (path, opts = {}) => {
    if (path.startsWith('/v2/orders')) return { httpStatus: 200, data: { success: true, data: rows, meta: { pagination: {} } } };
    assert.deepEqual(opts.body, { order_ids: ['ORD-9'] });
    return { httpStatus: 200, data: { success: true, data: { url: 'https://labels.nimbuspost.com/bulk/a.pdf' } } };
  },
  fetch: async () => ({ ok: true, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) }),
});

test('NimbusPost: AWB -> order id -> label, checked against the page', async () => {
  const bytes = await pdfWith(['7D130601918']);
  const got = await ep.nimbusPostLabel('7D130601918', npDeps(bytes, [{ order_id: 'ORD-9', shipment: { awb: '7D130601918' } }]));
  assert.ok(got.pdf);
});

test('NimbusPost: a list row with a different AWB is never used', async () => {
  const bytes = await pdfWith(['7D130601918']);
  const got = await ep.nimbusPostLabel('7D130601918', npDeps(bytes, [{ order_id: 'ORD-9', shipment: { awb: '7D999' } }]));
  assert.equal(got.notFound, true);
});

test('courier name picks which panel is asked first; both are asked', async () => {
  assert.deepEqual(ep.sourceOrder('Xpressbees'), ['xpressbees', 'nimbuspost']);
  assert.deepEqual(ep.sourceOrder('DTDC Surface'), ['nimbuspost', 'xpressbees']);
  const asked = [];
  const sources = {
    xpressbees: async () => { asked.push('xb'); return { notFound: true, reason: 'no' }; },
    nimbuspost: async () => { asked.push('np'); return { pdf: new Uint8Array([1]) }; },
  };
  const got = await ep.findLabel('1434X', 'Xpressbees', { sources });
  assert.deepEqual(asked, ['xb', 'np']);
  assert.equal(got.source, 'nimbuspost');
  const none = await ep.findLabel('1434X', 'Delhivery', { sources: { ...sources, nimbuspost: async () => ({ notFound: true, reason: 'nope' }) } });
  assert.equal(none.pdf, undefined);
  assert.equal(none.tried.length, 2);
});
