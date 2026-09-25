const test = require('node:test');
const assert = require('node:assert');
const ip = require('./india-pincodes');

test('the directory loaded and looks like the real thing', () => {
  assert.ok(ip.count > 15000, `only ${ip.count} pincodes — the generated file looks truncated`);
  assert.match(ip.generatedAt, /^\d{4}-\d{2}-\d{2}$/);
});

test('real pincodes are known, flat and house numbers are not', () => {
  for (const pin of ['110001', '411028', '561202', '400053', '231305', '201009']) {
    assert.equal(ip.isKnownPincode(pin), true, pin);
  }
  // From real orders: a flat number, a house number, a made-up code.
  for (const pin of ['260187', '100832', '400000']) {
    assert.equal(ip.isKnownPincode(pin), false, pin);
  }
});

test('unreadable input is not a pincode', () => {
  for (const bad of ['', null, undefined, 'abc', '41102', '4110281', '011028', '911028']) {
    assert.equal(ip.isKnownPincode(bad), false, String(bad));
  }
});
