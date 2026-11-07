'use strict';

/**
 * Manage inventory (owner's request, 8 Nov 2026): every product in one list,
 * filtered in the browser, with bulk changes planned here.
 *
 * Two halves, both pure so they can be tested without a database:
 *
 *   buildRows()   merges the five places a product's state lives into one row
 *                 per slug, using the storefront's own precedence (pricing.js):
 *                   price  product_settings > newest of (active override,
 *                          active custom row) > baked catalogue
 *                   stock  an ACTIVE override's stock_qty (null = not counted)
 *   planFields()  turns a bulk price/stock/category action into per-slug
 *                 before/after values. The handler writes them the way
 *                 update-product-override does, to product_overrides AND
 *                 product_settings, so the single-product editor and every
 *                 reader agree afterwards.
 */

const SOURCES = ['catalogue', 'custom', 'crossword', '99bookstores'];

// Row flags, one bit each. The admin page has the same table (INV_FLAGS).
const F = {
  OVERRIDE: 1,        // a product_overrides row exists and is on
  OVERRIDE_OFF: 2,    // a row exists but "Disable Override" switched it off
  SCARCITY: 4,
  COD_OFF: 8,
  FREE_DELIVERY: 16,
  SEARCH_HIDDEN: 32,
  BROWSE_HIDDEN: 64,
  DELETED: 128,
  INACTIVE: 256,      // custom row with is_active=false (removed / retired)
  PUBLISHER: 512,     // "Genuine — Publisher Sourced" badge
  PRICE_SET: 1024,    // price comes from product_settings
  NO_IMAGE: 2048,
};

const low = (s) => String(s || '').trim().toLowerCase();
const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const ts = (v) => { const t = v ? Date.parse(v) : 0; return Number.isFinite(t) ? t : 0; };
const posPrice = (v) => { const n = num(v); return n !== null && n > 0 ? n : null; };

function sourceOf(custom) {
  const tags = String(custom.tags || '');
  if (/crossword-catalog/i.test(tags)) return 'crossword';
  if (/99bookstores-catalog/i.test(tags)) return '99bookstores';
  return 'custom';
}

/**
 * One row per product.
 *   catalogue  [{ slug, title, author, category, price_inr, original_price_inr, image_url }]
 *   custom     custom_products rows
 *   overrides  product_overrides rows        settings  { lowerSlug: settings row }
 *   codOff     { lowerSlug: note }           free, searchHidden, browseHidden, deleted: Set of lower slugs
 *   sold       (lowerSlug) => lifetime units
 */
