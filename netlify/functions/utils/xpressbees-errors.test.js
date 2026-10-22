'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyXbError, availableServices } = require('./xpressbees-errors');
const { bookingHold, describeFailure } = require('../xpressbees-ship');

// Every message below is one XpressBees actually returned on 13 Oct 2026.
test('real XpressBees refusals land in the right group', () => {
  const k = (m) => classifyXbError(m).kind;
  assert.equal(k('XpressBees booking failed: Order number already in use.'), 'in_panel');
  assert.equal(k('XpressBees serviceability failed for 302011: {"status":false,"data":"Destination Pincode Not Servicable."}'), 'pincode');
  assert.equal(k('XpressBees booking failed: Drop pincode not serviceable'), 'pincode');
  assert.equal(k('Courier 1 is not serviceable for this pincode. Available: 4=Xpressbees 10 K.G'), 'no_service');
  assert.equal(k('IC-20261011-UEB8E: Address has 2 different pincodes (641023, 641014) and both are in TN. Correct the address to the one right pincode, then push again.'), 'address');
  assert.equal(k('Cannot determine a 10-digit phone for IC-1 (got "123")'), 'phone');
  assert.equal(k('XpressBees login failed: invalid credentials'), 'auth');
  assert.equal(k('XpressBees booking failed: Insufficient wallet balance'), 'wallet');
  assert.equal(k('XpressBees booking failed: something new'), 'other');
});

test('a pincode inside a message is not mistaken for a 5xx', () => {
  assert.equal(classifyXbError('XpressBees booking failed: weird thing for 122505').kind, 'other');
  assert.equal(classifyXbError('XpressBees booking failed: HTTP 502 Bad Gateway').kind, 'network');
});

test('the services a pincode does have are listed for the admin', () => {
  assert.deepEqual(availableServices('Courier 1 is not serviceable for this pincode. Available: 4=Xpressbees 10 K.G, 6=Air Xpressbees 0.5 K.G'),
    [{ id: '4', name: 'Xpressbees 10 K.G' }, { id: '6', name: 'Air Xpressbees 0.5 K.G' }]);
  const f = describeFailure('IC-1', 'Courier 1 is not serviceable for this pincode. Available: 4=Xpressbees 10 K.G');
  assert.equal(f.kind, 'no_service');
  assert.equal(f.available[0].name, 'Xpressbees 10 K.G');
  assert.ok(f.title && f.action);
});

test('only orders waiting to ship, past their 30-minute cancel window, may be booked', () => {
  const now = Date.parse('2026-10-14T10:00:00Z');
  const old = '2026-10-14T09:00:00Z';
  assert.equal(bookingHold({ status: 'cod_pending', created_at: old }, now), null);
  assert.equal(bookingHold({ status: 'replacement_pending', created_at: old }, now), null);
  assert.equal(bookingHold({ status: 'cancelled', created_at: old }, now).kind, 'status');
  assert.equal(bookingHold({ status: 'shipped', created_at: old }, now).kind, 'status');
  assert.equal(bookingHold({ status: 'pending_phonepe', created_at: old }, now).kind, 'status');
  assert.equal(bookingHold({ status: 'paid', created_at: old, cancellation_requested_at: old }, now).kind, 'cancel_requested');
  assert.equal(bookingHold({ status: 'paid', created_at: '2026-10-14T09:45:00Z' }, now).kind, 'fresh');
});
