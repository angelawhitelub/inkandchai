'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { isParamCountError, shippedEmailHtml } = require('./shipped-notification');

test('Metas parameter-count rejection is recognised by code', () => {
  // 132000 is what Meta returns when the template arity does not match, and
  // it is returned -- not thrown -- so nothing notices unless it is checked.
  assert.equal(isParamCountError({ data: { error: { code: 132000 } } }), true);
  assert.equal(isParamCountError({ data: { error: { code: '132000' } } }), true);
});

test('the rejection is also recognised by message, not only by code', () => {
  assert.equal(isParamCountError({ data: { error: { message: 'number of parameters does not match' } } }), true);
  assert.equal(isParamCountError({ data: { error: { error_data: { details: 'parameter count mismatch' } } } }), true);
});

test('an unrelated failure is NOT treated as a parameter-count problem', () => {
  // Retrying a different failure with fewer parameters would be noise, and
  // could deliver a wrongly-shaped message if the retry happened to pass.
  assert.equal(isParamCountError({ data: { error: { code: 131047, message: 'Re-engagement message' } } }), false);
  assert.equal(isParamCountError({ data: { error: { code: 190, message: 'Invalid token' } } }), false);
  assert.equal(isParamCountError({}), false);
  assert.equal(isParamCountError(null), false);
});

test('the shipped email carries the tracking link it was given', () => {
  const html = shippedEmailHtml({
    name: 'Nisha', orderNumber: 'IC-20260917-C6WPE', courier: 'Xpressbees',
    awb: '143449610518830',
    trackUrl: 'https://shipmentv2.xpressbees.com/orders/tracking/143449610518830',
    items: [{ title: 'Atomic Habits', qty: 1 }],
  });
  assert.ok(html.includes('shipmentv2.xpressbees.com/orders/tracking/143449610518830'));
  assert.ok(html.includes('143449610518830'));
  assert.ok(html.includes('Atomic Habits'));
  assert.ok(!/nimbuspost/i.test(html), 'no NimbusPost link may appear in a shipped email');
});

test('the email omits the track button when there is no link', () => {
  const html = shippedEmailHtml({ name: 'A', orderNumber: 'IC-1', courier: 'X', awb: '1', trackUrl: '', items: [] });
  assert.ok(!html.includes('Track your parcel'), 'a button with no URL must not be rendered');
});
