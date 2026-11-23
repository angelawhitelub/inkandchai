'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const PL = require('./pay-later');
const { classifyShipmentMoney } = require('./shipment-money');
const { sendPayLaterLink, markPayLaterPaid, syncLink } = require('./pay-later-link');

const cfg = { enabled: true, items: [{ slug: 'peer-e-kamil' }, { slug: 'aab-e-hayat' }] };
const plOrder = (o = {}) => ({
  id: 'o1', razorpay_order_id: 'IC-20261123-ABCDE', razorpay_payment_id: null, amount_paise: 56900,
  status: 'delivered', customer_name: 'Asha K', customer_phone: '9800000000', customer_email: 'a@example.com',
  cart_items: [{ slug: 'peer-e-kamil', title: 'Peer e Kamil', qty: 1, price: 529, _payment: { mode: 'pay_later', state: 'approved' } }],
  ...o,
});

function fakeDb(rows) {
  const updates = [];
  return {
    updates,
    from() {
      const q = { filters: [], patch: null };
      const api = {
        update(p) { q.patch = p; return api; },
        eq(k, v) { q.filters.push((r) => r[k] === v); return api; },
        is(k, v) { q.filters.push((r) => (v === null ? r[k] == null : r[k] === v)); return api; },
        select() { return api; },
        then(res, rej) {
          const hits = rows.filter((r) => q.filters.every((f) => f(r)));
          if (q.patch) { updates.push(q.patch); hits.forEach((r) => Object.assign(r, q.patch)); }
          return Promise.resolve({ data: hits.map((r) => ({ id: r.id })), error: null }).then(res, rej);
        },
      };
      return api;
    },
  };
}

test('only a cart made entirely of Pay Later titles qualifies', () => {
  assert.equal(PL.cartCoverage([{ slug: 'peer-e-kamil' }, { slug: 'aab-e-hayat' }], cfg), 'all');
  assert.equal(PL.cartCoverage([{ slug: 'peer-e-kamil' }, { slug: 'verity' }], cfg), 'some');
  assert.equal(PL.cartCoverage([{ slug: 'verity' }], cfg), 'none');
  assert.equal(PL.cartCoverage([], cfg), 'none');
});

test('KYC checks: name, PAN, matching account numbers, IFSC and consent', () => {
  const good = PL.cleanKyc({ pan_name: 'Asha Khan', pan: 'abcde1234f', account: '1234 5678 9012', account_confirm: '123456789012', ifsc: 'sbin0001234', consent: true });
  assert.equal(PL.kycProblem(good), null);
  assert.equal(good.pan, 'ABCDE1234F');
  assert.match(PL.kycProblem({ ...good, pan: 'ABC123' }), /PAN number/);
  assert.match(PL.kycProblem({ ...good, account_confirm: '123' }), /do not match/);
  assert.match(PL.kycProblem({ ...good, ifsc: 'SBIN1234' }), /IFSC/);
  assert.match(PL.kycProblem({ ...good, consent: false }), /consent/);
  assert.match(PL.kycProblem({ ...good, pan_name: '' }), /name exactly/);
});

test('the PAN photo must really be an image of sensible size', () => {
  const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(5000, 1)]);
  assert.equal(PL.decodeImage({ type: 'image/jpeg', data: jpg.toString('base64') }).ok, true);
  assert.equal(PL.decodeImage({ type: 'image/png', data: jpg.toString('base64') }).ok, false);
  assert.equal(PL.decodeImage({ type: 'application/pdf', data: jpg.toString('base64') }).ok, false);
  assert.equal(PL.decodeImage({ type: 'image/jpeg', data: 'abcd' }).ok, false);
});

test('a Pay Later parcel is booked prepaid: the courier collects nothing', () => {
  for (const status of ['confirmed', 'shipped']) {
    const m = classifyShipmentMoney(plOrder({ status }), false);
    assert.equal(m.isCOD, false);
    assert.equal(m.collectableAmount, 0);
    assert.equal(m.shipmentPaymentType, 'prepaid');
    assert.equal(m.orderValueRs, 569);
  }
  // An ordinary unpaid order is still COD.
  const cod = plOrder({ status: 'cod_pending', cart_items: [{ slug: 'x', title: 'X' }] });
  assert.equal(classifyShipmentMoney(cod, false).isCOD, true);
});

test('unpaid until a payment id or a manual mark', () => {
  assert.equal(PL.isUnpaidPayLater(plOrder()), true);
  assert.equal(PL.isUnpaidPayLater(plOrder({ razorpay_payment_id: 'pay_1' })), false);
  assert.equal(PL.isUnpaidPayLater(plOrder({ cart_items: [{ _payment: { mode: 'pay_later', state: 'paid_manual' } }] })), false);
  assert.equal(PL.isUnpaidPayLater({ cart_items: [{ title: 'COD book' }] }), false);
});

