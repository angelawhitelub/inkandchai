'use strict';
// Owner, 28 Nov 2026: refund some books of an order still to ship; the rest ship,
// and no automatic refund pays the same money again.
const test = require('node:test');
const assert = require('node:assert/strict');
const pr = require('./prior-refund');
const { quoteUnpickedCancel } = require('./unpicked-cancel');
const { quoteLateCancel } = require('./prepaid-late-cancel');
const { refundOnCancel } = require('./not-picked-up');

const DAY = 864e5;
const order = (over = {}) => ({
  id: 'o1', razorpay_order_id: 'IC-20261118-DDDDD', status: 'shipped', amount_paise: 89800,
  razorpay_payment_id: 'pay_abc', created_at: new Date(Date.now() - 9 * DAY).toISOString(),
  tracking_id: '1434000000003', cart_items: [], ...over,
});
const partRefunded = (over = {}) => order({ refund_id: 'rfnd_1', refund_state: 'PROCESSED', refund_items: [{ title: 'Book B', qty: 1, amount: 299 }], ...over });

test('a part refund keeps the status of an order still shipping, not of a delivered one', () => {
  for (const s of ['paid', 'shipped', 'partial_cod_pending', 'out_for_delivery']) assert.equal(pr.keepStatusOnPartial({ status: s }), true, s);
  for (const s of ['delivered', 'cancelled', 'rto', 'refunded']) assert.equal(pr.keepStatusOnPartial({ status: s }), false, s);
});

test('a failed refund is not a prior refund', () => {
  assert.equal(pr.hasPriorRefund(partRefunded()), true);
  assert.equal(pr.hasPriorRefund(partRefunded({ refund_state: 'FAILED' })), false);
  assert.equal(pr.hasPriorRefund(order()), false);
  assert.equal(pr.priorRefundRs(partRefunded()), 299);
});

test('part-refunded: no customer self-cancel with a "full refund"', () => {
  assert.equal(quoteUnpickedCancel(order()).eligible, true);
  assert.equal(quoteUnpickedCancel(partRefunded()).reason, 'prior_refund');
  assert.equal(quoteLateCancel(partRefunded()).reason, 'prior_refund');
});

test('Not Picked Up says the rest of the refund is by hand', () => {
  const f = refundOnCancel(partRefunded());
  assert.equal(f.via, 'manual');
  assert.equal(f.amount_rs, 599);
  assert.match(f.message, /part refunded already \(₹299\)/);
  assert.equal(refundOnCancel(order()).via, 'gateway');
});
