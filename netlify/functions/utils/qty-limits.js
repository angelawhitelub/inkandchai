'use strict';

/**
 * Most copies of a book one order may hold (11 Nov 2026), set per book in the
 * admin product editor. One small blob (KV `catalog:qty-limits`), rewritten
 * whole on each change like the hidden-book lists. No SQL migration.
 *
 * Enforced where every order path already agrees: resolveCartPrices puts
 * `_max_qty` on the line and findSoldOut (shipping-restrictions) refuses a cart
 * over it, so COD, PhonePe, Razorpay and the checkout pre-check all block it.
 * The product page stepper and the cart drawer stop at it too (Worker
 * /qty-limits.json and window.__maxQty), but those are only convenience.
 */
// Loaded here but tolerated missing (plain Node tests): pricing requires this
// file, and must not need the blob store just to price a cart.
let blobs = null;
try { blobs = require('@netlify/blobs'); } catch { blobs = null; }
const getStore = (name) => {
  if (!blobs || typeof blobs.getStore !== 'function') throw new Error('Blob store is not available');
  return blobs.getStore(name);
};
const { normSlug } = require('./product-id');

const STORE = 'catalog';
const KEY = 'qty-limits';
const MAX_ITEMS = 5000;

async function readLimits() {
  const doc = await getStore(STORE).get(KEY, { type: 'json' });
  const items = doc && Array.isArray(doc.items) ? doc.items : [];
  return items
    .map((i) => ({ ...i, slug: normSlug(i && i.slug), max: Math.floor(Number(i && i.max)) }))
    .filter((i) => i.slug && i.max >= 1);
}

let cache = null;
let at = 0;

/** { slug: max }, cached a minute per isolate; a failed read keeps the last good map. */
async function limitMap() {
  if (cache && Date.now() - at < 60000) return cache;
  try {
    const m = {};
    for (const i of await readLimits()) m[i.slug] = i.max;
    cache = m;
  } catch (e) {
    console.warn('[qty-limits] read failed:', e.message);
    cache = cache || {};
  }
  at = Date.now();
  return cache;
}

/** Sets (max ≥ 1) or clears (max null/0/'') one book's limit; returns the list. */
async function setLimit(slug, max, { title = '' } = {}) {
  const s = normSlug(slug);
  if (!s) throw new Error('Missing product slug');
  const n = max === null || max === undefined || max === '' ? 0 : Math.floor(Number(max));
  if (!Number.isFinite(n) || n < 0 || n > 999) throw new Error('The limit must be a whole number from 1 to 999, or empty for no limit.');
  const items = (await readLimits()).filter((i) => i.slug !== s);
  if (n >= 1) items.unshift({ slug: s, max: n, title: String(title || '').slice(0, 200), updated_at: new Date().toISOString() });
  if (items.length > MAX_ITEMS) throw new Error(`At most ${MAX_ITEMS} books can have a limit.`);
  await getStore(STORE).setJSON(KEY, { items, updated_at: new Date().toISOString() });
  cache = Object.fromEntries(items.map((i) => [i.slug, i.max]));
  at = Date.now();
  return items;
}

function _reset() { cache = null; at = 0; }

module.exports = { readLimits, limitMap, setLimit, KEY, _reset };
