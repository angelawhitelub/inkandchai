/**
 * Netlify Function: admin-inventory   (owner only)
 *
 * The Manage inventory page (owner's request, 8 Nov 2026): every product,
 * searchable in the browser, with bulk changes to any selection.
 *
 *   GET [?fresh=1]  → { cols, rows, sources, generated_at, ... }  every product, one
 *                     compact row each (utils/inventory.js COLS). Cached per
 *                     isolate for 3 minutes; ?fresh=1 rebuilds.
 *   POST { action, slugs, value?, note?, reason?, dry_run }
 *                   → dry_run: { changes, skipped } — what would happen, nothing written
 *                   → otherwise: { applied, skipped, undo } — undo is a body that,
 *                     POSTed back, puts the changed products back as they were
 *   POST { action: 'revert', items }   the undo of a field action
 *
 * Field actions (price_set, price_pct, price_add, price_from_mrp, mrp_set,
 * mrp_clear, stock_set, stock_add, stock_clear, sold_out, scarcity_on/off,
 * category_set) write product_overrides and, for prices, product_settings --
 * the same two tables update-product-override writes, so the one-product
 * editor shows the new values. Flag actions reuse the existing stores:
 * product_cod_rules, product_free_delivery, the search/browse hidden lists,
 * and deleted_products (+ the KV index the Worker answers 410 from).
 *
 * Every action works on the stored state read at write time, not on what the
 * browser last saw, and reports per product what it skipped and why.
 */
'use strict';

const { createClient } = require('@supabase/supabase-js');
const { requireAdmin } = require('./utils/admin-auth');
const { purgeProductSlugs, purgeProducts } = require('./utils/purge-cache');
const { makeSlug } = require('./utils/pricing');
const { readLifetimeSales, unitsSold } = require('./utils/lifetime-sales');
const C = require('./utils/cod-rules');
const FD = require('./utils/free-delivery');
const H = require('./utils/search-hidden');
const D = require('./utils/deleted-products');
const INV = require('./utils/inventory');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key, X-Admin-Token',
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
};
const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });

const MAX_SLUGS = 500;        // per request; the page sends bigger selections in chunks
const CACHE_MS = 3 * 60_000;
const CUSTOM_COLS = 'slug,title,author,category,price_inr,original_price_inr,image_url,is_active,tags,isbn,publisher,updated_at';
const OVERRIDE_COLS = 'slug,title,author,category,price_inr,original_price_inr,image_url,stock_qty,scarcity,is_active,publisher_sourced,updated_at';
const SETTING_COLS = 'slug,price_inr,original_price_inr,handling_days,updated_at';

const FLAG_ACTIONS = new Set(['cod_off', 'cod_on', 'free_on', 'free_off', 'search_hide', 'search_show',
  'browse_hide', 'browse_show', 'delete', 'undelete']);

let _catalogue = null;
function catalogueRows() {
  if (_catalogue) return _catalogue;
  const raw = require('../../data/ALL_BOOKS.json');
  const seen = new Set();
  _catalogue = [];
  for (const b of Array.isArray(raw) ? raw : []) {
    const sid = String(b.shopify_id || '');
    if (!sid || !b.title || seen.has(sid)) continue;
    seen.add(sid);
    _catalogue.push({
      slug: makeSlug(b.title, sid), title: b.title, author: b.author || '', category: b.category || '',
      price_inr: b.price_inr, original_price_inr: b.original_price_inr, image_url: b.image_url || '',
    });
  }
  return _catalogue;
}

/** Every row of a table, 1000 at a time (the PostgREST cap), six pages at once. */
async function pageAll(db, table, cols, { orderBy = 'slug', tolerateMissing = false } = {}) {
  const head = await db.from(table).select('slug', { count: 'exact', head: true });
  if (head.error) {
    if (tolerateMissing) return [];
    throw new Error(`${table}: ${head.error.message}`);
  }
  const total = head.count || 0;
  const starts = [];
  for (let from = 0; from < total + 1000; from += 1000) starts.push(from);
  const out = [];
  for (let i = 0; i < starts.length; i += 6) {
    const pages = await Promise.all(starts.slice(i, i + 6).map(async (from) => {
      const { data, error } = await db.from(table).select(cols).order(orderBy).range(from, from + 999);
      if (error) throw new Error(`${table}: ${error.message}`);
      return data || [];
    }));
    for (const p of pages) out.push(...p);
    if (pages[pages.length - 1].length < 1000) break;
  }
  return out;
}

