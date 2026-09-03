const test = require('node:test');
const assert = require('node:assert');
const { _test } = require('../../netlify/functions/reverse-pincode');

test('only real Indian pincodes are accepted', () => {
  assert.strictEqual(_test.cleanPincode('110006'), '110006');
  assert.strictEqual(_test.cleanPincode(' 400 001 '), '400001');
  // 0 and 9 are not valid leading digits for an Indian PIN, and a geocoder that
  // returns a foreign postcode must not be passed on to serviceability.
  assert.strictEqual(_test.cleanPincode('012345'), '');
  assert.strictEqual(_test.cleanPincode('900001'), '');
  assert.strictEqual(_test.cleanPincode('SW1A 1AA'), '');
  assert.strictEqual(_test.cleanPincode(null), '');
});

test('coordinates are rounded to a neighbourhood, not a doorstep', () => {
  // 3 decimals ~110 m: enough to name a pincode, coarse enough that the value
  // is not a home address, and cacheable at the edge.
  assert.strictEqual(_test.coord('28.657391', 90), 28.657);
  assert.strictEqual(_test.coord(-77.2213456, 180), -77.221);
});

test('out-of-range and junk coordinates are rejected', () => {
  assert.strictEqual(_test.coord('91', 90), null);
  assert.strictEqual(_test.coord('181', 180), null);
  assert.strictEqual(_test.coord('', 90), null);
  assert.strictEqual(_test.coord('abc', 90), null);
});
