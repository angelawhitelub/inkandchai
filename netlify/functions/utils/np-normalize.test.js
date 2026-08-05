const test = require('node:test');
const assert = require('node:assert');
const { parseAddress, normalizeIndianPhone } = require('./np-normalize');

// Regression: a two-segment address had BOTH segments popped as city + state,
// leaving the street line empty. NimbusPost then rejected the push with
// "address is required" — the two failures on 2026-08-05 were IC-20260804-0DZEU
// and IC-20260709-30TNL, both two-segment addresses.
test('a two-segment address keeps both segments as the street line', () => {
  const a = parseAddress('House No A-68 Type 2 Moti Bagh 1 ,\nNear Kendriya Bhandar Pin code 110021');
  assert.equal(a.address, 'House No A-68 Type 2 Moti Bagh 1, Near Kendriya Bhandar');
  assert.equal(a.pincode, '110021');
  // city/state stay blank on purpose — enrichAddress fills them from the
  // pincode, which is authoritative, instead of guessing from the text.
  assert.equal(a.city, '');
  assert.equal(a.state, '');
});

test('a two-segment address ending in a city does not lose the street', () => {
  const a = parseAddress('Mayurinagar miyapur apj abdulkalam park, Hyderabad, 123456');
  assert.equal(a.address, 'Mayurinagar miyapur apj abdulkalam park, Hyderabad');
  assert.equal(a.pincode, '123456');
});

test('a well-formed address still splits into street / city / state', () => {
  const a = parseAddress('Kazi galli near national school naldurg tq tuljapur dist osmanabad, Osmanabad, Maharashtra, 413602');
  assert.equal(a.address, 'Kazi galli near national school naldurg tq tuljapur dist osmanabad');
  assert.equal(a.city, 'Osmanabad');
  assert.equal(a.state, 'Maharashtra');
  assert.equal(a.pincode, '413602');
});

test('a long address keeps every street segment', () => {
  const a = parseAddress('Plot 417, TNGO Colony, Near MyHome, Gachibowli, K.V.Rangareddy, Telangana, 500032');
  assert.equal(a.address, 'Plot 417, TNGO Colony, Near MyHome, Gachibowli');
  assert.equal(a.city, 'K.V.Rangareddy');
  assert.equal(a.state, 'Telangana');
});

test('a comma-less address is kept whole', () => {
  const a = parseAddress('Flat 3B Sunrise Apartments MG Road Bangalore 560001');
  assert.equal(a.address, 'Flat 3B Sunrise Apartments MG Road Bangalore');
  assert.equal(a.pincode, '560001');
});

test('any address carrying real text keeps a street line', () => {
  for (const raw of ['Delhi, Delhi, 110001', 'Osmanabad, Maharashtra', 'Sector 62, Noida, 201301']) {
    assert.ok(parseAddress(raw).address.trim(), `blank street line for "${raw}"`);
  }
});

test('a bare pincode yields no street line, so the push fails loudly', () => {
  // buildPayload turns this into "no street line" rather than letting
  // NimbusPost answer with its opaque "address is required".
  assert.equal(parseAddress('110001').address.trim(), '');
});

test('phones survive country codes and trunk zeros', () => {
  assert.equal(normalizeIndianPhone('+919871518571'), '9871518571');
  assert.equal(normalizeIndianPhone('09871518571'), '9871518571');
  assert.equal(normalizeIndianPhone('9871518571'), '9871518571');
  assert.equal(normalizeIndianPhone('+91 98715 18571'), '9871518571');
  assert.equal(normalizeIndianPhone('12345'), '');
});