async function safely(label, fn, fallback, warnings) {
  try { return await fn(); } catch (e) { warnings.push(`${label}: ${e.message}`); return fallback; }
}

/** Every source, merged. Cached per isolate; writes clear it. */
let _cache = null;
async function loadState(db, { fresh = false } = {}) {
  if (!fresh && _cache && Date.now() - _cache.at < CACHE_MS) return _cache;
  const warnings = [];
  const [custom, overrides, settingsRows, codOff, free, searchHidden, browseHidden, deleted, sales] = await Promise.all([
    pageAll(db, 'custom_products', CUSTOM_COLS),
    pageAll(db, 'product_overrides', OVERRIDE_COLS),
    safely('product_settings', () => pageAll(db, 'product_settings', SETTING_COLS, { tolerateMissing: true }), [], warnings),
    safely('COD rules', () => C.allCodRules(db), {}, warnings),
    safely('free delivery', () => FD.allFreeDelivery(db), [], warnings),
    safely('search-hidden list', () => H.readHidden(), [], warnings),
    safely('browse-hidden list', () => H.browse.readHidden(), [], warnings),
    safely('deleted pages', async () => { const r = await D.readDeleted(db); if (!r.ok) throw new Error(r.error || 'table missing'); return r.rows; }, [], warnings),
    safely('sales counts', () => readLifetimeSales(), null, warnings),
  ]);
  const settings = {};
  for (const s of settingsRows) settings[INV.low(s.slug)] = s;
  const deletedRows = new Map(deleted.map((r) => [D.normSlug(r.slug), r]));
  const rows = INV.buildRows({
    catalogue: catalogueRows(), custom, overrides, settings, codOff,
    free: new Set(free),
    searchHidden: new Set(searchHidden.map((i) => i.slug)),
    browseHidden: new Set(browseHidden.map((i) => i.slug)),
    deleted: new Set(deletedRows.keys()),
    sold: (k) => unitsSold(sales, k),
  });
  const customBySlug = new Map(custom.map((c) => [INV.low(c.slug), c]));
  const rowBySlug = new Map(rows.map((r) => [INV.low(r.slug), r]));
  const catalogueBySlug = new Map(catalogueRows().map((b) => [INV.low(b.slug), b]));
  _cache = { at: Date.now(), rows, rowBySlug, customBySlug, catalogueBySlug, deletedRows, codOff, warnings };
  return _cache;
}

/** Fresh override and settings rows for these lower-case slugs. */
async function storedFor(db, slugs) {
  const overrides = new Map();
  const settings = new Map();
  const variants = new Map();
  for (let i = 0; i < slugs.length; i += 100) {
    const group = slugs.slice(i, i + 100);
    const [o, s] = await Promise.all([
      db.from('product_overrides').select(OVERRIDE_COLS).in('slug', group),
      db.from('product_settings').select(SETTING_COLS).in('slug', group),
    ]);
    if (o.error) throw new Error(`product_overrides: ${o.error.message}`);
    for (const r of o.data || []) overrides.set(INV.low(r.slug), r);
    // Case variants ("...-AGE-4") of these slugs: readers treat them as the
    // same product, so stock changes have to reach them too.
    const v = await db.from('product_overrides').select('slug,stock_qty,is_active')
      .or(group.map((g) => `slug.ilike.${g}`).join(','));
    if (v.error) throw new Error(`product_overrides: ${v.error.message}`);
    for (const r of v.data || []) {
      if (r.slug === INV.low(r.slug)) continue;
      const k = INV.low(r.slug);
      if (!variants.has(k)) variants.set(k, []);
      variants.get(k).push(r);
    }
    if (s.error && !/product_settings/.test(s.error.message)) throw new Error(`product_settings: ${s.error.message}`);
    for (const r of s.data || []) settings.set(INV.low(r.slug), r);
  }
  return { overrides, settings, variants };
}

