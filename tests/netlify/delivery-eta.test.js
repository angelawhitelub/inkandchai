'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { shipByDate, parseEdd, pickEdd, isoDay, addDays, cacheSeconds } =
  require('../../netlify/functions/utils/delivery-eta');

// 2026-09-03 in IST, at chosen IST hours (IST = UTC+5:30).
function ist(hour) { return Date.UTC(2026, 8, 3, hour, 0) - 5.5 * 3600 * 1000; }

test('before the 03:00 IST cutoff the parcel still ships today', () => {
  assert.strictEqual(isoDay(shipByDate(ist(2))), '2026-09-03');
  assert.strictEqual(isoDay(shipByDate(ist(0))), '2026-09-03');
});

test('from 03:00 IST it waits for the next manifest', () => {
  assert.strictEqual(isoDay(shipByDate(ist(3))), '2026-09-04');
  assert.strictEqual(isoDay(shipByDate(ist(23))), '2026-09-04');
});

test('a limited-stock title adds a picking day on top', () => {
  assert.strictEqual(isoDay(shipByDate(ist(2), 1)), '2026-09-04');
  assert.strictEqual(isoDay(shipByDate(ist(10), 1)), '2026-09-05');
});

test("NimbusPost's DD-MM-YYYY is parsed, and nothing else is", () => {
  assert.strictEqual(isoDay(parseEdd('07-09-2026')), '2026-09-07');
  assert.strictEqual(isoDay(parseEdd('11-09-2026')), '2026-09-11');
  for (const bad of ['2026-09-07', '7-9-2026', '', null, undefined, 'soon', '07/09/2026']) {
    assert.strictEqual(parseEdd(bad), null, String(bad));
  }
});

test('an impossible date is rejected rather than silently rolled over', () => {
  // new Date(2026, 1, 31) quietly becomes 3 March. That must never reach a
  // customer as a delivery promise.
  assert.strictEqual(parseEdd('31-02-2026'), null);
  assert.strictEqual(parseEdd('32-01-2026'), null);
  assert.strictEqual(parseEdd('01-13-2026'), null);
});

test('the median courier is quoted, not the most optimistic one', () => {
  const shipBy = shipByDate(ist(2));            // ships 03 Sep
  const couriers = [
    { edd: '05-09-2026' },                       // one fast outlier
    { edd: '07-09-2026' },
    { edd: '07-09-2026' },
    { edd: '09-09-2026' },
    { edd: '09-09-2026' },
  ];
  assert.strictEqual(isoDay(pickEdd(couriers, shipBy)), '2026-09-07');
});

test('a courier EDD earlier than our own dispatch is floored to the next day', () => {
  const shipBy = shipByDate(ist(10));           // ships 04 Sep
  // A courier claiming delivery on the 1st is a data error, not a time machine.
  assert.strictEqual(isoDay(pickEdd([{ edd: '01-09-2026' }], shipBy)), '2026-09-05');
});

test('unparseable EDDs yield no date at all rather than a guess', () => {
  const shipBy = shipByDate(ist(2));
  assert.strictEqual(pickEdd([{ edd: 'n/a' }, { edd: '' }, {}], shipBy), null);
  assert.strictEqual(pickEdd([], shipBy), null);
  assert.strictEqual(pickEdd(null, shipBy), null);
});

test('one good EDD among junk still answers', () => {
  const shipBy = shipByDate(ist(2));
  assert.strictEqual(isoDay(pickEdd([{ edd: 'n/a' }, { edd: '08-09-2026' }, {}], shipBy)), '2026-09-08');
});

test('the cache expires when the IST date rolls over, never across it', () => {
  // A delivery date cached past midnight IST is wrong by a whole day.
  const lateEvening = cacheSeconds(ist(23));
  assert.ok(lateEvening <= 90 * 60, `${lateEvening}s at 23:00 IST spans midnight`);
  assert.ok(lateEvening >= 60);
  // Early in the day it is capped by the six-hour ceiling, not by midnight.
  assert.strictEqual(cacheSeconds(ist(9)), 21600);
  assert.ok(cacheSeconds(ist(20)) < 21600);
});

test('a dispatch delay pushes delivery back, it is not absorbed', () => {
  // Regression: with extra_days the ship date moved but the courier EDD did
  // not, so a limited-stock title was quoted the same delivery date as a
  // normal one — a promise we could not keep.
  const normal  = shipByDate(ist(10), 0);
  const delayed = shipByDate(ist(10), 1);
  assert.strictEqual(isoDay(normal), '2026-09-04');
  assert.strictEqual(isoDay(delayed), '2026-09-05');
  const eddNormal = pickEdd([{ edd: '07-09-2026' }], normal);
  const eddDelayed = pickEdd([{ edd: '07-09-2026' }], delayed);
  // pickEdd itself only floors; the handler adds the shift, so transit stays
  // constant only once that shift is applied.
  assert.strictEqual(isoDay(eddNormal), '2026-09-07');
  assert.strictEqual(isoDay(addDays(eddDelayed, 1)), '2026-09-08');
});
