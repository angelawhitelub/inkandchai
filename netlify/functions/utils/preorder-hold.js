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

/** A function order → hold or null, for checking many orders on one read of the books. Never throws. */
async function preorderChecker(db, now = Date.now()) {
  let live = null;
  try { live = await allReleases(db, now); }
  catch (e) { console.error('[preorder-hold] books unreadable, using the dates on the orders:', e.message); }
  return (order) => holdFromReleases(order, live, now);
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

module.exports = { holdFromReleases, preorderChecker, splitHeld, titleKey };
