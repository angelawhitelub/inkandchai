'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./ship-holidays');
const page = require('../../../public/js/ship-holidays.js');
const release = require('../../../public/js/release-date.js');

// 6 Nov 2026, 12:00 IST: past the 03:00 cutoff, so normal dispatch is 7 Nov.
const NOON = Date.parse('2026-11-06T06:30:00Z');
const DAY = 86400000;
const iso = (dayNum) => new Date(dayNum * DAY).toISOString().slice(0, 10);

test('no holiday leaves the date alone', () => {
  const p = page.plan(NOON, 0, []);
  assert.equal(iso(p.ship), '2026-11-07');
  assert.equal(p.moved, false);
  assert.equal(p.extra, 0);
});

test('a holiday on the dispatch day moves it to the next open day', () => {
  const p = page.plan(NOON, 0, [{ from: '2026-11-07', to: '2026-11-08' }]);
  assert.equal(iso(p.ship), '2026-11-09');
  assert.equal(p.moved, true);
  assert.equal(p.closedNow, true);
  assert.equal(p.extra, 2, 'the pincode estimate moves by the same days');
  assert.match(page.subLine(p), /resumes on/);
});

test('a holiday next week changes nothing today', () => {
  assert.equal(page.plan(NOON, 0, [{ from: '2026-11-14', to: '2026-11-16' }]).moved, false);
});

test('handling days count open days only', () => {
  const p = page.plan(NOON, 2, [{ from: '2026-11-08', to: '2026-11-08' }]);
  assert.equal(iso(p.ship), '2026-11-10');
  assert.equal(p.moved, true);
  assert.equal(p.closedNow, false);
  assert.equal(page.subLine(p), '');
});

test('handling that clears the holiday is not moved', () => {
  assert.equal(page.plan(NOON, 1, [{ from: '2026-11-20', to: '2026-11-21' }]).moved, false);
});

test('back-to-back and overlapping holidays are all skipped', () => {
  const p = page.plan(NOON, 0, [{ from: '2026-11-07', to: '2026-11-08' }, { from: '2026-11-09', to: '2026-11-09' }, { from: '2026-11-08', to: '2026-11-10' }]);
  assert.equal(iso(p.ship), '2026-11-11');
});

test('before the 03:00 cutoff dispatch is today, and a holiday today moves it', () => {
  const early = Date.parse('2026-11-05T20:00:00Z'); // 01:30 IST on the 6th
  assert.equal(iso(page.plan(early, 0, []).ship), '2026-11-06');
  assert.equal(iso(page.plan(early, 0, [{ from: '2026-11-06', to: '2026-11-06' }]).ship), '2026-11-07');
});

test('a malformed entry cannot break the page', () => {
  assert.equal(page.plan(NOON, 0, [null, {}, { from: 'soon', to: 'later' }, { from: '2026-11-09', to: '2026-11-07' }]).moved, false);
});

test('a pre-order released on a holiday ships on the next open day, with the estimate moved too', () => {
  globalThis.__iacShipHolidays = [{ from: '2026-11-10', to: '2026-11-11' }];
  try {
    const p = release.plan('2026-11-10', 0, NOON);
    assert.equal(iso(p.ship), '2026-11-12');
    assert.equal(p.extra, 5);
    assert.equal(p.holiday, true);
  } finally { delete globalThis.__iacShipHolidays; }
  const plain = release.plan('2026-11-10', 0, NOON);
  assert.equal(iso(plain.ship), '2026-11-10');
  assert.equal(plain.holiday, false);
});

test('admin dates are checked', () => {
  const ok = H.cleanHoliday({ from: '2026-11-08', note: ' Bhai Dooj ' }, NOON);
  assert.deepEqual(ok, { from: '2026-11-08', to: '2026-11-08', note: 'Bhai Dooj' });
  assert.match(H.cleanHoliday({}, NOON).error, /first day/);
  assert.match(H.cleanHoliday({ from: '2026-02-31' }, NOON).error, /first day/);
  assert.match(H.cleanHoliday({ from: '2026-11-08', to: '2026-11-07' }, NOON).error, /before/);
  assert.match(H.cleanHoliday({ from: '2026-11-01', to: '2026-11-02' }, NOON).error, /over/);
  assert.match(H.cleanHoliday({ from: '2026-11-08', to: '2027-11-08' }, NOON).error, /at most/);
});

test('the page gets dates only, nothing once every holiday is over', () => {
  assert.equal(H.shipHolidayTags([], NOON), '');
  assert.equal(H.shipHolidayTags([{ from: '2026-11-01', to: '2026-11-02', note: 'x' }], NOON), '');
  const tags = H.shipHolidayTags([{ from: '2026-11-08', to: '2026-11-08', note: '</script>secret' }], NOON);
  assert.match(tags, /2026-11-08/);
  assert.match(tags, /\/js\/ship-holidays\.js/);
  assert.doesNotMatch(tags, /secret/);
});

test('a holiday still running today stays on the list; it goes once over, and the list is sorted', () => {
  const list = H.upcoming([{ from: '2026-11-20', to: '2026-11-20' }, { from: '2026-11-05', to: '2026-11-06' }, { from: '2026-11-01', to: '2026-11-05' }], NOON);
  assert.deepEqual(list.map((h) => h.from), ['2026-11-05', '2026-11-20']);
});
