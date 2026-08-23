const test = require('node:test');
const assert = require('node:assert');
const { parseCourierTime, courierTimeToIso } = require('../../netlify/functions/utils/courier-time');

test('the documented NimbusPost format is read as IST', () => {
  // From the payload sample in nimbuspost-webhook.js.
  assert.strictEqual(parseCourierTime('2021-02-26 16:19:59').toISOString(), '2021-02-26T10:49:59.000Z');
});

test('reproduces the 24 Aug batch at its real wall-clock time', () => {
  // Stored as 2026-08-24T00:45:06Z; actually 00:45 IST = 19:15 UTC the day before.
  assert.strictEqual(parseCourierTime('2026-08-24 00:45:06').toISOString(), '2026-08-23T19:15:06.000Z');
});

test('does NOT depend on the host timezone', () => {
  // The whole bug was inheriting the server's zone. Same answer either way.
  const original = process.env.TZ;
  const seen = new Set();
  for (const tz of ['UTC', 'Asia/Kolkata', 'America/New_York', 'Pacific/Auckland']) {
    process.env.TZ = tz;
    seen.add(parseCourierTime('2026-08-24 00:45:06').toISOString());
  }
  if (original === undefined) delete process.env.TZ; else process.env.TZ = original;
  assert.strictEqual(seen.size, 1, `host timezone changed the result: ${[...seen].join(' vs ')}`);
  assert.strictEqual([...seen][0], '2026-08-23T19:15:06.000Z');
});

test('never double-shifts a timestamp that already carries a zone', () => {
  assert.strictEqual(parseCourierTime('2026-08-24T00:45:06Z').toISOString(), '2026-08-24T00:45:06.000Z');
  assert.strictEqual(parseCourierTime('2026-08-24T00:45:06+05:30').toISOString(), '2026-08-23T19:15:06.000Z');
  assert.strictEqual(parseCourierTime('2026-08-24T00:45:06+0530').toISOString(), '2026-08-23T19:15:06.000Z');
  assert.strictEqual(parseCourierTime('2026-08-23T19:15:06.000Z').toISOString(), '2026-08-23T19:15:06.000Z');
});

test('handles the T separator and missing seconds', () => {
  assert.strictEqual(parseCourierTime('2026-08-24T00:45:06').toISOString(), '2026-08-23T19:15:06.000Z');
  assert.strictEqual(parseCourierTime('2026-08-24 00:45').toISOString(), '2026-08-23T19:15:00.000Z');
});

test('accepts epoch seconds and milliseconds', () => {
  assert.strictEqual(parseCourierTime(1756000000).toISOString(), new Date(1756000000000).toISOString());
  assert.strictEqual(parseCourierTime(1756000000000).toISOString(), new Date(1756000000000).toISOString());
});

test('returns null on junk rather than a wrong date', () => {
  for (const bad of [null, undefined, '', '   ', 'not-a-date', {}, []]) {
    assert.strictEqual(parseCourierTime(bad), null, `${JSON.stringify(bad)} should be null`);
  }
});

test('courierTimeToIso falls back to now, and can be told not to', () => {
  const iso = courierTimeToIso('rubbish');
  assert.ok(Math.abs(Date.now() - Date.parse(iso)) < 5000);
  assert.strictEqual(courierTimeToIso('rubbish', { fallbackToNow: false }), null);
});

test('a parsed courier event is never in the future', () => {
  // The symptom that exposed this: 210 orders dated ahead of now.
  const nowIst = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');
  assert.ok(parseCourierTime(nowIst).getTime() <= Date.now() + 1000);
});
