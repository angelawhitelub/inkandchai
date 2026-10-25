const { test } = require('node:test');
const assert = require('node:assert/strict');
const R = require('./release-date');
const page = require('../../../public/js/release-date.js');

// 26 Oct 2026, 10:00 IST and 01:00 IST (before the 03:00 manifest cutoff).
const MORNING = Date.parse('2026-10-26T04:30:00Z');
const NIGHT = Date.parse('2026-10-25T19:30:00Z');

test('only a full date counts as a release date', () => {
  for (const s of ['27 October 2026', '27th Oct, 2026', 'October 27, 2026', 'Oct 27 2026', '2026-10-27', '27/10/2026', '27-10-2026', '27.10.2026'])
    assert.equal(R.parseReleaseDate(s), '2026-10-27', s);
  assert.equal(R.parseReleaseDate('Sept 3 2026'), '2026-09-03');
  for (const s of ['March 2024', '2024', 'Reprint 2019', '31 February 2026', '27 Octx 2026', '', null, undefined])
    assert.equal(R.parseReleaseDate(s), null, String(s));
});

test('upcoming is judged by the IST day', () => {
  assert.equal(R.upcomingRelease('27 October 2026', MORNING), '2026-10-27');
  assert.equal(R.upcomingRelease('26 October 2026', MORNING), null);   // release day = released
  assert.equal(R.upcomingRelease('1 January 2020', MORNING), null);
  assert.equal(R.upcomingRelease('March 2027', MORNING), null);
  // 23:30 UTC on the 25th is already the 26th in India.
  assert.equal(R.upcomingRelease('26 October 2026', Date.parse('2026-10-25T23:30:00Z')), null);
});

test('releaseScriptTags carries the date safely', () => {
  const html = R.releaseScriptTags('2026-11-05');
  assert.match(html, /window\.__iacRelease="2026-11-05"/);
  assert.match(html, /src="\/js\/release-date\.js/);
});

const day = (iso) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / 86400000;

test('page plan: ships on release day, plus handling time', () => {
  const p = page.plan('2026-11-05', 0, MORNING);
  assert.equal(p.ship, day('2026-11-05'));
  assert.equal(p.extra, day('2026-11-05') - day('2026-10-27')); // normal dispatch after cutoff = tomorrow
  const h = page.plan('2026-11-05', 2, MORNING);
  assert.equal(h.ship, day('2026-11-07'));
  assert.equal(h.extra, p.extra + 2);
  assert.equal(h.handling, 2);
});

test('page plan: before the cutoff the normal dispatch day is today', () => {
  const p = page.plan('2026-11-05', 0, NIGHT);
  assert.equal(p.extra, day('2026-11-05') - day('2026-10-26'));
});

test('page plan: a release tomorrow never ships before the normal dispatch day', () => {
  const p = page.plan('2026-10-27', 1, MORNING);
  assert.equal(p.daysToRelease, 1);
  assert.equal(p.ship, day('2026-10-28'));
  assert.equal(p.extra, 1);
});

test('page plan: released or unparseable dates leave the page alone', () => {
  assert.equal(page.plan('2026-10-26', 0, MORNING), null);
  assert.equal(page.plan('27 October 2026', 0, MORNING), null);
  assert.equal(page.plan(undefined, 0, MORNING), null);
});

test('the page formats the release day with weekday and year', () => {
  assert.equal(page.fmt(day('2026-10-27'), 'long'), 'Tuesday, 27 October 2026');
});