function chunks(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

async function purge(slugs) {
  try {
    const r = slugs.length <= 270 ? await purgeProductSlugs(slugs) : await purgeProducts();
    return !!(r && r.purged);
  } catch (e) {
    console.warn('[admin-inventory] purge:', e.message);
    return false;
  }
}

// ── Field actions ────────────────────────────────────────────────────────────

async function fieldAction(db, state, action, value, slugs, dryRun) {
  const known = slugs.filter((k) => state.rowBySlug.has(k));
  const missing = slugs.filter((k) => !state.rowBySlug.has(k));
  const { overrides, settings, variants } = await storedFor(db, known);
  // Rebuild each row from what is stored now, so a stale page cannot write
  // yesterday's price back over today's.
  const items = known.map((k) => {
    const row = state.rowBySlug.get(k);
    const custom = state.customBySlug.get(k) || null;
    const cat = state.catalogueBySlug.get(k);
    const [fresh] = INV.buildRows({
      catalogue: cat ? [cat] : [],
      custom: custom ? [custom] : [],
      overrides: (overrides.has(k) ? [overrides.get(k)] : []).concat(variants.get(k) || []),
      settings: settings.has(k) ? { [k]: settings.get(k) } : {},
    });
    return {
      ...row, price: fresh.price, mrp: fresh.mrp, stock: fresh.stock,
      category: fresh.category, title: fresh.title, author: fresh.author,
      override: overrides.get(k) || null, setting: settings.get(k) || null,
      custom_slug: custom ? custom.slug : null, custom_category: custom ? custom.category ?? null : null,
    };
  });
  const plan = INV.planFields(action, value, items);
  const skipped = plan.skipped.concat(missing.map((slug) => ({ slug, title: '', reason: 'not found in the catalogue' })));
  if (dryRun || !plan.changes.length) return { changes: plan.changes, skipped, applied: 0 };

  const bySlug = new Map(items.map((it) => [INV.low(it.slug), it]));
  const w = INV.writesFor(action, plan.changes, bySlug);
  for (const group of chunks(w.overrides, 200)) {
    const { error } = await db.from('product_overrides').upsert(group, { onConflict: 'slug' });
    if (error) throw new Error(`product_overrides: ${error.message}`);
  }
  for (const group of chunks(w.settings, 200)) {
    const { error } = await db.from('product_settings').upsert(group, { onConflict: 'slug' });
    if (error) throw new Error(`product_settings: ${error.message}`);
  }
  // Stock goes to the case-variant rows as well, or the one left at 0 keeps
  // the page on "Coming Soon" (8 Nov 2026: the Atomic Habits set of 4).
  if (INV.STOCK_ACTIONS.has(action)) {
    for (const r of w.overrides) {
      for (const v of variants.get(r.slug) || []) {
        if ((v.stock_qty ?? null) === r.stock_qty) continue;
        const { error } = await db.from('product_overrides')
          .update({ stock_qty: r.stock_qty, updated_at: r.updated_at }).eq('slug', v.slug);
        if (error) throw new Error(`product_overrides: ${error.message}`);
      }
    }
  }
  for (const [category, customSlugs] of Object.entries(w.customCategory)) {
    for (const group of chunks(customSlugs, 200)) {
      const { error } = await db.from('custom_products').update({ category }).in('slug', group);
      if (error) throw new Error(`custom_products: ${error.message}`);
    }
  }
  // Read back what readers will see.
  const after = await storedFor(db, w.overrides.map((r) => r.slug));
  const failed = w.overrides.filter((r) => {
    const got = after.overrides.get(r.slug);
    if (!got) return true;
    if (INV.STOCK_ACTIONS.has(action)) {
      return (got.stock_qty ?? null) !== r.stock_qty
        || (after.variants.get(r.slug) || []).some((v) => (v.stock_qty ?? null) !== r.stock_qty);
    }
    if (INV.PRICE_ACTIONS.has(action)) {
      const s = after.settings.get(r.slug);
      return !s || Number(s.price_inr || 0).toFixed(2) !== Number(r.price_inr || 0).toFixed(2)
        || (s.original_price_inr == null ? null : Number(s.original_price_inr).toFixed(2)) !== r.original_price_inr;
    }
    if (action === 'category_set') return got.category !== r.category;
    return (got.scarcity === true) !== r.scarcity;
  });
  return {
    changes: plan.changes, skipped, applied: w.overrides.length - failed.length,
    failed: failed.map((r) => r.slug),
    undo: { action: 'revert', items: w.undo },
    purgeSlugs: w.overrides.map((r) => r.slug),
  };
}

async function revertAction(db, rawItems, dryRun) {
  const items = (Array.isArray(rawItems) ? rawItems : []).slice(0, MAX_SLUGS).map(INV.cleanUndoItem).filter(Boolean);
  if (!items.length) return { error: 'Nothing to undo.' };
  if (dryRun) return { changes: items.map((i) => ({ slug: i.slug, title: '', before: null, after: null })), skipped: [], applied: 0 };
  const now = new Date().toISOString();
  const upserts = items.filter((i) => i.override).map((i) => ({ slug: i.slug, ...i.override, updated_at: now }));
  const drops = items.filter((i) => i.override === null).map((i) => i.slug);
  for (const group of chunks(upserts, 200)) {
    const { error } = await db.from('product_overrides').upsert(group, { onConflict: 'slug' });
    if (error) throw new Error(`product_overrides: ${error.message}`);
  }
  // A row the bulk action created did not exist before; take it away again.
  for (const group of chunks(drops, 200)) {
    const { error } = await db.from('product_overrides').delete().in('slug', group);
    if (error) throw new Error(`product_overrides: ${error.message}`);
  }
  const setUps = items.filter((i) => i.setting && (i.setting.price_inr !== null || i.setting.original_price_inr !== null || i.setting.handling_days !== null))
    .map((i) => ({ slug: i.slug, ...i.setting, updated_at: now }));
  const setDrops = items.filter((i) => i.setting === null
    || (i.setting && i.setting.price_inr === null && i.setting.original_price_inr === null && i.setting.handling_days === null)).map((i) => i.slug);
  for (const group of chunks(setUps, 200)) {
    const { error } = await db.from('product_settings').upsert(group, { onConflict: 'slug' });
    if (error) throw new Error(`product_settings: ${error.message}`);
  }
  for (const group of chunks(setDrops, 200)) {
    const { error } = await db.from('product_settings').delete().in('slug', group);
    if (error) throw new Error(`product_settings: ${error.message}`);
  }
  for (const i of items.filter((x) => x.custom_slug)) {
    const { error } = await db.from('custom_products').update({ category: i.custom_category }).eq('slug', i.custom_slug);
    if (error) throw new Error(`custom_products: ${error.message}`);
  }
  return { changes: items.map((i) => ({ slug: i.slug })), skipped: [], applied: items.length, purgeSlugs: items.map((i) => i.slug) };
}

// ── Flag actions ─────────────────────────────────────────────────────────────

const INVERSE = {
  cod_off: 'cod_on', cod_on: 'cod_off', free_on: 'free_off', free_off: 'free_on',
  search_hide: 'search_show', search_show: 'search_hide', browse_hide: 'browse_show', browse_show: 'browse_hide',
  delete: 'undelete', undelete: 'delete',
};
const LABEL = {
  cod_off: ['COD on', 'COD off'], cod_on: ['COD off', 'COD on'],
  free_on: ['normal delivery', 'free delivery'], free_off: ['free delivery', 'normal delivery'],
  search_hide: ['in search', 'hidden from search'], search_show: ['hidden from search', 'in search'],
  browse_hide: ['in browsing', 'hidden from browsing'], browse_show: ['hidden from browsing', 'in browsing'],
  delete: ['live page', 'deleted (410)'], undelete: ['deleted (410)', 'live page'],
};

async function flagAction(db, state, action, slugs, { note, reason }, dryRun) {
  const rows = slugs.map((k) => state.rowBySlug.get(k)).filter(Boolean);
  const skipped = slugs.filter((k) => !state.rowBySlug.has(k)).map((slug) => ({ slug, title: '', reason: 'not found in the catalogue' }));
  const keys = rows.map((r) => INV.low(r.slug));
  const titleOf = new Map(rows.map((r) => [INV.low(r.slug), r.title]));

  // Current state, read now rather than from the cached rows.
  let isOn;   // (lowerSlug) => true when the action's target state already holds
  if (action === 'cod_off' || action === 'cod_on') {
    const rules = await C.codRulesFor(db, keys);
    const tagged = new Set(rows.filter((r) => {
      const c = state.customBySlug.get(INV.low(r.slug));
      return c && /(?:^|,)\s*no-cod\s*(?:,|$)/i.test(String(c.tags || ''));
    }).map((r) => INV.low(r.slug)));
    for (const k of keys) {
      if (action === 'cod_on' && tagged.has(k) && !rules[k]) skipped.push({ slug: k, title: titleOf.get(k), reason: 'COD is off by its no-cod tag — remove the tag in the editor' });
    }
    const off = (k) => Object.prototype.hasOwnProperty.call(rules, k);
    isOn = action === 'cod_off' ? off : (k) => !off(k);
  } else if (action === 'free_on' || action === 'free_off') {
    const free = await FD.freeDeliveryFor(db, keys);
    isOn = action === 'free_on' ? (k) => free.has(k) : (k) => !free.has(k);
  } else if (action.startsWith('search_') || action.startsWith('browse_')) {
    const list = action.startsWith('search_') ? H : H.browse;
    const hidden = new Set((await list.readHidden()).map((i) => i.slug));
    isOn = action.endsWith('_hide') ? (k) => hidden.has(k) : (k) => !hidden.has(k);
  } else {
    const fresh = await D.readDeleted(db);
    if (!fresh.ok) return { error: 'The deleted_products table does not exist yet. Run sql/deleted_products.sql in Supabase first.' };
    const gone = new Set(fresh.slugs);
    isOn = action === 'delete' ? (k) => gone.has(k) : (k) => !gone.has(k);
    state.deletedRows = new Map(fresh.rows.map((r) => [D.normSlug(r.slug), r]));
  }

  const already = new Set(skipped.map((s) => s.slug));
  const todo = [];
  for (const k of keys) {
    if (already.has(k)) continue;
    if (isOn(k)) { skipped.push({ slug: k, title: titleOf.get(k), reason: `already ${LABEL[action][1]}` }); continue; }
    todo.push(k);
  }
  const changes = todo.map((k) => ({ slug: k, title: titleOf.get(k), before: LABEL[action][0], after: LABEL[action][1] }));
  if (dryRun || !todo.length) return { changes, skipped, applied: 0 };

  const now = new Date().toISOString();
  let extra = {};
  if (action === 'cod_off') {
    const n = C.cleanNote(note) || null;
    for (const group of chunks(todo, 200)) {
      const { error } = await db.from(C.TABLE).upsert(group.map((slug) => ({ slug, note: n, updated_at: now })), { onConflict: 'slug' });
      if (error) throw new Error(C.isMissingTable(error) ? 'Run sql/product_cod_rules.sql in Supabase first.' : error.message);
    }
  } else if (action === 'cod_on') {
    for (const group of chunks(todo, 200)) {
      const { error } = await db.from(C.TABLE).delete().in('slug', group);
      if (error) throw new Error(error.message);
    }
  } else if (action === 'free_on') {
    for (const group of chunks(todo, 200)) {
      const { error } = await db.from(FD.TABLE).upsert(group.map((slug) => ({ slug, updated_at: now })), { onConflict: 'slug' });
      if (error) throw new Error(FD.isMissingTable(error) ? 'Run sql/product_free_delivery.sql in Supabase first.' : error.message);
    }
  } else if (action === 'free_off') {
    for (const group of chunks(todo, 200)) {
      const { error } = await db.from(FD.TABLE).delete().in('slug', group);
      if (error) throw new Error(error.message);
    }
  } else if (action.startsWith('search_') || action.startsWith('browse_')) {
    const list = action.startsWith('search_') ? H : H.browse;
    const titles = Object.fromEntries(todo.map((k) => [k, titleOf.get(k) || '']));
    await list.setManyHidden(todo, action.endsWith('_hide'), { titles });
  } else if (action === 'delete') {
    const r = String(reason || '').slice(0, 500) || null;
    const customSlugs = todo.map((k) => state.customBySlug.get(k)).filter(Boolean).map((c) => c.slug);
    // Retire custom rows first, as delete-product does: the record below is what
    // makes the URL answer 410, and the row is kept so Restore can bring it back.
    for (const group of chunks(customSlugs, 200)) {
      const { error } = await db.from('custom_products').update({ is_active: false }).in('slug', group);
      if (error) throw new Error(`custom_products: ${error.message}`);
    }
    const records = todo.map((k) => ({ slug: k, title: titleOf.get(k) || null, kind: state.customBySlug.has(k) ? 'custom' : 'catalogue', reason: r }));
    for (const group of chunks(records, 200)) {
      const { error } = await db.from('deleted_products').upsert(group, { onConflict: 'slug' });
      if (error) throw new Error(`deleted_products: ${error.message}`);
    }
    const index = await D.publishDeletedIndex(db);
    extra = { index_published: index.published, index_reason: index.reason || null };
  } else if (action === 'undelete') {
    const customSlugs = todo.filter((k) => (state.deletedRows.get(k) || {}).kind === 'custom')
      .map((k) => state.customBySlug.get(k)).filter(Boolean).map((c) => c.slug);
    for (const group of chunks(customSlugs, 200)) {
      const { error } = await db.from('custom_products').update({ is_active: true }).in('slug', group);
      if (error) throw new Error(`custom_products: ${error.message}`);
    }
    for (const group of chunks(todo, 200)) {
      const { error } = await db.from('deleted_products').delete().in('slug', group);
      if (error) throw new Error(`deleted_products: ${error.message}`);
    }
    const index = await D.publishDeletedIndex(db);
    extra = { index_published: index.published, index_reason: index.reason || null };
  }
  return { changes, skipped, applied: todo.length, undo: { action: INVERSE[action], slugs: todo }, purgeSlugs: todo, ...extra };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  const blocked = requireAdmin(event, CORS);
  if (blocked) return blocked;
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) return json(500, { error: 'Supabase is not configured.' });
  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  if (event.httpMethod === 'GET') {
    try {
      const qs = event.queryStringParameters || {};
      const state = await loadState(db, { fresh: qs.fresh === '1' });
      return json(200, {
        generated_at: new Date(state.at).toISOString(),
        cols: INV.COLS, sources: INV.SOURCES, flags: INV.F,
        rows: INV.packRows(state.rows),
        default_cod_note: C.DEFAULT_NOTE,
        warnings: state.warnings,
      });
    } catch (e) {
      console.error('[admin-inventory] load:', e);
      return json(500, { error: e.message });
    }
  }
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }
  const action = String(body.action || '');
  const dryRun = body.dry_run !== false;   // a preview unless the caller says otherwise

  try {
    let result;
    if (action === 'revert') {
      result = await revertAction(db, body.items, dryRun);
    } else {
      if (!INV.FIELD_ACTIONS.has(action) && !FLAG_ACTIONS.has(action)) return json(400, { error: `Unknown action: ${action}` });
      const slugs = [...new Set((Array.isArray(body.slugs) ? body.slugs : []).map(INV.low).filter((s) => s && s.length <= 200 && !/[\s/?#,]/.test(s)))];
      if (!slugs.length) return json(400, { error: 'Select at least one product.' });
      if (slugs.length > MAX_SLUGS) return json(400, { error: `At most ${MAX_SLUGS} products per request.` });
      const state = await loadState(db);
      if (INV.FIELD_ACTIONS.has(action)) {
        const bad = INV.checkValue(action, body.value);
        if (bad) return json(400, { error: bad });
        result = await fieldAction(db, state, action, body.value, slugs, dryRun);
      } else {
        result = await flagAction(db, state, action, slugs, { note: body.note, reason: body.reason }, dryRun);
      }
    }
    if (result.error) return json(400, { error: result.error });
    const { purgeSlugs = [], ...out } = result;
    if (!dryRun && out.applied) {
      _cache = null;
      out.cache_purged = await purge(purgeSlugs);
      console.log(`[admin-inventory] ${action}: ${out.applied} changed, ${out.skipped.length} skipped`);
    }
    out.dry_run = dryRun;
    return json(200, out);
  } catch (e) {
    console.error('[admin-inventory]', action, e);
    return json(500, { error: e.message });
  }
};

exports._test = { pageAll, fieldAction, flagAction, revertAction, loadState, reset: () => { _cache = null; } };