test('the link is created once, saved on the order, and emailed', async () => {
  const o = plOrder();
  const db = fakeDb([o]);
  const made = []; const mailed = [];
  const deps = {
    createLink: async (a) => { made.push(a); return { id: 'plink_1', short_url: 'https://rzp.io/l/x' }; },
    paymentLinkEmail: async (order, url, due) => { mailed.push([order.razorpay_order_id, url, !!due]); return { sent: true }; },
  };
  const r = await sendPayLaterLink(db, o, deps);
  assert.equal(r.ok, true);
  assert.equal(made.length, 1);
  assert.deepEqual(made[0].notes, { kind: 'pay_later', order_id: 'IC-20261123-ABCDE' });
  assert.equal(made[0].amountPaise, 56900);
  const meta = PL.payLaterMeta(o);
  assert.equal(meta.state, 'link_sent');
  assert.equal(meta.link_url, 'https://rzp.io/l/x');
  assert.ok(Date.parse(meta.due_at) > Date.now() + 6 * 86400000);
  // Resend reuses the same link.
  await sendPayLaterLink(db, o, deps);
  assert.equal(made.length, 1);
  assert.equal(mailed.length, 2);
});

test('a paid link writes the payment id, once', async () => {
  const o = plOrder({ cart_items: [{ slug: 'peer-e-kamil', _payment: { mode: 'pay_later', state: 'link_sent', link_id: 'plink_1' } }] });
  const db = fakeDb([o]);
  let alerts = 0;
  const deps = { fetchLinkStatus: async () => ({ status: 'paid', paymentId: 'pay_9' }), ownerAlert: async () => { alerts++; } };
  const r = await syncLink(db, o, deps);
  assert.equal(r.ok, true);
  assert.equal(o.razorpay_payment_id, 'pay_9');
  assert.equal(PL.payLaterMeta(o).state, 'paid');
  const again = await markPayLaterPaid(db, o, { paymentId: 'pay_10' }, deps);
  assert.equal(again.already, true);
  assert.equal(o.razorpay_payment_id, 'pay_9');
  assert.equal(alerts, 1);
});

test('the hourly job sends new links and flags overdue ones once', async () => {
  const { handle } = require('../pay-later-scheduled')._test;
  const past = new Date(Date.now() - 86400000).toISOString();
  const fresh = plOrder({ id: 'a', razorpay_order_id: 'IC-A' });
  const late = plOrder({ id: 'b', razorpay_order_id: 'IC-B', cart_items: [{ slug: 'peer-e-kamil', _payment: { mode: 'pay_later', state: 'link_sent', link_id: 'plink_b', link_url: 'u', due_at: past } }] });
  const rows = [fresh, late];
  const db = {
    from() {
      const q = { patch: null, filters: [] };
      const api = {
        select() { return api; }, order() { return api; }, limit() { return api; },
        eq(k, v) { if (!k.includes('->')) q.filters.push((r) => r[k] === v); return api; },
        is(k, v) { q.filters.push((r) => (v === null ? r[k] == null : r[k] === v)); return api; },
        update(p) { q.patch = p; return api; },
        then(res, rej) {
          const hits = rows.filter((r) => q.filters.every((f) => f(r)));
          if (q.patch) hits.forEach((r) => Object.assign(r, q.patch));
          return Promise.resolve({ data: q.patch ? hits.map((r) => ({ id: r.id })) : hits, error: null }).then(res, rej);
        },
      };
      return api;
    },
  };
  const alerts = [];
  const deps = {
    db, skipAuth: true,
    createLink: async () => ({ id: 'plink_a', short_url: 'https://rzp.io/l/a' }),
    paymentLinkEmail: async () => ({ sent: true }),
    fetchLinkStatus: async () => ({ status: 'created', paymentId: null }),
    ownerAlert: async (t) => alerts.push(t),
  };
  const out = JSON.parse((await handle({}, deps)).body);
  assert.deepEqual(out.links_sent, ['IC-A']);
  assert.deepEqual(out.overdue, ['IC-B']);
  assert.equal(alerts.length, 1);
  const again = JSON.parse((await handle({}, deps)).body);
  assert.deepEqual(again.overdue, []);
  assert.deepEqual(again.links_sent, []);
});

test('a customer on the owner\'s list is eligible without 5 delivered orders; others still need them', async () => {
  const cfgAllow = { ...cfg, allow: [{ phone: '9811122233', name: 'Regular from shop' }] };
  const countDb = (n) => ({ from() { const api = { select() { return api; }, like() { return api; }, eq() { return api; }, not() { return Promise.resolve({ count: n, error: null }); } }; return api; } });
  const noDb = { from() { throw new Error('the allow-list must not need the database'); } };
  assert.deepEqual(await PL.eligibility(noDb, cfgAllow, '+91 98111 22233'), { eligible: true, allowed: true, delivered: null });
  assert.equal(PL.isAllowed(cfgAllow, '919811122233'), true);
  assert.equal(PL.isAllowed(cfgAllow, '9811122234'), false);
  assert.deepEqual(await PL.eligibility(countDb(2), cfgAllow, '9800000000'), { eligible: false, allowed: false, delivered: 2 });
  assert.deepEqual(await PL.eligibility(countDb(5), cfgAllow, '9800000000'), { eligible: true, allowed: false, delivered: 5 });
});