function buildRows({ catalogue = [], custom = [], overrides = [], settings = {}, codOff = {}, free = new Set(),
  searchHidden = new Set(), browseHidden = new Set(), deleted = new Set(), sold = () => 0 }) {
  const ovr = new Map();
  // Every reader lower-cases slugs, so a stranded "...-AGE-4" row counts as the
  // same product: the sold-out list and the stock trigger both act on it.
  // The lower-case row supplies the fields; stock is the lowest any active
  // row holds, because one row at 0 is enough to show "Coming Soon".
  const variantStock = new Map();
  for (const o of overrides) {
    const k = low(o.slug);
    if (!k) continue;
    if (o.is_active !== false && o.stock_qty !== null && o.stock_qty !== undefined) {
      const n = Math.floor(Number(o.stock_qty));
      variantStock.set(k, variantStock.has(k) ? Math.min(variantStock.get(k), n) : n);
    }
    if (ovr.has(k) && o.slug !== k) continue;
    ovr.set(k, o);
  }
  const base = new Map();
  for (const b of catalogue) {
    const k = low(b.slug);
    if (k && !base.has(k)) base.set(k, { ...b, source: 'catalogue', custom: null });
  }
  for (const c of custom) {
    const k = low(c.slug);
    if (!k) continue;
    const cat = base.get(k);
    base.set(k, { ...(cat || {}), ...c, source: cat ? 'catalogue' : sourceOf(c), custom: c, catalogue: cat || null });
  }

  const rows = [];
  for (const [k, b] of base) {
    const o = ovr.get(k) || null;
    const on = o && o.is_active !== false;
    const s = settings[k] || null;
    const c = b.custom;
    const cActive = c && c.is_active !== false;

    let price = s && posPrice(s.price_inr);
    if (price === null) {
      const op = on ? posPrice(o.price_inr) : null;
      const cp = cActive ? posPrice(c.price_inr) : null;
      if (op !== null && cp !== null) price = ts(o.updated_at) >= ts(c.updated_at) ? op : cp;
      else price = op !== null ? op : cp;
    }
    if (price === null) price = posPrice(c ? c.price_inr : null);
    if (price === null) price = posPrice(b.catalogue ? b.catalogue.price_inr : b.price_inr);
    const mrp = (s && posPrice(s.original_price_inr))
      ?? (on ? posPrice(o.original_price_inr) : null)
      ?? posPrice(c ? c.original_price_inr : null)
      ?? posPrice(b.catalogue ? b.catalogue.original_price_inr : b.original_price_inr);

    const stock = variantStock.has(k) ? variantStock.get(k) : null;
    const image = (on && o.image_url) || (c && c.image_url) || b.image_url || '';

    let flags = 0;
    if (on) flags |= F.OVERRIDE;
    if (o && !on) flags |= F.OVERRIDE_OFF;
    if (on && o.scarcity === true) flags |= F.SCARCITY;
    if (Object.prototype.hasOwnProperty.call(codOff, k) || /(?:^|,)\s*no-cod\s*(?:,|$)/i.test(String((c && c.tags) || ''))) flags |= F.COD_OFF;
    if (free.has(k)) flags |= F.FREE_DELIVERY;
    if (searchHidden.has(k)) flags |= F.SEARCH_HIDDEN;
    if (browseHidden.has(k)) flags |= F.BROWSE_HIDDEN;
    if (deleted.has(k)) flags |= F.DELETED;
    if (c && c.is_active === false) flags |= F.INACTIVE;
    if ((o && o.publisher_sourced === true) || /publisher-sourced-bestseller/i.test(String((c && c.tags) || ''))) flags |= F.PUBLISHER;
    if (s && posPrice(s.price_inr) !== null) flags |= F.PRICE_SET;
    if (!image) flags |= F.NO_IMAGE;

    const updated = [o && o.updated_at, c && c.updated_at, s && s.updated_at].map(ts).reduce((a, x) => Math.max(a, x), 0);
    rows.push({
      slug: b.slug,
      title: (on && o.title) || b.title || '',
      author: (on && o.author) || b.author || '',
      category: (on && o.category) || b.category || '',
      source: b.source,
      price, mrp, stock, flags,
      sold: Number(sold(k)) || 0,
      image,
      updated: updated ? new Date(updated).toISOString().slice(0, 10) : '',
      isbn: String((c && c.isbn) || ''),
      publisher: String((c && c.publisher) || ''),
    });
  }
  return rows;
}

/** Columnar form for the wire: about half the bytes of an array of objects. */
const COLS = ['slug', 'title', 'author', 'category', 'source', 'price', 'mrp', 'stock', 'flags', 'sold', 'image', 'updated', 'isbn', 'publisher'];
function packRows(rows) {
  return rows.map((r) => COLS.map((c) => (c === 'source' ? SOURCES.indexOf(r.source) : r[c])));
}

// ── Bulk field changes ───────────────────────────────────────────────────────

const FIELD_ACTIONS = new Set([
  'price_set', 'price_pct', 'price_add', 'price_from_mrp', 'mrp_set', 'mrp_clear',
  'stock_set', 'stock_add', 'stock_clear', 'sold_out', 'scarcity_on', 'scarcity_off', 'category_set',
]);
const PRICE_ACTIONS = new Set(['price_set', 'price_pct', 'price_add', 'price_from_mrp', 'mrp_set', 'mrp_clear']);
const STOCK_ACTIONS = new Set(['stock_set', 'stock_add', 'stock_clear', 'sold_out']);
const MAX_STOCK = 9999999;

const rupees = (n) => Math.round(n);
const clip = (v, max) => { const s = String(v || '').replace(/\s+/g, ' ').trim(); return s ? s.slice(0, max) : null; };

