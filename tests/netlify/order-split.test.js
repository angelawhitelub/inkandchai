const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../../netlify/functions/utils/order-split');
const { isReplacementOrder } = require('../../netlify/functions/utils/replacement-order');
const { classifyShipmentMoney } = require('../../netlify/functions/utils/shipment-money');
const { quoteUnpickedCancel } = require('../../netlify/functions/utils/unpicked-cancel');
const { _test: T } = require('../../netlify/functions/admin-split-order');

const cart = () => ([
  { title: 'A', slug: 'a', price: 300, qty: 2, _payment: { balance: 540, full_total: 600 } },
  { title: 'B', url: '/product/B-Book?x=1', price: 200, qty: 1, _release: '2026-12-01' },
  { title: 'C', slug: 'c', price: 100, qty: 1 },
]);
const order = (over = {}) => ({ id: 'u1', razorpay_order_id: 'IC-20261108-WQTZM', status: 'paid', amount_paise: 70000, cart_items: cart(), ...over });

test('child ids stay within XpressBees 20 characters and stay readable', () => {
  assert.equal(S.childIdFor('IC-20261108-WQTZM', 2), 'IC-20261108-WQTZM-S2');
  assert.equal(S.childIdFor('IC-CW-20261108-WQTZM', 2), 'IC-20261108-WQTZM-S2');
  assert.ok(S.childIdFor('IC-20261108-WQTZM', 12).length <= 20);
  assert.match(S.childIdFor('IC-20261108-WQTZM', 12), /-S12$/);
});

test('who can be split', () => {
  assert.equal(S.splitRefusal(order()), '');
  assert.equal(S.splitRefusal(order({ status: 'cod_pending' })), '');
  assert.match(S.splitRefusal(order({ status: 'shipped' })), /cannot be split/, 'shipped without an AWB');
  assert.equal(S.splitRefusal(order({ status: 'shipped', tracking_id: '1434X' })), '');
  assert.match(S.splitRefusal(order({ status: 'shipped', tracking_id: '1434X', shipment_moved_at: 'x' })), /picked up/);
  assert.match(S.splitRefusal(order({ status: 'in_transit', tracking_id: '1434X' })), /cannot be split/);
  assert.match(S.splitRefusal(order({ cart_items: [{ title: 'A', qty: 1 }] })), /two or more/);
  assert.match(S.splitRefusal(order({ source: 'replacement' })), /Replacement/);
  assert.match(S.splitRefusal(order({ source: 'split', cart_items: [{ title: 'A', qty: 2, _split: { of: 'IC-X' } }] })), /already a split/);
});

test('planSplit moves quantities, keeps book flags, keeps order meta on the original', () => {
  const { parentCart, childCarts } = S.planSplit(order(), [[{ index: 0, qty: 2 }, { index: 1, qty: 1 }]]);
  assert.deepEqual(parentCart.map((l) => [l.title, l.qty]), [['C', 1]]);
  assert.deepEqual(parentCart[0]._payment, { balance: 540, full_total: 600 }, 'partial-COD balance rides on the new first line');
  assert.deepEqual(childCarts[0].map((l) => [l.title, l.qty]), [['A', 2], ['B', 1]]);
  assert.equal(childCarts[0][0]._payment, undefined, 'no payment meta on a child');
  assert.equal(childCarts[0][1]._release, '2026-12-01', 'pre-order flag travels with the book');

  const two = S.planSplit(order(), [[{ index: 0, qty: 1 }], [{ index: 2, qty: 1 }]]);
  assert.deepEqual(two.parentCart.map((l) => [l.title, l.qty]), [['A', 1], ['B', 1]]);
  assert.equal(two.childCarts.length, 2);
});

test('planSplit refuses bad selections', () => {
  assert.throws(() => S.planSplit(order(), []), /at least one/);
  assert.throws(() => S.planSplit(order(), [[{ index: 0, qty: 3 }]]), /only 2/);
  assert.throws(() => S.planSplit(order(), [[{ index: 0, qty: 2 }], [{ index: 0, qty: 1 }]]), /only 2/);
  assert.throws(() => S.planSplit(order(), [[{ index: 9, qty: 1 }]]), /not in this order/);
  assert.throws(() => S.planSplit(order(), [[{ index: 0, qty: 0 }]]), /no books/);
  assert.throws(() => S.planSplit(order(), [[{ index: 0, qty: 2 }, { index: 1, qty: 1 }, { index: 2, qty: 1 }]]), /must stay/);
});

