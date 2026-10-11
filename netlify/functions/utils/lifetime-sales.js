'use strict';

/**
 * Lifetime units sold per book, for the homepage "Reader Bestsellers" badges
 * and the "🔥 N sold" line on product pages (owner's request, 12 Oct 2026; the
 * badges used to count this month only).
 *
 * Built hourly by lifetime-sales-scheduled over every order that was actually
 * placed and not cancelled, and published to KV (store "catalog", key
 * "lifetime-sales") for homepage-merchandising and the Worker to read.
 *
 * Counted: placed orders in SOLD_STATUSES. Not counted: cancelled, refunded,
 * RTO, unpaid PhonePe attempts, and free replacements (the same book sent
 * again is not a second sale).
 */

const { isReplacementOrder } = require('./missing-books');
const { proxifySupabaseImage } = require('./supabase-img');

// Lazy: @netlify/blobs exists only as the Worker's KV shim.
const store = () => require('@netlify/blobs').getStore(STORE);
const STORE = 'catalog';
const KEY = 'lifetime-sales';
const SOLD_STATUSES = [
  'paid', 'confirmed', 'processing', 'pickup_scheduled', 'shipped', 'in_transit',
  'out_for_delivery', 'delivered', 'cod_pending', 'partial_cod_pending', 'partial_cod',
];
// A product page shows its count from here; below it, "3 sold" reads as unpopular.
const SHOW_ON_PAGE_MIN = 10;
const TOP_N = 24;

const titleKey = (v) => String(v || '').toLowerCase().normalize('NFKD')
  .replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

function slugOf(item) {
  const direct = String(item && item.slug || '').trim();
  if (direct) return direct.toLowerCase();
  const m = String(item && (item.url || item.id) || '').match(/\/product\/([^/?#]+)/i);
  if (!m) return '';
  try { return decodeURIComponent(m[1]).toLowerCase(); } catch { return m[1].toLowerCase(); }
}

function cartOf(order) {
  let cart = order && order.cart_items;
  if (typeof cart === 'string') { try { cart = JSON.parse(cart); } catch { cart = []; } }
  return Array.isArray(cart) ? cart : [];
}

/** A running count; feed it pages of orders with addOrders, then finishTally. */
function newTally() {
  return { counts: new Map(), info: new Map(), orders: 0 };
}

/** Cart lines with no slug are matched by title through `slugByTitle`. */
function addOrders(tally, orders, { slugByTitle = new Map() } = {}) {
  for (const order of orders || []) {
    if (isReplacementOrder(order) || /^IC-R-/i.test(String(order && order.razorpay_order_id || ''))) continue;
    tally.orders += 1;
    for (const item of cartOf(order)) {
      const title = String(item && (item.title || item.name) || '').trim();
      const slug = slugOf(item) || slugByTitle.get(titleKey(title)) || '';
      if (!slug) continue;
      const qty = Math.max(1, Math.floor(Number(item.qty) || 1));
      tally.counts.set(slug, (tally.counts.get(slug) || 0) + qty);
      // The newest line describes the book best (orders are read oldest first).
      tally.info.set(slug, {
        slug, title, author: String(item.author || ''),
        url: `/product/${encodeURIComponent(slug)}/`,
        img: proxifySupabaseImage(String(item.img || '')),
        price: Number(item.price) || 0,
      });
    }
  }
  return tally;
}

/** { counts: { slug: units }, top: [{ slug, title, author, url, img, price, qty }] } */
function finishTally(tally) {
  const top = [...tally.counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, TOP_N)
    .map(([slug, qty]) => ({ ...tally.info.get(slug), qty }));
  return { counts: Object.fromEntries(tally.counts), top, orders: tally.orders };
}

/** Pure, all at once. */
function countLifetimeSales(orders, opts) {
  return finishTally(addOrders(newTally(), orders, opts));
}

async function publishLifetimeSales(doc) {
  await store().setJSON(KEY, { ...doc, updated_at: new Date().toISOString() });
}

const TTL_MS = 10 * 60_000;
let _doc = null;
let _at = 0;
/** The published document, cached per isolate. null when never published or unreadable. */
async function readLifetimeSales() {
  if (_doc && Date.now() - _at < TTL_MS) return _doc;
  try {
    const doc = await store().get(KEY, { type: 'json' });
    if (doc && doc.counts) { _doc = doc; _at = Date.now(); }
  } catch (err) {
    console.warn('[lifetime-sales] read failed:', err.message);
  }
  return _doc;
}

/** The product-page line, or '' below the threshold. */
function soldLine(units) {
  const n = Math.floor(Number(units) || 0);
  if (n < SHOW_ON_PAGE_MIN) return '';
  return `<div class="sold-count" style="display:inline-flex;align-items:center;gap:.35rem;margin:.35rem 0 .2rem;padding:.3rem .7rem;`
    + `border-radius:999px;background:#fff4e5;color:#9a4b00;font-size:.85rem;font-weight:600;">🔥 ${n.toLocaleString('en-IN')} sold</div>`;
}

module.exports = {
  countLifetimeSales, newTally, addOrders, finishTally, publishLifetimeSales, readLifetimeSales, soldLine, titleKey,
  SOLD_STATUSES, SHOW_ON_PAGE_MIN, STORE, KEY,
};