/** Validates the action's value; returns an error string or ''. */
function checkValue(action, value) {
  const n = num(value);
  switch (action) {
    case 'price_set': case 'mrp_set':
      return n !== null && n >= 1 && n <= 1e6 ? '' : 'Enter a price of at least ₹1.';
    case 'price_pct':
      return n !== null && n > -95 && n <= 500 && n !== 0 ? '' : 'Enter a percentage between -95 and 500 (not 0).';
    case 'price_add':
      return n !== null && n !== 0 && Math.abs(n) <= 1e5 ? '' : 'Enter a rupee amount to add or take off (not 0).';
    case 'price_from_mrp':
      return n !== null && n >= 0 && n < 95 ? '' : 'Enter a discount off MRP from 0 to 94%.';
    case 'stock_set':
      return n !== null && n >= 0 && n <= MAX_STOCK && Number.isInteger(n) ? '' : 'Enter a whole number of copies (0 or more).';
    case 'stock_add':
      return n !== null && n !== 0 && Number.isInteger(n) && Math.abs(n) <= MAX_STOCK ? '' : 'Enter a whole number of copies to add (or a minus number to take off).';
    case 'category_set':
      return clip(value, 120) ? '' : 'Enter a category.';
    default:
      return FIELD_ACTIONS.has(action) ? '' : `Unknown action: ${action}`;
  }
}

/**
 * Before/after for each product. `items` are inventory rows (buildRows) with
 * `override` (stored row or null) and `setting` (stored row or null) attached.
 * Returns { changes: [{ slug, title, before, after }], skipped: [{ slug, title, reason }] },
 * where before/after carry price, mrp, stock, scarcity and category.
 */
function planFields(action, value, items) {
  const changes = [];
  const skipped = [];
  const n = num(value);
  for (const it of items) {
    const o = it.override;
    const on = o && o.is_active !== false;
    const before = {
      price: it.price, mrp: it.mrp, stock: it.stock,
      scarcity: !!(on && o.scarcity === true), category: it.category || '',
    };
    const after = { ...before };
    const skip = (reason) => skipped.push({ slug: it.slug, title: it.title, reason });
    if (o && !on && !PRICE_ACTIONS.has(action)) {
      // Readers ignore stock, scarcity and category on a switched-off row, so
      // the change would save and then do nothing.
      skip('its override is switched off (Disable Override) — turn it on in the editor first');
      continue;
    }
    switch (action) {
      case 'price_set': after.price = rupees(n); break;
      case 'price_pct':
        if (!before.price) { skip('has no price to change'); continue; }
        after.price = rupees(before.price * (1 + n / 100)); break;
      case 'price_add':
        if (!before.price) { skip('has no price to change'); continue; }
        after.price = rupees(before.price + n); break;
      case 'price_from_mrp':
        if (!before.mrp) { skip('has no MRP'); continue; }
        after.price = rupees(before.mrp * (1 - n / 100)); break;
      case 'mrp_set': after.mrp = rupees(n); break;
      case 'mrp_clear': after.mrp = null; break;
      case 'stock_set': after.stock = n; break;
      case 'stock_add':
        if (before.stock === null) { skip('stock is not counted — set a number first'); continue; }
        after.stock = Math.max(0, Math.min(MAX_STOCK, before.stock + n)); break;
      case 'stock_clear': after.stock = null; break;
      case 'sold_out': after.stock = 0; break;
      case 'scarcity_on': after.scarcity = true; break;
      case 'scarcity_off': after.scarcity = false; break;
      case 'category_set': after.category = clip(value, 120); break;
      default: skip(`unknown action ${action}`); continue;
    }
    if (after.price !== null && after.price < 1) { skip('the new price would be below ₹1'); continue; }
    if (PRICE_ACTIONS.has(action) && after.price && after.mrp && after.price > after.mrp) {
      skip(`₹${after.price} would be above its MRP ₹${after.mrp} — change the MRP first`);
      continue;
    }
    const same = ['price', 'mrp', 'stock', 'scarcity', 'category'].every((key) => after[key] === before[key]);
    if (same) { skip('already set'); continue; }
    changes.push({ slug: it.slug, title: it.title, before, after });
  }
  return { changes, skipped };
}

const money = (v) => (v === null || v === undefined ? null : Number(v).toFixed(2));

/**
 * The rows to write for planned changes, with identical keys in every row of a
 * batch (a PostgREST bulk upsert sends one column list).
 *   overrides  product_overrides upserts: the stored row's values carried over,
 *              the changed field on top; a new row takes its title, author and
 *              category from the listing, as the single-product editor does.
 *   settings   product_settings upserts, price actions only (that copy is what
 *              every reader prefers, so writing only the override would not move
 *              the live price).
 *   custom     { category: [storedSlug] } for custom_products rows whose category changed.
 *   undo       the stored rows as they were, for the revert action.
 */
