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

test('two pincodes in different states: the one in the named state wins', () => {
  // IC-20260905-U8RZQ, verbatim. The first-match parser sent this to 561202
  // (Karnataka); the parcel went to the wrong state and came back RTO.
  const a = parseAddress('Tower 56, floor 12, Flat 02, Future Tower, (561202), Amanora Park Town, Hadapsar, Pune, Maharashtra, 411028');
  assert.equal(a.pincode, '411028');
  assert.equal(a.city, 'Pune');
  assert.equal(a.state, 'Maharashtra');
  assert.equal(a.pincodeProblem, '');
  // IC-20260630-SSCUT: here the FIRST code is the junk one (396580 is Gujarat).
  assert.equal(parseAddress('396580, Varanasi Rd, Mirzapur, Uttar Pradesh, 231305').pincode, '231305');
});

test('two pincodes in the SAME state: refuse to guess, and say why', () => {
  // IC-CW-20260918-PL08Q. Lokhandwala is 400053; the pincode field's 400005
  // is Colaba. "Take the last" would have misrouted this one, "take the
  // first" misrouted U8RZQ -- so neither rule is safe and none is applied.
  const a = parseAddress('1101/2, A wing, Highland Park housing society, Lion Sol Marg, Lokhandwala Complex, Andheri West, Mumbai 400053, Mumbai, Maharashtra, 400005');
  assert.equal(a.pincode, '');
  assert.match(a.pincodeProblem, /400053/);
  assert.match(a.pincodeProblem, /400005/);
  assert.match(a.pincodeProblem, /Correct the address/);
});

test('two pincodes and no state named: refuse', () => {
  const a = parseAddress('Flat 3, 110085 Rohini, near 110034 metro');
  assert.equal(a.pincode, '');
  assert.match(a.pincodeProblem, /no state is named/);
});

test('a flat or house number that is no pincode at all is ignored', () => {
  // IC-20260811-RQIL6 was booked to 260187 -- the flat number. No such
  // pincode exists; the field's 201009 is the only real one.
  assert.equal(parseAddress('flat no 260187, tower v, 14th avenue, gaur city 2, Ghaziabad, Uttar Pradesh, 201009').pincode, '201009');
  // IC-20260730-1U94S: 400000 is not a pincode either.
  const a = parseAddress('Room 4, 400000 building, Ghatkopar, Mumbai, Maharashtra 400080, Mumbai, Maharashtra, 400000');
  assert.equal(a.pincode, '400080');
  assert.equal(a.pincodeProblem, '');
});

test('two REAL pincodes in one state are still refused, flat numbers or not', () => {
  const a = parseAddress('Flat 260187, Lokhandwala, Mumbai 400053, Mumbai, Maharashtra, 400005');
  assert.equal(a.pincode, '');
  assert.match(a.pincodeProblem, /2 different pincodes \(400053, 400005\)/);
  assert.doesNotMatch(a.pincodeProblem, /260187/);
});

test('the same digits in the street line survive when the pincode is cut out', () => {
  const a = parseAddress('Plot 411028, Sector 5, Pune, Maharashtra, 411028');
  assert.equal(a.pincode, '411028');
  assert.match(a.address, /Plot 411028/);
  assert.equal(a.state, 'Maharashtra');
});

test('a single pincode anywhere is still found', () => {
  assert.equal(parseAddress('House No A-68 , Near Kendriya Bhandar Pin code 110021').pincode, '110021');
  assert.equal(parseAddress('Flat 3 Sector 9 Rohini Delhi 110085 near metro').pincode, '110085');
  assert.equal(parseAddress('House No A-68 , Near Kendriya Bhandar Pin code 110021').pincodeProblem, '');
});
