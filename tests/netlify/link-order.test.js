'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { proofMatchesOrder, digits10 } = require('../../netlify/functions/link-order')._test;

const order = {
  customer_email: 'JoannaSanju28@gmail.com',
  customer_phone: '8879256805',
};

test('the checkout email proves ownership, case and spacing insensitively', () => {
  assert.ok(proofMatchesOrder(order, 'joannasanju28@gmail.com'));
  assert.ok(proofMatchesOrder(order, '  JOANNASANJU28@GMAIL.COM  '));
});

test('a different email of the same person does not', () => {
  // This is the whole point: signing in as the ves.ac.in account is not proof.
  assert.ok(!proofMatchesOrder(order, '2022.joanna.sanju@ves.ac.in'));
  assert.ok(!proofMatchesOrder(order, 'joannasanju@gmail.com'));
});

test('phone matches on the last 10 digits, in any stored format', () => {
  for (const stored of ['8879256805', '+918879256805', '91 88792 56805', '088792-56805']) {
    assert.ok(proofMatchesOrder({ ...order, customer_phone: stored }, '8879256805'), stored);
    assert.ok(proofMatchesOrder({ ...order, customer_phone: stored }, '+91 88792 56805'), stored);
  }
});

test('a partial phone number is never accepted', () => {
  assert.ok(!proofMatchesOrder(order, '56805'));
  assert.ok(!proofMatchesOrder(order, '887925680'));
  assert.strictEqual(digits10('56805'), '');
});

test('a different phone does not match', () => {
  assert.ok(!proofMatchesOrder(order, '9999999999'));
});

test('empty proof never matches, including against an order missing that field', () => {
  for (const p of ['', '   ', null, undefined]) assert.ok(!proofMatchesOrder(order, p));
  assert.ok(!proofMatchesOrder({ customer_email: null, customer_phone: null }, 'anything'));
  // An order with no email must not be claimable by sending an empty email.
  assert.ok(!proofMatchesOrder({ customer_email: '', customer_phone: '8879256805' }, ''));
});

test('an email is not accepted as a phone, or vice versa', () => {
  assert.ok(!proofMatchesOrder({ customer_email: '', customer_phone: '8879256805' }, 'joannasanju28@gmail.com'));
  assert.ok(!proofMatchesOrder({ customer_email: 'a@b.com', customer_phone: '' }, '8879256805'));
});
