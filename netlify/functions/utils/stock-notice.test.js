const test = require('node:test');
const assert = require('node:assert');
const sn = require('./stock-notice');
const { quoteUnpickedCancel } = require('./unpicked-cancel');
const { classify } = require('./not-picked-up');
const { _test: E } = require('../admin-stock-notice');

const NOW = Date.parse('2026-11-25T10:00:00Z');
const daysAgo = (d) => new Date(NOW - d * 86400e3).toISOString();
const BOOK = { slug: 'peer-e-kamil', title: 'Peer-e-Kamil' };
const cart = (extra = []) => JSON.stringify([{ title: 'Peer-e-Kamil', slug: 'peer-e-kamil', qty: 1, price: 399 }, ...extra]);

const prepaid = (over = {}) => ({
  id: 'u1', razorpay_order_id: 'IC-20261120-AAAAA', status: 'paid', created_at: daysAgo(3),
  amount_paise: 39900, razorpay_payment_id: 'pay_x', customer_name: 'Riya Sharma', customer_phone: '919800000001',
  customer_email: 'riya@example.com', cart_items: cart(), tracking_id: '', ...over,
});
const codBooked = (over = {}) => ({
  id: 'u2', razorpay_order_id: 'IC-20261118-BBBBB', status: 'shipped', created_at: daysAgo(5),
  amount_paise: 39900, razorpay_payment_id: '', customer_name: 'Aman', customer_phone: '919800000002',
  customer_email: '', cart_items: cart(), tracking_id: '1434000001', courier_name: 'XpressBees', ...over,
});

test('arrival date reads as a weekday and a date; past dates refused', () => {
  assert.equal(sn.etaWords('2026-12-01'), 'Tuesday, 1 December 2026');
  assert.equal(sn.etaWords('2026-02-30'), null);
  assert.equal(sn.etaOk('2026-11-25', NOW), true);
  assert.equal(sn.etaOk('2026-11-24', NOW), false);
});

test('the book is found by slug, else by its exact title, in JSON-text carts', () => {
  assert.ok(sn.bookLine(prepaid(), BOOK));
  assert.ok(sn.bookLine(prepaid({ cart_items: [{ title: 'Peer e Kamil' }] }), { title: 'Peer-e-Kamil' }));
  assert.equal(sn.bookLine(prepaid({ cart_items: [{ title: 'Peer-e-Kamil Part 2', slug: 'pek-2' }] }), BOOK), null);
});

test('a told order may be cancelled at once: young prepaid, and booked COD with nothing to refund', () => {
  assert.equal(quoteUnpickedCancel(prepaid(), NOW).reason, 'too_soon', 'untold: the 7-day rule still holds');
  const q = quoteUnpickedCancel(prepaid(), NOW, { stockNotice: true });
  assert.equal(q.eligible, true); assert.equal(q.refundPaise, 39900); assert.equal(q.stockNotice, true);
  assert.equal(quoteUnpickedCancel(codBooked(), NOW).eligible, false);
  const c = quoteUnpickedCancel(codBooked(), NOW, { stockNotice: true });
  assert.equal(c.eligible, true); assert.equal(c.refundPaise, 0);
  assert.equal(quoteUnpickedCancel(codBooked({ shipment_moved_at: daysAgo(1) }), NOW, { stockNotice: true }).eligible, false, 'picked up: never');
  assert.equal(quoteUnpickedCancel(prepaid({ cancellation_requested_at: daysAgo(1) }), NOW, { stockNotice: true }).eligible, false);
});

test('cancelRoute: unbooked COD uses My Orders\' own COD cancel; replacements are left out', () => {
  const cod = prepaid({ status: 'cod_pending', razorpay_payment_id: '' });
  assert.deepEqual(sn.cancelRoute(cod, classify(cod, NOW, 0), NOW), { ok: true, how: 'cod', refundPaise: 0 });
  assert.equal(sn.cancelRoute(prepaid(), classify(prepaid(), NOW, 0), NOW).how, 'unpicked');
  assert.equal(sn.cancelRoute(prepaid(), null, NOW).ok, false);
});

