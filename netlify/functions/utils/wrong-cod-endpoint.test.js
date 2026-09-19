'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { identifies } = require('../wrong-cod-refund').__test;

const order = { customer_email: 'Sneha@Example.com ', customer_phone: '+91 98765 43210' };

test('the email that placed the order opens it, case and spacing aside', () => {
  assert.equal(identifies(order, 'sneha@example.com'), true);
  assert.equal(identifies(order, ' SNEHA@EXAMPLE.COM '), true);
});

test('the phone that placed the order opens it, however it is written', () => {
  for (const q of ['9876543210', '+91 98765 43210', '919876543210', '098765 43210']) {
    assert.equal(identifies(order, q), true, q);
  }
});

test('somebody else does not get to press the refund button', () => {
  assert.equal(identifies(order, 'someone@else.com'), false);
  assert.equal(identifies(order, '9111111111'), false);
  assert.equal(identifies(order, ''), false);
  assert.equal(identifies(order, '   '), false);
});

test('a short digit string never counts as a phone match', () => {
  assert.equal(identifies(order, '43210'), false);
  assert.equal(identifies({ customer_phone: '9876543210' }, '3210'), false);
});

test('an order with no contact on it cannot be opened by an empty guess', () => {
  assert.equal(identifies({}, 'anything'), false);
  assert.equal(identifies({ customer_email: null, customer_phone: null }, ''), false);
});
