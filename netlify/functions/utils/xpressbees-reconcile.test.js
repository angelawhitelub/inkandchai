'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { baseOrderNumber, panelPayment } = require('../admin-xpressbees-reconcile').__test;

test('a re-booking suffix is stripped, a real id ending is not', () => {
  assert.equal(baseOrderNumber('IC-20260917-E3Q0N-p'), 'IC-20260917-E3Q0N');
  assert.equal(baseOrderNumber('IC-R-20260917-2UZT-p'), 'IC-R-20260917-2UZT');
  assert.equal(baseOrderNumber('IC-20260916-6MATS'), 'IC-20260916-6MATS', 'the id itself must survive intact');
  assert.equal(baseOrderNumber('IC-R-CW-20260917-NQR'), 'IC-R-CW-20260917-NQR');
  assert.equal(baseOrderNumber(' ic-20260917-e3q0n-P '), 'IC-20260917-E3Q0N');
});

test('panel payment is read whatever the field is called', () => {
  assert.deepEqual(panelPayment({ payment_type: 'cod', collectable_amount: 159 }), { mode: 'cod', collectable: 159, isCOD: true });
  assert.deepEqual(panelPayment({ payment_mode: 'PREPAID', cod_amount: 0 }), { mode: 'prepaid', collectable: 0, isCOD: false });
  assert.deepEqual(panelPayment({ payment_method: 'Cash on Delivery', cod_charges: '305' }), { mode: 'cash on delivery', collectable: 305, isCOD: true });
});

test('an unlabelled row with money on it is treated as COD', () => {
  // Fail towards "the courier will collect", because that is the failure that
  // costs a customer money and must be surfaced, not assumed away.
  assert.equal(panelPayment({ collectable_amount: 199 }).isCOD, true);
  assert.equal(panelPayment({ collectable_amount: 0 }).isCOD, false);
});
