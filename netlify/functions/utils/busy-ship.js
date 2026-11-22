'use strict';

/**
 * High-demand dispatch delay (owner, 20 Nov 2026): when more than 100 copies of (50 until 23 Nov)
 * one book are ordered -- across many orders or in one -- its product page
 * shows the Ships-by date one day later.
 *
 * "Ordered" = placed, not-cancelled orders (lifetime-sales SOLD_STATUSES,
 * free replacements left out) created in the last 24 hours. busy-ship-scheduled
 * recounts every 15 minutes and publishes { slugs: { slug: units } } to KV
 * (store "catalog", key "busy-ship"); the Worker reads it on every product page
 * and public/js/ship-holidays.js moves the date. Display only: booking,
 * handling-time holds and the till are untouched.
 */

const { newTally, addOrders, SOLD_STATUSES } = require('./lifetime-sales');

const STORE = 'catalog';
const KEY = 'busy-ship';
const THRESHOLD = 100;         // more than this many units → +1 day (owner raised 50 → 100 on 23 Nov 2026)
const EXTRA_DAYS = 1;
const WINDOW_MS = 24 * 3600 * 1000;

const store = () => require('@netlify/blobs').getStore(STORE);

/** Pure: { slug: units } for the books ordered more than THRESHOLD times in `orders`. */
function busyFromOrders(orders, { threshold = THRESHOLD } = {}) {
  const tally = addOrders(newTally(), orders || []);
  const out = {};
  for (const [slug, units] of tally.counts) if (units > threshold) out[slug] = units;
  return out;
}

/** The tags the Worker adds to a busy book's page; '' when the book is not busy. */
function busyShipTag(doc, slug) {
  const s = String(slug || '').toLowerCase();
  if (!doc || !doc.slugs || !s || !Object.prototype.hasOwnProperty.call(doc.slugs, s)) return '';
  return `<script>window.__iacBusyShipDays=${EXTRA_DAYS};</script>`;
}

async function publishBusy(slugs, now = Date.now()) {
  await store().setJSON(KEY, {
    slugs, threshold: THRESHOLD, extra_days: EXTRA_DAYS, window_hours: WINDOW_MS / 3600000,
    updated_at: new Date(now).toISOString(),
  });
}

module.exports = { STORE, KEY, THRESHOLD, EXTRA_DAYS, WINDOW_MS, SOLD_STATUSES, busyFromOrders, busyShipTag, publishBusy };
