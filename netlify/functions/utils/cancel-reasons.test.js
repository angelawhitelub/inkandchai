'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readCancelReason, pincodeOf } = require('./cancel-reasons');
const { cancellationKind, cancellationCopy, __test } = require('./order-cancelled-notification');

test('reason codes, CSV spellings, and the note "other" requires', () => {
  assert.equal(readCancelReason('', ''), null, 'no reason: callers keep the old behaviour');
  assert.equal(readCancelReason('incomplete_address').kind, 'address');
  assert.equal(readCancelReason('Pincode not serviceable').code, 'unserviceable_pincode');
  assert.equal(readCancelReason('No inventory').code, 'out_of_stock');
  assert.match(readCancelReason('banana').error, /Unknown cancel_reason/);
  assert.match(readCancelReason('other', '  ').error, /needs a cancel_note/);
  assert.deepEqual(readCancelReason('other', 'Book  is\nbanned'), { code: 'other', label: 'Other', kind: 'other', note: 'Book is banned' });
});

test('the pincode is the last 6-digit number in the address', () => {
  assert.equal(pincodeOf({ customer_address: 'Flat 12, Block 3, Sector 110001 Road, New Delhi, Delhi 110092' }), '110092');
  assert.equal(pincodeOf({ customer_address: 'no pin here' }), '');
});

test('each reason gets its own email, none of them blamed on stock', () => {
  const addr = cancellationCopy('address', 'Asha');
  assert.match(addr.body, /address was incomplete/);
  assert.match(addr.tail, /6-digit pincode/);
  const pin = cancellationCopy('pincode', 'Asha', { pincode: '799001' });
  assert.match(pin.body, /799001/);
  const other = cancellationCopy('other', 'Asha', { note: 'Publisher <recalled> it.' });
  assert.match(other.body, /Publisher &lt;recalled&gt; it\./, 'admin text is escaped');
  for (const c of [addr, pin, other]) assert.doesNotMatch(c.body, /stock|supplier/i);
  assert.equal(cancellationKind({ kind: 'other' }), 'store', 'other without a note falls back');
  assert.equal(cancellationKind({ kind: 'pincode' }), 'pincode');
});

test('the full email for an address cancellation has no out-of-stock paragraph', () => {
  const html = __test.orderCancelledEmailHtml({ razorpay_order_id: 'IC-1', customer_name: 'Asha K', cart_items: [{ title: 'Book', qty: 1 }], amount_paise: 29900 }, null, { kind: 'address' });
  assert.match(html, /address was incomplete/);
  assert.doesNotMatch(html, /Stock does come back/);
  assert.match(html, /not charged/);
});
