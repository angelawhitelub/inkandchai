'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PDFDocument, PDFName } = require('pdf-lib');
const { buildSortedLabels, readPage, parseLabel, sortLabels, winAnsi, rangeText } = require('./label-sort');
const { _test: endpoint } = require('../admin-xpressbees-labels');

// ── a synthetic XpressBees label, drawn the way mPDF draws them ─────────────

const W = 286.3;
const H = 436.5;
/** mPDF text run: UTF-16BE in a literal string. */
const run = (x, y, t) => `BT ${x} ${y} Td (${[...t].map((c) => `\\000${c.replace(/[()\\]/g, (m) => `\\${m}`)}`).join('')}) Tj ET\n`;
const line = (x1, y1, x2, y2) => `${x1} ${y1} m ${x2} ${y2} l S\n`;

/**
 * items: [{ name: 'Title' | ['wrapped', 'title'], qty }]. The table's rows are
 * ruled, with SKU | Item Name | Qty. columns at x 10 | 100 | 250 | 276.
 */
function labelContent(awb, orderNo, items) {
  let c = '';
  // The frame along the page edge, which must not count as content.
  c += line(0, 0, W, 0) + line(0, 0, 0, H) + line(W, 0, W, H) + line(0, H, W, H) + line(0, 0, 1.5, 1.5);
  c += run(10, 400, 'To:') + run(10, 300, `Order No: ${orderNo}`) + run(150, 260, awb);
  const rowsY = [200, 188];   // header row
  let y = 188;
  for (const it of items) {
    const lines = Array.isArray(it.name) ? it.name : [it.name];
    const h = 10 * lines.length + 2;
    rowsY.push(y - h);
    lines.forEach((l, i) => { c += run(102, y - 9 - i * 10, l); });
    c += run(12, y - 9, 'N/A') + run(260, y - 9, String(it.qty));
    y -= h;
  }
  c += run(12, 191, 'SKU') + run(150, 191, 'Item Name') + run(255, 191, 'Qty.');
  for (const ry of rowsY) c += line(10, ry, 276, ry);
  for (const x of [10, 100, 250, 276]) c += line(x, 200, x, y);
  c += run(12, y - 20, 'For any query please connect with us:');
  return c;
}

async function labelPdf(labels) {
  const doc = await PDFDocument.create();
  for (const l of labels) {
    const page = doc.addPage([W, H]);
    const ref = doc.context.register(doc.context.flateStream(labelContent(l.awb, l.orderNo, l.items)));
    page.node.set(PDFName.of('Contents'), ref);
  }
  return doc.save();
}

const LABELS = [
  { awb: '1001', orderNo: 'IC-A', items: [{ name: 'Book X', qty: 1 }] },
  { awb: '1002', orderNo: 'IC-B', items: [{ name: 'Book Y', qty: 3 }] },
  { awb: '1003', orderNo: 'IC-C', items: [{ name: 'Book X', qty: 1 }, { name: ['The Long Wrapped', 'Title Z'], qty: 2 }] },
  { awb: '1004', orderNo: 'IC-D', items: [{ name: 'book x', qty: 2 }] },
];

// ── reading ─────────────────────────────────────────────────────────────────

test('reads order number and items from the ruled table, wrapped titles kept whole', async () => {
  const doc = await PDFDocument.load(await labelPdf([LABELS[2]]));
  const r = readPage(doc.getPages()[0]);
  assert.ok(r.texts.some((t) => t.t === '1003'));
  const p = parseLabel(r.texts, r.segs);
  assert.equal(p.orderNo, 'IC-C');
  assert.deepEqual(p.items, [{ title: 'Book X', qty: 1 }, { title: 'The Long Wrapped Title Z', qty: 2 }]);
  // The page frame is not content: the free band starts under the footer.
  assert.ok(r.contentBottom > 100 && r.contentBottom < 160, `contentBottom ${r.contentBottom}`);
});

test('no table grid means unread, not a guess', () => {
  const p = parseLabel([{ x: 255, y: 191, t: 'Qty.' }, { x: 260, y: 180, t: '2' }], []);
  assert.deepEqual(p.items, []);
  assert.match(p.unreadReason, /grid/);
});

// ── sorting ─────────────────────────────────────────────────────────────────

test('single-title groups by total books, biggest order first; mixed after; unread last', () => {
  const l = (awb, items) => ({ awb, items });
  const { ordered } = sortLabels([
    l('a', [{ title: 'Book X', qty: 1 }]),
    l('b', [{ title: 'Book Y', qty: 3 }]),
    l('c', [{ title: 'Book X', qty: 1 }, { title: 'Z', qty: 2 }]),
    l('d', [{ title: 'BOOK  x', qty: 2 }]),
    l('e', []),
    l('f', [{ title: 'Q', qty: 1 }, { title: 'R', qty: 1 }, { title: 'S', qty: 1 }, { title: 'T', qty: 1 }]),
  ]);
  // X and Y both total 3 books; X has more labels so it comes first.
  assert.deepEqual(ordered.map((x) => x.awb), ['d', 'a', 'b', 'f', 'c', 'e']);
  assert.deepEqual(ordered.map((x) => x.kind), ['single', 'single', 'single', 'mixed', 'mixed', 'unread']);
  assert.deepEqual(ordered.map((x) => x.n), [1, 2, 3, 4, 5, 6]);
});

test('same title twice in one order is one title, not a mixed order', () => {
  const { ordered } = sortLabels([{ awb: 'a', items: [{ title: 'Ikigai', qty: 1 }, { title: 'ikigai', qty: 1 }] }]);
  assert.equal(ordered[0].kind, 'single');
  assert.equal(ordered[0].units, 2);
});

