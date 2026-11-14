'use strict';

/**
 * Shipping holidays: dates the owner has closed dispatch (owner, 6 Nov 2026).
 * Product pages skip them when they work out the ship-by date
 * (public/js/ship-holidays.js).
 *
 * A short hand-kept list, so it lives in one blob (KV key `catalog:ship-holidays`
 * on the Worker), rewritten whole on every change. No SQL migration.
 */

const STORE = 'catalog';
const KEY = 'ship-holidays';
const MAX_RANGES = 60;
const MAX_DAYS = 90;
const DAY_MS = 86400000;
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

// Required here so the pure helpers load in the Worker's page code and in tests.
const store = () => require('@netlify/blobs').getStore(STORE);

const todayISO = (now = Date.now()) => new Date(now + IST_OFFSET_MS).toISOString().slice(0, 10);

function realDate(value) {
  const s = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s ? s : null;
}

/** A checked { from, to, note }, or { error } saying what to fix. `to` may be left out. */
function cleanHoliday(input, now = Date.now()) {
  const from = realDate(input && input.from);
  if (!from) return { error: 'Pick the first day of the holiday.' };
  const rawTo = String((input && input.to) || '').trim();
  const to = rawTo ? realDate(rawTo) : from;
  if (!to) return { error: 'The last day is not a real date.' };
  if (to < from) return { error: 'The last day is before the first day.' };
  if (to < todayISO(now)) return { error: 'That holiday is already over.' };
  const days = (Date.parse(to) - Date.parse(from)) / DAY_MS + 1;
  if (days > MAX_DAYS) return { error: `One holiday can be at most ${MAX_DAYS} days. Check the dates.` };
  return { from, to, note: String((input && input.note) || '').trim().slice(0, 80) };
}

/** Holidays not yet over, earliest first. */
function upcoming(items, now = Date.now()) {
  const today = todayISO(now);
  return (Array.isArray(items) ? items : [])
    .filter((h) => h && realDate(h.from) && realDate(h.to) && h.to >= today)
    .sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
}

/** What the Worker adds to a product page while a holiday is ahead; '' otherwise. */
function shipHolidayTags(items, now = Date.now()) {
  const list = upcoming(items, now).map((h) => ({ from: h.from, to: h.to }));
  if (!list.length) return '';
  return `<script>window.__iacShipHolidays=${JSON.stringify(list)};</script><script src="/js/ship-holidays.js?v=20261114"></script>`;
}

async function readHolidays(now = Date.now()) {
  const doc = await store().get(KEY, { type: 'json' });
  return upcoming(doc && doc.items, now);
}

async function write(items) {
  await store().setJSON(KEY, { items, updated_at: new Date().toISOString() });
  return items;
}

async function addHoliday(input, now = Date.now()) {
  const holiday = cleanHoliday(input, now);
  if (holiday.error) return holiday;
  const items = await readHolidays(now);
  if (items.some((h) => h.from === holiday.from && h.to === holiday.to)) return { items };
  if (items.length >= MAX_RANGES) return { error: `At most ${MAX_RANGES} holidays. Remove one first.` };
  return { items: await write(upcoming([...items, holiday], now)) };
}

async function removeHoliday({ from, to }, now = Date.now()) {
  const items = await readHolidays(now);
  return { items: await write(items.filter((h) => !(h.from === from && h.to === to))) };
}

module.exports = { STORE, KEY, cleanHoliday, upcoming, shipHolidayTags, readHolidays, addHoliday, removeHoliday, todayISO };