test('a split child ships prepaid with a declared value and collects nothing', () => {
  const child = { razorpay_order_id: 'IC-20261108-WQTZM-S2', status: 'confirmed', amount_paise: 0, source: 'split',
    cart_items: [{ title: 'A', price: 300, qty: 2, _split: { of: 'IC-20261108-WQTZM' } }] };
  assert.equal(isReplacementOrder(child), true);
  assert.equal(isReplacementOrder({ ...child, source: null }), true, 'the _split.of marker alone is enough');
  const m = classifyShipmentMoney(child, isReplacementOrder(child));
  assert.equal(m.isCOD, false);
  assert.equal(m.collectableAmount, 0);
  assert.equal(m.orderValueRs, 600);
  // The original is not a replacement: it keeps its children list only.
  assert.equal(isReplacementOrder({ ...order(), cart_items: [{ title: 'C', _split: { children: ['X'] } }] }), false);
});

test('stock hand-over: children take what they carry, the original keeps the rest', () => {
  const moves = [{ slug: '*', qty: 0 }, { slug: 'a', qty: 2 }, { slug: 'b-book', qty: 1 }, { slug: 'c', qty: 1, returned_at: 'x' }];
  const { childCarts } = S.planSplit(order(), [[{ index: 0, qty: 1 }, { index: 1, qty: 1 }]]);
  const r = S.splitStockMoves(moves, childCarts);
  assert.deepEqual(r.children[0], [{ slug: 'a', qty: 1 }, { slug: 'b-book', qty: 1 }]);
  assert.deepEqual(r.parent.sort((x, y) => x.slug.localeCompare(y.slug)), [{ slug: 'a', qty: 1 }, { slug: 'b-book', qty: 0 }]);
  // A book that was not counted (no row) moves no stock.
  const none = S.splitStockMoves([{ slug: '*', qty: 0 }], childCarts);
  assert.deepEqual(none.children[0], []);
});

test('split orders are never self-cancelled', () => {
  const parent = order({ cart_items: [{ title: 'C', qty: 1, _split: { children: ['IC-20261108-WQTZM-S2'] } }] });
  assert.match(S.splitCancelBlock(parent), /separate parcels/);
  assert.match(S.splitCancelBlock({ source: 'split', cart_items: [{ _split: { of: 'IC-1' } }] }), /part of order IC-1/);
  assert.equal(S.splitCancelBlock(order()), '');
  const old = { ...parent, razorpay_payment_id: 'pay_1', status: 'paid', created_at: new Date(Date.now() - 9 * 86400e3).toISOString() };
  assert.equal(quoteUnpickedCancel(old).reason, 'split');
});

test('customer notice: COD original still collects, new parcels do not', async () => {
  const sent = { email: null, wa: null };
  const deps = {
    sendEmail: async (m) => { sent.email = m; },
    whatsapp: { sendWhatsApp: async () => ({ ok: true }), sendText: async (to, text) => { sent.wa = text; return { ok: true }; } },
    template: '',
  };
  const parent = { razorpay_order_id: 'IC-20261108-WQTZM', status: 'cod_pending', amount_paise: 50000, customer_name: 'Asha K', customer_email: 'a@x', customer_phone: '9999999999' };
  const r = await T.notifyCustomer(parent, [{ title: 'C', qty: 1 }], [{ id: 'IC-20261108-WQTZM-S2', cart: [{ title: 'A', qty: 2 }] }], deps);
  assert.ok(r.email.ok && r.whatsapp.ok);
  assert.match(sent.wa, /pay ₹500 with the parcel for IC-20261108-WQTZM/);
  assert.match(sent.wa, /IC-20261108-WQTZM-S2: A ×2/);
  assert.match(sent.email.html, /2 parcels/);
  assert.match(sent.email.html, /Pay ₹500/);
});

test('routing: XpressBees serves -> queue; does not -> NimbusPost push; unknown -> owner', async () => {
  const child = { razorpay_order_id: 'IC-1-S2' };
  let pushed = null;
  const push = async (b) => { pushed = b; return { statusCode: 200, body: JSON.stringify({ summary: { pushed: 1 } }) }; };
  let r = await T.routeChild({}, child, { serviceability: async () => ({ serviceable: true, pincode: '110001' }), nimbusPush: push });
  assert.equal(r.courier, 'xpressbees'); assert.equal(pushed, null);
  r = await T.routeChild({}, child, { serviceability: async () => ({ serviceable: false, pincode: '480106' }), nimbusPush: push });
  assert.equal(r.courier, 'nimbuspost'); assert.equal(r.done, true);
  assert.deepEqual(pushed, { order_ids: ['IC-1-S2'], xb_unserviceable: true });
  r = await T.routeChild({}, child, { serviceability: async () => ({ serviceable: false, pincode: '480106' }), nimbusPush: async () => ({ statusCode: 200, body: JSON.stringify({ summary: { pushed: 0, errors: ['IC-1-S2: bad phone'] } }) }) });
  assert.equal(r.done, false); assert.match(r.note, /bad phone/);
  r = await T.routeChild({}, child, { serviceability: async () => ({ serviceable: null, reason: 'timeout' }) });
  assert.equal(r.courier, null); assert.match(r.note, /timeout/);
});
