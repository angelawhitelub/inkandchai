'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { COLUMNS, QUESTION_COLUMNS, toDtdcRow, splitAddress } = require('./dtdc-upload');
const { _test: upload } = require('../admin-dtdc-upload');

const col = (row, name) => row[COLUMNS.indexOf(name)];

const woo = (over = {}) => ({
  number: 'IC-20261006-ABCDE',
  payment_method: 'cod',
  total: '499.00',
  date_created: '2026-10-06T20:00:00',
  billing: { email: 'reader@example.com' },
  shipping: { first_name: 'Asha', last_name: 'Rao', address_1: 'Flat 4, Lake View Road, Indiranagar', city: 'Bengaluru', state: 'Karnataka', postcode: '560038', phone: '9876543210' },
  line_items: [{ name: 'Atomic Habits', quantity: 2 }, { name: 'Ikigai', quantity: 1 }],
  meta_data: [{ key: '_iac_order_value', value: '499.00' }, { key: '_iac_collectable', value: '499.00' }],
  ...over,
});

test('the template header is the portal sample, verbatim', () => {
  assert.equal(COLUMNS.length, 192);
  assert.equal(new Set(COLUMNS).size, 192);
  assert.deepEqual(COLUMNS.slice(0, 4), ['Unique_Id', 'Client Code', 'Consignment Number', 'Customer Reference Number']);
  assert.equal(COLUMNS[191], 'Packaging Material Code');
  assert.equal(QUESTION_COLUMNS.length, 12);
});

test('a COD order carries its collectable, mode and parcel details', () => {
  const { row, cod } = toDtdcRow(woo(), { env: {} });
  assert.equal(row.length, 192);
  assert.equal(cod, true);
  assert.equal(col(row, 'Client Code'), 'GL22082');
  assert.equal(col(row, 'Consignment Number'), '');
  assert.equal(col(row, 'Customer Reference Number'), 'IC-20261006-ABCDE');
  assert.equal(col(row, 'Service Type'), 'B2C SMART EXPRESS');
  assert.equal(col(row, 'Courier Type'), 'NON-DOCUMENT');
  assert.equal(col(row, 'Cod Amount'), '499');
  assert.equal(col(row, 'Cod Mode'), 'cash');
  assert.equal(col(row, 'Declared Price (non-document)'), '499');
  assert.equal(col(row, 'Destination Pincode'), '560038');
  assert.equal(col(row, 'Destination Name'), 'Asha Rao');
  assert.equal(col(row, 'Origin Pincode'), '110006');
  assert.equal(col(row, 'Return Pincode'), '110006');
  assert.equal(col(row, 'Description'), '2 x Atomic Habits; Ikigai');
  assert.equal(col(row, 'Invoice Date'), '2026-10-07');   // 20:00 UTC is the next day in IST
});

test('prepaid and replacement orders collect nothing; partial COD collects only the balance', () => {
  const prepaid = toDtdcRow(woo({ payment_method: 'prepaid', meta_data: [{ key: '_iac_order_value', value: '650' }, { key: '_iac_collectable', value: '0' }] }), { env: {} });
  assert.equal(prepaid.cod, false);
  assert.equal(col(prepaid.row, 'Cod Amount'), '');
  assert.equal(col(prepaid.row, 'Cod Mode'), '');
  assert.equal(col(prepaid.row, 'Declared Price (non-document)'), '650');

  const partial = toDtdcRow(woo({ meta_data: [{ key: '_iac_order_value', value: '900' }, { key: '_iac_collectable', value: '700' }] }), { env: {} });
  assert.equal(col(partial.row, 'Cod Amount'), '700');
  assert.equal(col(partial.row, 'Declared Price (non-document)'), '900');
});

test('long addresses split into two lines on a comma', () => {
  const long = 'House 12, ' + 'Very Long Street Name '.repeat(6) + ', Near The Big Temple, Sector 5';
  const [a, b] = splitAddress(long, 100);
  assert.ok(a.length <= 100 && b.length <= 100);
  assert.ok(b.length > 0);
  assert.equal(splitAddress('Short road 1')[1], '');
});

test('build: unprojectable orders are skipped, not uploaded', async () => {
  const orders = [
    { id: 'u1', razorpay_order_id: 'IC-1', status: 'cod_pending' },
    { id: 'u2', razorpay_order_id: 'IC-2', status: 'paid' },
    { id: 'u3', razorpay_order_id: 'IC-3', status: 'pending_phonepe' },
  ];
  const chain = { select: () => chain, or: () => chain, in: () => chain, is: () => chain, gte: () => chain, order: () => chain, limit: async () => ({ data: orders, error: null }) };
  const supabase = { from: () => chain };
  const toWooOrder = async (o) => {
    if (o.razorpay_order_id === 'IC-2') throw new Error('Cannot determine a 6-digit pincode for IC-2');
    return woo({ number: o.razorpay_order_id });
  };
  const out = await upload.build({ days: 30 }, { supabase, toWooOrder });
  assert.equal(out.rows.length, 1);
  assert.deepEqual(out.skipped, [{ order: 'IC-2', error: 'Cannot determine a 6-digit pincode for IC-2' }]);
  assert.equal(out.cod, 1);
  assert.equal(out.cod_total_rs, 499);
});
