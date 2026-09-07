'use strict';
const test = require('node:test');
const assert = require('node:assert');

const { statesMentioned, canonicalState, addressShapeIssues, phoneIssues, lookupPincode, mapLimit } =
  require('../../netlify/functions/admin-address-audit')._internals;

const codes = list => list.map(i => i.code).sort();
const severityOf = (list, code) => (list.find(i => i.code === code) || {}).severity;

/* -- state detection ----------------------------------------------------- */

test('statesMentioned finds the state written in an address', () => {
  assert.deepStrictEqual(statesMentioned('12 MG Road, Indore, Madhya Pradesh'), ['madhya pradesh']);
});

test('statesMentioned treats Orissa and Odisha as the same state', () => {
  // India Post says "Odisha"; customers still type "Orissa". Reporting those as
  // a mismatch would flag thousands of perfectly good addresses.
  assert.deepStrictEqual(statesMentioned('Sakhigopal, Puri, Orissa'), ['odisha']);
  assert.strictEqual(canonicalState('Odisha'), 'odisha');
});

test('statesMentioned prefers the longer name over its suffix', () => {
  assert.deepStrictEqual(statesMentioned('Flat 3, Sector 12, New Delhi'), ['delhi']);
  assert.deepStrictEqual(statesMentioned('Guntur, Andhra Pradesh'), ['andhra pradesh']);
});

test('statesMentioned does not match a state name inside a longer word', () => {
  // " goa " needs its word boundaries; "Goalpara" is a district in Assam.
  assert.deepStrictEqual(statesMentioned('Goalpara town, Assam'), ['assam']);
});

test('statesMentioned returns every state named, so ambiguous lines can be skipped', () => {
  const found = statesMentioned('Near Kerala Bhavan, Connaught Place, Delhi');
  assert.strictEqual(found.length, 2);
  // The caller only flags a mismatch when exactly one state is named, so a
  // landmark carrying another state's name cannot manufacture a false positive.
});

/* -- address shape ------------------------------------------------------- */

test('a blank street line is critical', () => {
  assert.strictEqual(severityOf(addressShapeIssues('560001', '560001'), 'empty_address'), 'critical');
});

test('the pincode is not counted as address content', () => {
  // Without stripping it first, "560001" looks like a 6-char address that
  // contains a number, and both checks below would pass.
  const issues = addressShapeIssues('560001', '560001');
  assert.deepStrictEqual(codes(issues), ['empty_address']);
});

test('a too-short address is critical, a thin one is only a warning', () => {
  assert.strictEqual(severityOf(addressShapeIssues('Kalyan Nagar 560043', '560043'), 'address_too_short'), 'critical');
  assert.strictEqual(severityOf(addressShapeIssues('Plot 14 Kalyan Nagar Bengaluru 560043', '560043'), 'address_thin'), 'warn');
});

test('an address with no digits is flagged as having no house number', () => {
  const issues = addressShapeIssues('Near the old temple, Behind bus stand, Kalyan Nagar, Bengaluru 560043', '560043');
  assert.ok(issues.some(i => i.code === 'no_house_number'));
});

test('a normal address with a house number raises nothing', () => {
  const issues = addressShapeIssues('H.No 4-8-21, Vivekananda Nagar Colony, Kukatpally, Hyderabad 500072', '500072');
  assert.deepStrictEqual(issues, []);
});

test('an address ending on a separator is flagged as cut off', () => {
  const issues = addressShapeIssues('Flat 402, Sai Residency, Baner Road, Pune,', '');
  assert.ok(issues.some(i => i.code === 'address_truncated'));
});

test('a Hindi address with a house number is not flagged', () => {
  const issues = addressShapeIssues('मकान नंबर 27, गली नंबर 4, शास्त्री नगर, मेरठ 250004', '250004');
  assert.deepStrictEqual(issues, []);
});

/* -- phone --------------------------------------------------------------- */

test('a missing phone is critical', () => {
  assert.strictEqual(severityOf(phoneIssues(''), 'no_phone'), 'critical');
});

test('a 91-prefixed mobile is accepted', () => {
  // normalizeIndianPhone strips the country code; the audit must agree with the
  // pusher, or it would condemn every order the pusher ships happily.
  assert.deepStrictEqual(phoneIssues('919112223040'), []);
  assert.deepStrictEqual(phoneIssues('+91 91122 23040'), []);
});

test('a landline is flagged as not a mobile', () => {
  assert.strictEqual(severityOf(phoneIssues('0224567890'), 'bad_phone'), 'critical');
});

test('junk digits are reported as a bad number, not as a missing one', () => {
  // "12345" is not "no phone" -- the field is filled, it is just unusable, and
  // telling the admin the phone is missing sends them looking for the wrong fix.
  const issues = phoneIssues('12345');
  assert.strictEqual(severityOf(issues, 'bad_phone'), 'critical');
  assert.ok(issues[0].detail.includes('12345'));
});

/* -- pincode lookup ------------------------------------------------------ */

function withFetch(impl, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  return Promise.resolve().then(fn).finally(() => { globalThis.fetch = original; });
}

test('lookupPincode reads city and state out of one India Post response', async () => {
  await withFetch(async () => ({
    ok: true,
    json: async () => ([{ Status: 'Success', PostOffice: [{ District: 'Indore', State: 'Madhya Pradesh' }] }]),
  }), async () => {
    assert.deepStrictEqual(await lookupPincode('452008'), { found: true, city: 'Indore', state: 'Madhya Pradesh' });
  });
});

test('lookupPincode reports "no records found" as found:false, not as unknown', async () => {
  await withFetch(async () => ({ ok: true, json: async () => ([{ Status: 'No Records Found' }]) }), async () => {
    assert.strictEqual((await lookupPincode('999999')).found, false);
  });
});

test('a network failure is unknown, never a verdict', async () => {
  // The whole design rests on this: the audit must not invent a bad pincode out
  // of its own inability to reach India Post.
  await withFetch(async () => { throw new Error('ECONNRESET'); }, async () => {
    assert.strictEqual((await lookupPincode('452008')).found, null);
  });
  await withFetch(async () => ({ ok: false, json: async () => ({}) }), async () => {
    assert.strictEqual((await lookupPincode('452008')).found, null);
  });
  await withFetch(async () => ({ ok: true, json: async () => ({ unexpected: true }) }), async () => {
    assert.strictEqual((await lookupPincode('452008')).found, null);
  });
});

/* -- concurrency helper -------------------------------------------------- */

test('mapLimit preserves order and never exceeds the limit', async () => {
  let inFlight = 0, peak = 0;
  const out = await mapLimit([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
    inFlight++; peak = Math.max(peak, inFlight);
    await new Promise(r => setTimeout(r, 5));
    inFlight--;
    return n * 2;
  });
  assert.deepStrictEqual(out, [2, 4, 6, 8, 10, 12, 14]);
  assert.ok(peak <= 3, `peak concurrency was ${peak}`);
});

test('mapLimit on an empty list resolves rather than hanging', async () => {
  assert.deepStrictEqual(await mapLimit([], 5, async () => 1), []);
});