test('the message says days late, the arrival day and date, and how cancelling refunds', () => {
  const m = sn.messageFor(prepaid(), { title: 'Peer-e-Kamil', eta: '2026-12-01', refundPaise: 39900, now: NOW });
  assert.match(m.text, /^Hi Riya, about your Ink & Chai order IC-20261120-AAAAA: we are aware that your order has not been picked up yet, 3 days after/);
  assert.match(m.text, /actively arranging the stock from the publisher\. We deeply apologise/);
  assert.match(m.text, /Tuesday, 1 December 2026/);
  assert.match(m.text, /cancel it anytime from the My Orders section .*refund of ₹399 will be issued automatically/);
  assert.deepEqual(m.params, ['Riya', 'IC-20261120-AAAAA', '3', 'Peer-e-Kamil', 'Tuesday, 1 December 2026']);
  const c = sn.messageFor(codBooked(), { title: 'Peer-e-Kamil', eta: '2026-12-01', refundPaise: 0, now: NOW });
  assert.match(c.text, /Cash on Delivery, there is nothing to pay or refund/);
});

function fakeDb(rows) {
  return { from: () => ({ select: () => ({ in: async (_c, ids) => ({ data: rows.filter((r) => ids.includes(r.id)), error: null }) }) }) };
}
function deps(rows, extra = {}) {
  const mem = { v: null };
  return {
    db: fakeDb(rows),
    listNotPicked: async () => ({ orders: rows, rows: rows.map((o) => classify(o, NOW, 0)).filter(Boolean) }),
    checkPickups: async (os) => new Map(os.map((o) => [o.id, { state: 'waiting' }])),
    store: { get: async () => mem.v, setJSON: async (_k, v) => { mem.v = v; } },
    mem,
    ...extra,
  };
}

test('plan: only orders with the book, courier-confirmed waiting, oldest first; same date not told twice', async () => {
  const other = prepaid({ id: 'u3', razorpay_order_id: 'IC-X-CCCCC', cart_items: JSON.stringify([{ title: 'Ikigai', slug: 'ikigai' }]) });
  const moving = codBooked({ id: 'u4', razorpay_order_id: 'IC-X-DDDDD' });
  const d = deps([prepaid(), codBooked(), other, moving], {
    checkPickups: async (os) => new Map(os.map((o) => [o.id, { state: o.id === 'u4' ? 'picked_up' : 'waiting' }])),
  });
  const p = await E.plan({ book: BOOK, eta: '2026-12-01', now: NOW }, d);
  assert.deepEqual(p.due.map((x) => x.msg.id), ['IC-20261118-BBBBB', 'IC-20261120-AAAAA']);
  assert.deepEqual(p.left, [{ id: 'IC-X-DDDDD', reason: 'courier says picked_up' }]);

  d.ledger = { 'IC-20261120-AAAAA': { at: new Date(NOW).toISOString(), eta: '2026-12-01' } };
  const again = await E.plan({ book: BOOK, eta: '2026-12-01', now: NOW }, d);
  assert.deepEqual(again.due.map((x) => x.msg.id), ['IC-20261118-BBBBB']);
  const newDate = await E.plan({ book: BOOK, eta: '2026-12-05', now: NOW }, d);
  assert.equal(newDate.due.length, 2, 'a new arrival date may be told again');
});

test('deliver: template first, plain text if refused; email when there is an address', async () => {
  const sent = [];
  const it = { order: prepaid(), msg: sn.messageFor(prepaid(), { title: 'Peer-e-Kamil', eta: '2026-12-01', refundPaise: 39900, now: NOW }) };
  const r = await E.deliver(it, {
    sendEmail: async (m) => { sent.push(['email', m.to]); return { ok: true }; },
    sendWhatsApp: async (m) => { sent.push(['tpl', m.template, m.params.length]); return { ok: false }; },
    sendText: async (to) => { sent.push(['text', to]); return { ok: true }; },
  });
  assert.equal(r.ok, true);
  assert.deepEqual(sent, [['email', 'riya@example.com'], ['tpl', 'order_stock_eta', 5], ['text', '919800000001']]);
});
