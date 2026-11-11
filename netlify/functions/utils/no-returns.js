'use strict';

/**
 * Books sold in the stock clearance sale: no returns, only replacements
 * (11 Nov 2026), switched per book in the admin product editor. One small blob
 * (KV `catalog:no-returns`), rewritten whole on each change like qty-limits.
 * No SQL migration.
 *
 * The rule binds only orders placed after the book was switched on: checkout
 * stamps `_no_returns` on the line (pricing), and an unstamped line counts only
 * when the order came in after the switch's `since`. Someone who bought it
 * before was promised the 7-day return and keeps it.
 *
 * Enforced in request-return (pickReturnItems refuses the line). A free
 * replacement for a defective, misprinted, wrong or missing copy is unchanged.
 * Shown on the product page (Worker), in My Orders and to the WhatsApp bot.
 */
let blobs = null;
try { blobs = require('@netlify/blobs'); } catch { blobs = null; }
const getStore = (name) => {
  if (!blobs || typeof blobs.getStore !== 'function') throw new Error('Blob store is not available');
  return blobs.getStore(name);
};
const { normSlug } = require('./product-id');

const STORE = 'catalog';
const KEY = 'no-returns';
const MAX_ITEMS = 10000;
const NOTICE = 'Stock clearance sale: no returns, only replacements.';
const NOTICE_DETAIL = 'This title is part of our stock clearance sale, so it cannot be returned for a refund. '
  + 'If your copy arrives defective, misprinted or damaged, or we send the wrong book, we replace it free within 7 days of delivery.';

const titleKey = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

async function readList() {
  const doc = await getStore(STORE).get(KEY, { type: 'json' });
  const items = doc && Array.isArray(doc.items) ? doc.items : [];
  return items.map((i) => ({ ...i, slug: normSlug(i && i.slug) })).filter((i) => i.slug);
}

let cache = null;
let at = 0;

/** { slug: { since, title } }, cached a minute per isolate; a failed read keeps the last good map. */
async function noReturnMap() {
  if (cache && Date.now() - at < 60000) return cache;
  try {
    const m = {};
    for (const i of await readList()) m[i.slug] = { since: i.since || i.updated_at || null, title: i.title || '' };
    cache = m;
  } catch (e) {
    console.warn('[no-returns] read failed:', e.message);
    cache = cache || {};
  }
  at = Date.now();
  return cache;
}

/** Switches one book on or off; returns the list. `since` is kept when it is already on. */
async function setNoReturns(slug, on, { title = '' } = {}) {
  const s = normSlug(slug);
  if (!s) throw new Error('Missing product slug');
  const list = await readList();
  const prev = list.find((i) => i.slug === s);
  const items = list.filter((i) => i.slug !== s);
  const now = new Date().toISOString();
  if (on) items.unshift({ slug: s, title: String(title || (prev && prev.title) || '').slice(0, 200), since: (prev && prev.since) || now, updated_at: now });
  if (items.length > MAX_ITEMS) throw new Error(`At most ${MAX_ITEMS} books can be marked.`);
  await getStore(STORE).setJSON(KEY, { items, updated_at: now });
  cache = Object.fromEntries(items.map((i) => [i.slug, { since: i.since, title: i.title }]));
  at = Date.now();
  return items;
}

function cartLines(order) {
  let items = order && order.cart_items;
  if (typeof items === 'string') { try { items = JSON.parse(items); } catch { items = []; } }
  return Array.isArray(items) ? items.filter((i) => i && (i.title || i.name)) : [];
}

/**
 * Is this order line non-returnable? The checkout stamp decides; without one,
 * the book's switch counts if it was on before the order was placed. Lines
 * with only a title (WhatsApp orders) are matched by title.
 */
function isNoReturnLine(item, map, placedAt) {
  if (!item) return false;
  if (item._no_returns === true) return true;
  if (item._no_returns === false) return false;
  if (!map) return false;
  let hit = map[normSlug(item.slug)] || null;
  if (!hit && !item.slug) {
    const k = titleKey(item.title || item.name);
    if (k) hit = Object.values(map).find((v) => v && titleKey(v.title) === k) || null;
  }
  if (!hit) return false;
  const since = Date.parse(hit.since || '');
  const placed = Date.parse(placedAt || '');
  return !(Number.isFinite(since) && Number.isFinite(placed) && placed < since);
}

/** Titles on the order that cannot be returned. */
function noReturnTitles(order, map) {
  return cartLines(order)
    .filter((i) => isNoReturnLine(i, map, order && order.created_at))
    .map((i) => String(i.title || i.name).trim());
}

function noticeHtml() {
  return '<div data-no-returns="1" style="border:1px solid rgba(214,184,94,0.45);background:rgba(214,184,94,0.08);padding:0.85rem 1.05rem;'
    + 'border-radius:14px;margin:0.9rem 0;font-size:0.8rem;line-height:1.6;">'
    + `<strong style="display:block;margin-bottom:0.2rem;">🏷️ ${NOTICE}</strong>${NOTICE_DETAIL}</div>`;
}

function _reset() { cache = null; at = 0; }

module.exports = { readList, noReturnMap, setNoReturns, isNoReturnLine, noReturnTitles, noticeHtml, NOTICE, NOTICE_DETAIL, KEY, _reset };
