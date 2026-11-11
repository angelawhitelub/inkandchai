'use strict';

/**
 * Pre-orders stay out of every courier panel until their publish date arrives
 * (owner, 6 Nov 2026). Whichever button or job is about to send an order to a
 * courier asks here first; there is no override. If stock arrives early, the
 * owner changes the book's "Published" date to today and the order is free.
 *
 * The book's date as it stands NOW decides, because the owner can move it after
 * the order was placed. The `_release` stamped on the order line by utils/pricing
 * is only the fallback for when the books cannot be read, or the line (a WhatsApp
 * order) has neither a slug nor a title that can be matched.
 *
 * A whole order waits for its latest book: checkout tells the customer the order
 * ships together once it releases.
 */

const { allReleases, isUpcoming } = require('./release-date');
const { shipByDate, isoDay } = require('./delivery-eta');

/*
 * Handling time (owner, 11 Nov 2026): "orders should not be pushed to xb or np
 * until handover date arrives." A book with extra handling days in the product
 * editor (product_settings.handling_days) promises a later "Ships by" date on
 * its page; the order stays out of every courier panel until that day (IST).
 * The handover date is the same rule the page shows: delivery-eta shipByDate
 * from the moment the order was placed, plus the book's handling days. Only
 * books with handling days set are held; everything else ships as before.
 */

function linesOf(order) {
  let items = order && order.cart_items;
  if (typeof items === 'string') { try { items = JSON.parse(items); } catch { items = []; } }
  return Array.isArray(items) ? items.filter((i) => i && typeof i === 'object' && !i._payment) : [];
}

function slugOf(item) {
  const direct = String(item.slug || '').trim().toLowerCase();
  if (direct) return direct;
  const m = /\/product\/([^/?#]+)/i.exec(String(item.url || item.id || ''));
  return m ? m[1].toLowerCase() : '';
}

/** "The Law of the Sublime" → "the-law-of-the-sublime", the way slugs start. */
const titleKey = (title) => String(title || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
// Short titles would match unrelated books' slugs.
const MIN_TITLE_KEY = 8;

function when(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

/**
 * Pure: why this order must wait, or null.
 * @param live { slug: 'YYYY-MM-DD' } books still ahead of their date, or null when
 *             they could not be read.
 */
function holdFromReleases(order, live, now = Date.now()) {
  const slugs = live ? Object.keys(live) : [];
  const waiting = [];
  for (const item of linesOf(order)) {
    const slug = slugOf(item);
    let iso = null;
    if (live && slug) {
      iso = live[slug] || null;
    } else if (live) {
      const key = titleKey(item.title);
      const hit = key.length >= MIN_TITLE_KEY ? slugs.find((s) => s === key || s.startsWith(`${key}-`)) : null;
      iso = hit ? live[hit] : (isUpcoming(item._release, now) ? item._release : null);
    } else if (isUpcoming(item._release, now)) {
      iso = item._release;
    }
    if (iso) waiting.push({ iso, title: String(item.title || slug || 'a book') });
  }
  if (!waiting.length) return null;
  const release = waiting.map((w) => w.iso).sort().pop();
  const titles = [...new Set(waiting.map((w) => w.title))];
  return {
    kind: 'preorder',
    release,
    titles,
    reason: `pre-order: not sent to any courier before ${when(release)} (${titles.join(', ')})`,
  };
}

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const todayIST = (now) => new Date(now + IST_OFFSET_MS).toISOString().slice(0, 10);

/** Handover day 'YYYY-MM-DD' (IST) for an order placed at `placedAt` with `days` extra handling. */
function handoverISO(placedAt, days) {
  const t = Date.parse(placedAt);
  if (!Number.isFinite(t)) return null;
  return isoDay(shipByDate(t, Math.max(0, Number(days) || 0)));
}

/**
 * Pure: why this order must wait for its handling time, or null.
 * @param handling { slug: days } books with extra handling days set, or null
 *                 when they could not be read (then the order's own stamps).
 */
function holdFromHandling(order, handling, now = Date.now()) {
  const slugs = handling ? Object.keys(handling) : [];
  let days = 0;
  const titles = [];
  for (const item of linesOf(order)) {
    const slug = slugOf(item);
    // The book's setting as it stands now decides; `_handling_days` stamped at
    // checkout (utils/pricing) is the fallback when settings could not be read.
    let d = !handling ? item._handling_days : (slug ? handling[slug] : undefined);
    if (handling && d === undefined && !slug) {
      const key = titleKey(item.title);
      const hit = key.length >= MIN_TITLE_KEY ? slugs.find((s) => s === key || s.startsWith(`${key}-`)) : null;
      if (hit) d = handling[hit];
    }
    if (Number(d) > 0) {
      days = Math.max(days, Number(d));
      titles.push(`${String(item.title || slug || 'a book')} +${d} day${Number(d) === 1 ? '' : 's'}`);
    }
  }
  if (!days) return null;
  const handover = handoverISO(order && order.created_at, days);
  if (!handover || todayIST(now) >= handover) return null;
  return {
    kind: 'handling',
    release: handover,
    titles,
    reason: `handling time: not sent to any courier before ${when(handover)} (${[...new Set(titles)].join(', ')})`,
  };
}

/** { slug: days } for every book with extra handling days. Throws on a read error. */
async function allHandling(db) {
  const out = {};
  for (let from = 0; from < 50000; from += 1000) {
    const { data, error } = await db.from('product_settings').select('slug,handling_days')
      .not('handling_days', 'is', null).gt('handling_days', 0).order('slug').range(from, from + 999);
    if (error) {
      if (/product_settings/.test(error.message || '') && /does not exist|could not find/i.test(error.message || '')) return out;
      throw new Error(error.message);
    }
    for (const r of data || []) {
      const d = Math.min(30, Math.round(Number(r.handling_days) || 0));
      if (r.slug && d > 0) out[String(r.slug).toLowerCase()] = d;
    }
    if (!data || data.length < 1000) break;
  }
  return out;
}

/**
 * A function order → hold or null, for checking many orders on one read of the
 * books. Pre-orders first, then handling time. Never throws: if the books
 * cannot be read, both rules fall back to what checkout stamped on the order.
 */
async function preorderChecker(db, now = Date.now()) {
  let live = null;
  try { live = await allReleases(db, now); }
  catch (e) { console.error('[preorder-hold] books unreadable, using the dates on the orders:', e.message); }
  let handling = null;
  try { handling = await allHandling(db); }
  catch (e) { console.error('[preorder-hold] handling days unreadable, using the days on the orders:', e.message); }
  return (order) => holdFromReleases(order, live, now) || holdFromHandling(order, handling, now);
}

/** Splits orders into those free to go and those waiting: { free, held: [{ order, ...hold }] }. */
function splitHeld(orders, holdFor) {
  const free = [];
  const held = [];
  for (const order of orders || []) {
    const hold = holdFor(order);
    if (hold) held.push({ order, ...hold }); else free.push(order);
  }
  return { free, held };
}

module.exports = { holdFromReleases, holdFromHandling, handoverISO, allHandling, preorderChecker, splitHeld, titleKey };
