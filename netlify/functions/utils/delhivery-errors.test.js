const test = require('node:test');
const assert = require('node:assert');
const { explain, innerReason } = require('./delhivery-errors');

// Verbatim from the 25 Sep pushes.
const WALLET = "Crashing while saving package due to exception 'Prepaid client manifest charge API failed due to insufficient balance'. Package might have been partially saved.";
const PIN = "Crashing while saving package due to exception '683585 is non serviceable pincode'. Package might have been partially saved.";

test('the real reason is pulled out of their wrapper', () => {
  assert.equal(innerReason(WALLET), 'Prepaid client manifest charge API failed due to insufficient balance');
  assert.equal(innerReason(PIN), '683585 is non serviceable pincode');
});

test('a wallet failure and a pincode failure no longer look the same', () => {
  const w = explain(WALLET), p = explain(PIN);
  assert.equal(w.kind, 'wallet');
  assert.equal(p.kind, 'pincode');
  assert.notEqual(w.title, p.title);
  assert.match(w.action, /Recharge/);
});

test('the raw text is always kept', () => {
  assert.equal(explain(PIN).raw, PIN);
});

test('text without the wrapper is read as-is', () => {
  const e = explain('no package returned for this order');
  assert.equal(e.reason, 'no package returned for this order');
  assert.equal(e.kind, 'other');
});

test('nothing at all still produces a readable row', () => {
  const e = explain(undefined);
  assert.equal(e.kind, 'other');
  assert.equal(e.reason, 'no reason given');
});

test('common refusals land in the right group', () => {
  assert.equal(explain("Crashing while saving package due to exception 'Duplicate order id'.").kind, 'duplicate');
  assert.equal(explain('ClientWarehouse matching query does not exist').kind, 'pickup');
  assert.equal(explain('Delhivery request timed out after 30s').kind, 'network');
});
