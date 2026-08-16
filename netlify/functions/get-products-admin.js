const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { requireAdmin } = require('./utils/admin-auth');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key',
  'Content-Type': 'application/json',
};

// Slug rule lives in utils/pricing.js — the ONLY copy. Local re-implementations
// here dropped the `.toLowerCase()` on the shopify_id suffix (and carried only a
// subset of the special-case slugs), so this file wrote/read product_overrides
// under e.g. "...-NG-HI" while the storefront looks for "...-ng-hi". 13 override
// rows — 12 of them price overrides — were silently doing nothing as a result.
const { makeSlug } = require('./utils/pricing');

function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(2) : '';
}

function findCataloguePath() {
  const candidates = [
    path.join(process.cwd(), 'data', 'ALL_BOOKS.json'),
    path.join(__dirname, '..', '..', 'data', 'ALL_BOOKS.json'),
    path.join('/var/task', 'data', 'ALL_BOOKS.json'),
  ];
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) throw new Error(`Catalogue file not found. Checked: ${candidates.join(', ')}`);
  return found;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'GET') return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method Not Allowed' }) };

  const _adminBlock = requireAdmin(event, CORS); if (_adminBlock) return _adminBlock;

  // ?removed=1 — every listing currently off sale, for the Removed listings
  // panel. Deliberately its own query rather than something the browser filters
  // out of the full response: that response carries only the newest 1000 custom
  // products, so a listing delisted long ago would silently never appear in the
  // panel and could never be restored from it.
  if (String((event.queryStringParameters || {}).removed || '') === '1') {
    try {
      if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ removed: [] }) };
      }
      const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

      // Lever 1: a stock override of 0 or less. `.lte` skips NULLs (SQL NULL
      // comparisons are never true), which is what we want — NULL means "no
      // manual stock set", i.e. on sale.
      const [{ data: blocked, error: blockedErr }, { data: hidden, error: hiddenErr }] = await Promise.all([
        supabase.from('product_overrides').select('slug,stock_qty,title,author,price_inr,image_url').lte('stock_qty', 0),
        // Lever 2: custom listings hidden from search and category pages.
        supabase.from('custom_products').select('slug,title,author,price_inr,image_url').eq('is_active', false).limit(5000),
      ]);
      if (blockedErr) throw blockedErr;
      if (hiddenErr) throw hiddenErr;

      // money() turns a null price into "0.00" (Number(null) === 0), which is
      // both wrong to display and truthy — it would block the catalogue
      // fallback below from ever filling the real price in.
      const price = (v) => (v === null || v === undefined || v === '' ? '' : money(v));

      const bySlug = new Map();
      const note = (slug, reason, src) => {
        if (!slug) return;
        const cur = bySlug.get(slug) || { slug, reasons: [], title: '', author: '', price_inr: '', image_url: '', is_custom: false };
        if (!cur.reasons.includes(reason)) cur.reasons.push(reason);
        cur.title = cur.title || src.title || '';
        cur.author = cur.author || src.author || '';
        cur.price_inr = cur.price_inr || price(src.price_inr);
        cur.image_url = cur.image_url || src.image_url || '';
        bySlug.set(slug, cur);
      };
      for (const r of (blocked || [])) note(r.slug, 'sold-out', r);
      for (const r of (hidden || [])) {
        note(r.slug, 'hidden', r);
        // note() skips blank slugs, so this lookup can miss.
        const entry = bySlug.get(r.slug);
        if (entry) entry.is_custom = true;
      }

      // Most delisted rows are catalogue books, whose override row carries no
      // title — fill those in from the catalogue file so the panel is readable.
      const needTitle = [...bySlug.values()].filter(r => !r.title);
      if (needTitle.length) {
        try {
          const raw = JSON.parse(fs.readFileSync(findCataloguePath(), 'utf8'));
          const cat = new Map();
          for (const b of raw) {
            const sid = String(b.shopify_id || '');
            if (!sid || !b.title) continue;
            cat.set(makeSlug(b.title, sid), b);
          }
          for (const r of needTitle) {
            const b = cat.get(r.slug);
            if (!b) continue;
            r.title = b.title || '';
            r.author = r.author || b.author || '';
            r.price_inr = r.price_inr || price(b.price_inr);
            r.image_url = r.image_url || b.image_url || '';
          }
        } catch (_) { /* titles stay blank; the panel falls back to the slug */ }
      }

      const removed = [...bySlug.values()].sort((a, b) => (a.title || a.slug).localeCompare(b.title || b.slug));
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ removed }) };
    } catch (err) {
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
    }
  }

  // ?q= — server-side search over custom_products. The full-list response
  // below can only carry the newest 1000 custom products (Supabase row cap;
  // returning all ~20k full rows would also exceed Netlify's 6 MB limit), so
  // the Product editor calls this for anything not in that window.
  const q = String((event.queryStringParameters || {}).q || '').trim().slice(0, 120);
  if (q) {
    try {
      if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ products: [], overrides: [], aplus_content: [] }) };
      }
      const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
      const safe = q.replace(/[%,()]/g, ' ').replace(/\s+/g, ' ').trim();
      let rows = [];
      if (safe) {
        const { data, error } = await supabase
          .from('custom_products')
          .select('*')
          .or(`title.ilike.%${safe}%,author.ilike.%${safe}%,slug.ilike.%${safe}%,isbn.ilike.%${safe}%`)
          .order('updated_at', { ascending: false })
          .limit(60);
        if (error) throw error;
        rows = data || [];
      }
      const slugs = rows.map(r => r.slug).filter(Boolean);
      let overrides = [];
      let aplusContent = [];
      let shippingRules = [];
      if (slugs.length) {
        const [ovr, apl, ship] = await Promise.all([
          supabase.from('product_overrides').select('*').in('slug', slugs),
          supabase.from('product_aplus_content').select('*').in('slug', slugs),
          supabase.from('product_shipping_rules').select('*').in('slug', slugs),
        ]);
        overrides = ovr.data || [];
        aplusContent = apl.data || [];
        shippingRules = ship.data || [];
      }
      const products = rows.map(p => ({
        slug: p.slug,
        shopify_id: `CUSTOM:${p.slug}`,
        title: p.title || '',
        author: p.author || '',
        category: p.category || 'Books',
        price_inr: money(p.price_inr),
        original_price_inr: money(p.original_price_inr),
        image_url: p.image_url || '',
        gallery_images: Array.isArray(p.gallery_images) ? p.gallery_images : [],
        is_custom: true,
        description: p.description || '',
        author_bio: p.author_bio || '',
        publisher: p.publisher || '',
        isbn: p.isbn || '',
        tags: p.tags || '',
        seo_title: p.seo_title || '',
        meta_description: p.meta_description || '',
        is_active: p.is_active !== false,
      }));
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ products, overrides, aplus_content: aplusContent, shipping_rules: shippingRules }) };
    } catch (err) {
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
    }
  }

  try {
    const dataPath = findCataloguePath();
    const raw = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
    const seen = new Set();
    const products = [];
    for (const b of raw) {
      const sid = String(b.shopify_id || '');
      if (!sid || seen.has(sid) || !b.title) continue;
      seen.add(sid);
      products.push({
        slug: makeSlug(b.title, sid),
        shopify_id: sid,
        title: b.title || '',
        author: b.author || '',
        category: b.category || '',
        price_inr: money(b.price_inr),
        original_price_inr: money(b.original_price_inr),
        image_url: b.image_url || '',
      });
    }

    let overrides = [];
    let customProducts = [];
    let aplusContent = [];
    let shippingRules = [];
    if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY) {
      const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
      const { data, error } = await supabase.from('product_overrides').select('*');
      if (error) console.warn('product_overrides unavailable:', error.message);
      else overrides = data || [];

      const { data: customData, error: customError } = await supabase
        .from('custom_products')
        .select('*')
        .order('updated_at', { ascending: false });
      if (customError) console.warn('custom_products unavailable:', customError.message);
      else customProducts = customData || [];

      const { data: aplusData, error: aplusError } = await supabase
        .from('product_aplus_content')
        .select('*');
      if (aplusError) console.warn('product_aplus_content unavailable:', aplusError.message);
      else aplusContent = aplusData || [];

      const { data: shippingData, error: shippingError } = await supabase
        .from('product_shipping_rules')
        .select('*');
      if (shippingError) console.warn('product_shipping_rules unavailable:', shippingError.message);
      else shippingRules = shippingData || [];
    }

    for (const p of customProducts) {
      if (!p?.slug || seen.has(`CUSTOM:${p.slug}`)) continue;
      products.unshift({
        slug: p.slug,
        shopify_id: `CUSTOM:${p.slug}`,
        title: p.title || '',
        author: p.author || '',
        category: p.category || 'Books',
        price_inr: money(p.price_inr),
        original_price_inr: money(p.original_price_inr),
        image_url: p.image_url || '',
        gallery_images: Array.isArray(p.gallery_images) ? p.gallery_images : [],
        is_custom: true,
        description: p.description || '',
        author_bio: p.author_bio || '',
        publisher: p.publisher || '',
        isbn: p.isbn || '',
        tags: p.tags || '',
        seo_title: p.seo_title || '',
        meta_description: p.meta_description || '',
        is_active: p.is_active !== false,
      });
    }

    return { statusCode: 200, headers: CORS, body: JSON.stringify({ products, overrides, custom_products: customProducts, aplus_content: aplusContent, shipping_rules: shippingRules }) };
  } catch (err) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
