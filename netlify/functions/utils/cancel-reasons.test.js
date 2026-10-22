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

test('each WhatsApp template gets exactly the variables its approved body has', async () => {
  const path = require('path');
  const sent = [];
  const stub = (file, exports) => {
    const id = require.resolve(path.join(__dirname, file));
    require.cache[id] = { id, filename: id, loaded: true, exports };
  };
  stub('./whatsapp.js', { sendWhatsApp: async (m) => { sent.push(m); return { ok: true }; } });
  stub('./email.js', { sendEmail: async () => ({ ok: true }) });
  delete require.cache[require.resolve('./order-cancelled-notification')];
  const { notifyOrderCancelled } = require('./order-cancelled-notification');
  const env = { ...process.env };
  Object.assign(process.env, {
    WHATSAPP_ORDER_CANCELLED_STOCK_TEMPLATE: 'order_cancelled_stock', WHATSAPP_ORDER_CANCELLED_V2: '1',
    WHATSAPP_ORDER_CANCELLED_ADDRESS_TEMPLATE: 'order_cancelled_address', WHATSAPP_ORDER_CANCELLED_PINCODE_TEMPLATE: 'order_cancelled_pincode',
  });
  delete process.env.WHATSAPP_ORDER_CANCELLED_OTHER_TEMPLATE;
  delete process.env.STORE_OWNER_EMAIL;
  const order = { razorpay_order_id: 'IC-1', customer_name: 'Asha K', customer_phone: '9999999999', customer_address: 'X, Agartala 799001', cart_items: [{ title: 'Book', qty: 1 }] };
  try {
    const counts = {};
    for (const kind of ['store', 'customer', 'address', 'pincode', 'other']) {
      sent.length = 0;
      const r = await notifyOrderCancelled(order, { kind, note: kind === 'other' ? 'Recalled' : '', skipRefund: true, skipEmail: true });
      counts[kind] = sent[0] ? `${sent[0].template}:${sent[0].params.length}` : `skipped:${r.whatsapp_skipped}`;
      if (kind === 'pincode') assert.equal(sent[0].params[2], '799001');
      if (kind === 'address') assert.doesNotMatch(sent[0].params[3], /\.$/, 'body already ends "{{4}}."');
    }
    assert.deepEqual(counts, {
      store: 'order_cancelled_stock:3',
      customer: 'order_cancelled:4',
      address: 'order_cancelled_address:4',
      pincode: 'order_cancelled_pincode:4',
      other: 'skipped:no other template configured',
    });
  } finally {
    process.env = env;
  }
});