function writesFor(action, changes, itemsBySlug, now = new Date().toISOString()) {
  const overrides = [];
  const settings = [];
  const customCategory = {};
  const undo = [];
  const price = PRICE_ACTIONS.has(action);
  for (const ch of changes) {
    const it = itemsBySlug.get(low(ch.slug));
    const o = it.override;
    const s = it.setting;
    const slug = low(ch.slug);
    overrides.push({
      slug,
      title: o ? o.title ?? null : (it.title || null),
      author: o ? o.author ?? null : (it.author || null),
      category: action === 'category_set' ? ch.after.category : (o ? o.category ?? null : (it.category || null)),
      price_inr: price ? money(ch.after.price) : (o ? o.price_inr ?? null : null),
      original_price_inr: price ? money(ch.after.mrp) : (o ? o.original_price_inr ?? null : null),
      // Only the field the action is about: a price change on a switched-off
      // row must not wipe the stock or badge stored on it.
      stock_qty: STOCK_ACTIONS.has(action) ? ch.after.stock : (o ? o.stock_qty ?? null : null),
      scarcity: action === 'scarcity_on' || action === 'scarcity_off' ? ch.after.scarcity : (o ? o.scarcity === true : false),
      is_active: o ? o.is_active !== false : true,
      updated_at: now,
    });
    if (price) {
      settings.push({
        slug,
        price_inr: money(ch.after.price),
        original_price_inr: money(ch.after.mrp),
        handling_days: s ? s.handling_days ?? null : null,
        updated_at: now,
      });
    }
    if (action === 'category_set' && it.custom_slug) {
      (customCategory[ch.after.category] = customCategory[ch.after.category] || []).push(it.custom_slug);
    }
    undo.push({
      slug,
      override: o ? pickOverride(o) : null,
      setting: price ? (s ? pickSetting(s) : null) : undefined,
      custom_category: action === 'category_set' && it.custom_slug ? (it.custom_category ?? null) : undefined,
      custom_slug: action === 'category_set' && it.custom_slug ? it.custom_slug : undefined,
    });
  }
  return { overrides, settings, customCategory, undo };
}

const OVERRIDE_KEYS = ['title', 'author', 'category', 'price_inr', 'original_price_inr', 'stock_qty', 'scarcity', 'is_active'];
const SETTING_KEYS = ['price_inr', 'original_price_inr', 'handling_days'];
function pickOverride(o) { const out = {}; for (const k of OVERRIDE_KEYS) out[k] = o[k] ?? null; return out; }
function pickSetting(s) { const out = {}; for (const k of SETTING_KEYS) out[k] = s[k] ?? null; return out; }

/**
 * A revert item from the client, cleaned to known columns and safe values, or
 * null when it is not one this code produced.
 */
function cleanUndoItem(item) {
  const slug = low(item && item.slug);
  if (!slug || slug.length > 200 || /[\s/?#,]/.test(slug)) return null;
  const out = { slug };
  if (item.override === null) out.override = null;
  else if (item.override && typeof item.override === 'object') {
    const o = item.override;
    const stock = num(o.stock_qty);
    out.override = {
      title: clip(o.title, 220), author: clip(o.author, 120), category: clip(o.category, 120),
      price_inr: posPrice(o.price_inr) === null ? null : money(o.price_inr),
      original_price_inr: posPrice(o.original_price_inr) === null ? null : money(o.original_price_inr),
      stock_qty: stock === null ? null : Math.max(0, Math.min(MAX_STOCK, Math.round(stock))),
      scarcity: o.scarcity === true,
      is_active: o.is_active !== false,
    };
  } else return null;
  if (item.setting === null) out.setting = null;
  else if (item.setting && typeof item.setting === 'object') {
    const s = item.setting;
    const hd = num(s.handling_days);
    out.setting = {
      price_inr: posPrice(s.price_inr) === null ? null : money(s.price_inr),
      original_price_inr: posPrice(s.original_price_inr) === null ? null : money(s.original_price_inr),
      handling_days: hd === null ? null : Math.max(0, Math.min(60, Math.round(hd))),
    };
  }
  if (item.custom_slug !== undefined) {
    const cs = String(item.custom_slug || '').trim();
    if (cs && cs.length <= 200 && !/[\s/?#,]/.test(cs)) {
      out.custom_slug = cs;
      out.custom_category = clip(item.custom_category, 120);
    }
  }
  return out;
}

module.exports = {
  F, SOURCES, COLS, FIELD_ACTIONS, PRICE_ACTIONS, STOCK_ACTIONS,
  buildRows, packRows, checkValue, planFields, writesFor, cleanUndoItem, low,
};