test('helpers: WinAnsi-safe text and label ranges', () => {
  assert.equal(winAnsi('Ikigai — “Japanese” secret … ✓ हिंदी'), 'Ikigai - "Japanese" secret ...');
  assert.equal(rangeText([5, 1, 3, 2].map((n) => ({ n }))), '#1-3, #5');
});

// ── building ────────────────────────────────────────────────────────────────

const awbOn = (page) => readPage(page).texts.find((t) => /^100\d$/.test(t.t))?.t;

test('builds pick list, labels in packing order with stamps, blank page last', async () => {
  const bytes = await labelPdf(LABELS);
  const { pdf, summary } = await buildSortedLabels([{ bytes, awbs: LABELS.map((l) => l.awb) }], { date: new Date('2026-10-06T20:00:00Z') });
  assert.deepEqual({ ...summary, unread: summary.unread.length }, { labels: 4, units: 9, titles: 2, mixed: 1, unread: 0, unstamped: [] });

  const out = await PDFDocument.load(pdf);
  const pages = out.getPages();
  assert.equal(pages.length, 1 + 4 + 1);
  assert.deepEqual(pages.slice(1, 5).map(awbOn), ['1004', '1001', '1002', '1003']);
  // The source label survives untouched, and the stamp went on top of it.
  const p1 = await out.getPage(1);
  assert.ok(p1.node.Contents().asArray().length >= 2, 'stamp appended as its own content stream');
  assert.equal(readPage(pages[5]).texts.length, 0);
});

test('refuses to build when a page does not show the AWB it was requested for', async () => {
  const bytes = await labelPdf(LABELS.slice(0, 2));
  await assert.rejects(buildSortedLabels([{ bytes, awbs: ['1002', '1001'] }]), /does not show AWB 1002/);
});

test('refuses to build when XpressBees returns the wrong number of pages', async () => {
  const bytes = await labelPdf(LABELS.slice(0, 2));
  await assert.rejects(buildSortedLabels([{ bytes, awbs: ['1001', '1002', '1003'] }]), /2 label pages for 3 AWBs/);
});

// ── endpoint: XpressBees panel API ──────────────────────────────────────────

function fakeXb({ total = 230, rejectFirst = 0, rejectAlways = false } = {}) {
  const calls = [];
  let rejects = rejectFirst;
  const recs = Array.from({ length: total }, (_, i) => ({ awb_number: String(5000 + i), ship_status: i % 2 ? 'pending pickup' : 'awaiting scan' }));
  const ucpFetch = async (path, opts) => {
    calls.push({ path, opts });
    if (rejectAlways || rejects > 0) { rejects--; return { httpStatus: 401, data: { message: 'Unauthorized' }, raw: '' }; }
    if (path.startsWith('/shipment/list')) {
      const q = new URLSearchParams(path.split('?')[1]);
      const page = Number(q.get('page')); const limit = Number(q.get('limit'));
      return { httpStatus: 200, data: { data: { count: total, records: recs.slice((page - 1) * limit, page * limit) } } };
    }
    return { httpStatus: 200, data: { status: true, data: `https://xb-ucp-files-s3.xbees.in/labels/${calls.length}.pdf` } };
  };
  const logins = [];
  const login = async (o = {}) => { logins.push(!!o.force); return `tok${logins.length}`; };
  return { calls, ucpFetch, login, logins };
}

test('lists every Ready to Pickup shipment across pages, deduplicated', async () => {
  const xb = fakeXb({ total: 230 });
  const out = await endpoint.run({ days: 30, summaryOnly: true }, xb);
  assert.equal(out.awbs.length, 230);
  const lists = xb.calls.filter((c) => c.path.startsWith('/shipment/list'));
  assert.equal(lists.length, 3);
  const q = new URLSearchParams(lists[0].path.split('?')[1]);
  assert.equal(q.get('ship_status_in'), 'pending pickup,pickup reattempt,awaiting scan');
  assert.ok(Number(q.get('end_date')) - Number(q.get('start_date')) === 30 * 86400);
});

test('re-logs in once on a 401, and says plainly when the panel refuses the API login', async () => {
  const once = fakeXb({ total: 3, rejectFirst: 1 });
  const ok = await endpoint.run({ summaryOnly: true }, once);
  assert.equal(ok.awbs.length, 3);
  assert.deepEqual(once.logins, [false, true]);

  const never = fakeXb({ total: 3, rejectAlways: true });
  await assert.rejects(endpoint.run({ summaryOnly: true }, never), /refused the API login/);
});

test('asks for labels 50 AWBs at a time and refuses a label URL off the XpressBees domain', async () => {
  const xb = fakeXb({ total: 120 });
  const fetched = [];
  // Stop at the PDF download: the label fetches are what is under test here.
  const err = await endpoint.run({}, { ...xb, fetch: async (u) => { fetched.push(u); throw new Error('stop'); } }).catch((e) => e);
  assert.match(err.message, /stop/);
  const label = xb.calls.find((c) => c.path === '/ship/assets/label');
  assert.equal(label.opts.method, 'POST');
  assert.equal(label.opts.body.awbs.split(',').length, 50);
  assert.match(fetched[0], /^https:\/\/xb-ucp-files-s3\.xbees\.in\//);

  const evil = fakeXb({ total: 1 });
  const orig = evil.ucpFetch;
  evil.ucpFetch = async (p, o) => (p === '/ship/assets/label'
    ? { httpStatus: 200, data: { status: true, data: 'https://evil.example/x.pdf' } } : orig(p, o));
  await assert.rejects(endpoint.run({}, { ...evil, fetch: async () => assert.fail('must not fetch') }), /label download failed/);
});
