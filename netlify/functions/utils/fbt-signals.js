/**
 * "Frequently bought together" from real orders: which books customers bought
 * in the SAME order, and units sold, over the last year.
 *
 * Built in the hourly lifetime-sales-scheduled pass (it already reads every
 * sold order, so this costs no extra database reads) and kept in KV
 * `catalog:fbt-signals`. frequently-bought.js reads it.
 *
 * It replaces data/fbt-signals.json, which scripts/build-fbt-signals.js wrote
 * at Netlify build time. Cloudflare deploys never ran that script, so from
 * September 2026 the file was empty and product pages showed similar books
 * only, never real co-purchases.
 *
 * Rules (same as the old build script):
 *   - kept sales only (the caller reads SOLD_STATUSES); replacements skipped
 *   - a cart line without a link is matched to a book by its title
 *   - an order with more than 6 distinct books is a bulk order: it counts for
 *     units sold but not for pairs (one 20-book order makes 190 pairs)
 *   - a pair needs 2+ separate orders; one co-purchase is noise
 *   - each book keeps its 8 strongest partners
 */

const { isReplacementOrder } = require('./missing-books');
const { slugOf, cartOf, titleKey } = require('./lifetime-sales');

const STORE = 'catalog';
const KEY = 'fbt-signals';
const WINDOW_DAYS = 365;
const MAX_BASKET_FOR_PAIRS = 6;
const MIN_PAIR = 2;
const PARTNERS_KEPT = 8;
const BESTSELLERS_KEPT = 600;

const store = () => require('@netlify/blobs').getStore(STORE);

function newPairTally(now = Date.now()) {
  return { since: now - WINDOW_DAYS * 86400000, orders: 0, baskets: 0, units: new Map(), co: new Map() };
}

/** Feed pages of sold orders (any order); only the last WINDOW_DAYS count. */
function addBaskets(t, orders, { slugByTitle = new Map() } = {}) {
  for (const order of orders || []) {
    if (Date.parse(order && order.created_at) < t.since) continue;
    if (isReplacementOrder(order) || /^IC-R-/i.test(String(order && order.razorpay_order_id || ''))) continue;
    t.orders += 1;
    const slugs = new Set();
    for (const item of cartOf(order)) {
      const title = String(item && (item.title || item.name) || '').trim();
      const slug = slugOf(item) || slugByTitle.get(titleKey(title)) || '';
      if (!slug) continue;
      slugs.add(slug);
      t.units.set(slug, (t.units.get(slug) || 0) + Math.max(1, Math.floor(Number(item.qty) || 1)));
    }
    if (!slugs.size) continue;
    t.baskets += 1;
    if (slugs.size < 2 || slugs.size > MAX_BASKET_FOR_PAIRS) continue;
    const list = [...slugs].sort();
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const k = list[i] + ' ' + list[j];
        t.co.set(k, (t.co.get(k) || 0) + 1);
      }
    }
  }
  return t;
}

/** The document frequently-bought.js reads: { pairs: { slug: [[partner, n], …] }, bestsellers: [[slug, units], …] }. */
function finishPairs(t) {
  const pairs = {};
  for (const [k, n] of t.co) {
    if (n < MIN_PAIR) continue;
    const [a, b] = k.split(' ');
    (pairs[a] = pairs[a] || []).push([b, n]);
    (pairs[b] = pairs[b] || []).push([a, n]);
  }
  for (const s of Object.keys(pairs)) {
    pairs[s].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]));
    pairs[s] = pairs[s].slice(0, PARTNERS_KEPT);
  }
  const bestsellers = [...t.units.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, BESTSELLERS_KEPT);
  return {
    generated_at: new Date().toISOString(), window_days: WINDOW_DAYS,
    orders: t.orders, baskets: t.baskets, products_sold: t.units.size,
    products_with_partners: Object.keys(pairs).length, bestsellers, pairs,
  };
}

async function publishSignals(doc) {
  await store().setJSON(KEY, doc);
}

// Read once per isolate per half hour; the data changes hourly at most.
const TTL_MS = 30 * 60_000;
let cached = null;
let cachedAt = 0;
async function readSignals() {
  if (cached && Date.now() - cachedAt < TTL_MS) return cached;
  try {
    const doc = await store().get(KEY, { type: 'json' });
    if (doc && doc.pairs) { cached = doc; cachedAt = Date.now(); return doc; }
  } catch (e) {
    console.warn('[fbt-signals] read:', e.message);
  }
  return null;
}

module.exports = { newPairTally, addBaskets, finishPairs, publishSignals, readSignals, KEY, WINDOW_DAYS, MAX_BASKET_FOR_PAIRS, MIN_PAIR };
