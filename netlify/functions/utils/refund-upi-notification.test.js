const test = require('node:test');
const assert = require('node:assert/strict');
const { plainMessage, emailHtml, SENDER_NAME } = require('./refund-upi-notification');

const order = {
  razorpay_order_id: 'IC-20260905-ON3GH',
  customer_name: 'Het Patel',
  customer_email: 'het@example.com',
  customer_phone: '9974701005',
};
const base = { order, amountRs: 149, upiId: '9974701005@upi', ref: 'UTR998877', books: ['Chhota Bheem'] };

test('the message names the bank statement will show, not the shop name', () => {
  // The entire reason this notification exists. A customer searching their
  // statement for "Ink & Chai" finds nothing and writes in.
  const text = plainMessage(base);
  assert.match(text, /Malka Enterprises/);
  assert.match(text, /not "Ink & Chai"/);
  assert.match(emailHtml(base), /Malka Enterprises/);
});

test('it points at PhonePe, where these customers actually look', () => {
  assert.match(plainMessage(base), /PhonePe or bank statement/);
  assert.match(emailHtml(base), /PhonePe or bank statement/);
});

test('it never claims the money went back to a payment method', () => {
  // These are COD orders: nothing was ever captured, so there is no instrument
  // to reverse. Borrowing the gateway-refund wording would be false.
  for (const body of [plainMessage(base), emailHtml(base)]) {
    assert.doesNotMatch(body, /original payment method/i);
    assert.doesNotMatch(body, /2-3 business days/i);
  }
});

test('amount, order id, UPI handle and reference all reach the customer', () => {
  const text = plainMessage(base);
  assert.match(text, /Rs 149\.00/);
  assert.match(text, /IC-20260905-ON3GH/);
  assert.match(text, /9974701005@upi/);
  assert.match(text, /UTR998877/);
  const html = emailHtml(base);
  for (const bit of ['149.00', 'IC-20260905-ON3GH', '9974701005@upi', 'UTR998877', 'Chhota Bheem']) {
    assert.ok(html.includes(bit), `email is missing ${bit}`);
  }
});

test('a missing reference is simply left out, never printed empty', () => {
  const text = plainMessage({ ...base, ref: '' });
  assert.doesNotMatch(text, /Reference/);
  assert.doesNotMatch(emailHtml({ ...base, ref: '' }), /Reference \/ UTR/);
});

test('a customer whose name we do not have is addressed, not skipped', () => {
  assert.match(plainMessage({ ...base, order: { ...order, customer_name: '' } }), /^Hi there,/);
});

test('book titles and names are escaped into the email', () => {
  const html = emailHtml({ ...base, books: ['<script>alert(1)</script>'] });
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(!html.includes('<script>alert(1)</script>'));
});

test('paise are always shown, so 149 never reads as a different number', () => {
  assert.match(plainMessage({ ...base, amountRs: 149 }), /Rs 149\.00/);
  assert.match(plainMessage({ ...base, amountRs: 179.1 }), /Rs 179\.10/);
  assert.match(plainMessage({ ...base, amountRs: 1234.5 }), /Rs 1,234\.50/);
});

test('the sender name is configurable but defaults to the registered entity', () => {
  const before = process.env.REFUND_SENDER_NAME;
  try {
    delete process.env.REFUND_SENDER_NAME;
    assert.equal(SENDER_NAME(), 'Malka Enterprises');
    process.env.REFUND_SENDER_NAME = 'Some Other Entity';
    assert.equal(SENDER_NAME(), 'Some Other Entity');
    assert.match(plainMessage(base), /Some Other Entity/);
  } finally {
    if (before === undefined) delete process.env.REFUND_SENDER_NAME;
    else process.env.REFUND_SENDER_NAME = before;
  }
});
