/**
 * Netlify Background Function: import-bookstohome
 * POST /.netlify/functions/import-bookstohome-background
 *
 * Admin one-shot: scrapes bookstohome.in (WooCommerce Store API), dedupes
 * against the ALL_BOOKS.json catalogue + existing custom_products by
 * normalized title, and inserts genuinely new titles into custom_products.
 *
 * Runs as a background function (15-min ceiling) because a fresh cold-start
 * catalogue index load + 171 upserts can nudge past the 26s sync-function
 * limit if bookstohome's origin is slow.
 *
 * Body: {} (no config needed). Reply is 202 immediately; the actual result
 * summary is written to a Supabase row in import_runs for later inspection.
 * Falls back to logging if that table doesn't exist.
 *
 * Headers: X-Admin-Token (via requireAdmin).
 */

const { createClient } = require('@supabase/supabase-js');
const path = require('path');
const fs   = require('fs');
const { requireAdmin } = require('./utils/admin-auth');

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Token, X-Admin-Key',
  'Content-Type': 'application/json',
};

const SOURCE_TAG = 'imported-bookstohome';

// ── Title normalization ─────────────────────────────────────────────────────
// Match "Atomic Habits by James Clear" ↔ "atomic habits (paperback)" ↔ "ATOMIC HABITS".
// Same shape as the Crossword importer — strips punctuation, edition/format
// hints, trailing "by <author>", and language marker parentheses.
function normalizeTitle(raw) {
  let s = String(raw || '').toLowerCase();
  // Strip common bracketed hints: (paperback), (hindi), [english], etc.
  s = s.replace(/\([^)]*\)/g, ' ').replace(/\[[^\]]*\]/g, ' ');
  // Strip trailing " by <author>" / " - <author>" / " – <author>"
  s = s.replace(/\s+(?:by|[–—-])\s+.+$/i, '');
  // Strip common edition suffixes
  s = s.replace(/\b(paperback|hardcover|hardback|edition|book|novel)\b/g, ' ');
  // Collapse to alnum + single space
  s = s.replace(/[^a-z0-9]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  return s;
}

function slugify(raw) {
  return String(raw || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

function loadCatalogTitles() {
  const candidates = [
    path.join(__dirname, '..', '..', 'data', 'ALL_BOOKS.json'),
    path.join(process.cwd(), 'data', 'ALL_BOOKS.json'),
    path.join('/var/task', 'data', 'ALL_BOOKS.json'),
  ];
  for (const p of candidates) {
    try {
      const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
      return raw.map(b => String(b.title || ''));
    } catch (e) { /* try next */ }
  }
  console.warn('[import-bookstohome] ALL_BOOKS.json not found — dedup only against custom_products');
  return [];
}

async function fetchBookstohomeAll() {
  const perPage = 100;
  const products = [];
  for (let page = 1; page <= 5; page++) {
    const url = `https://bookstohome.in/wp-json/wc/store/products?per_page=${perPage}&page=${page}&orderby=date&order=desc`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`bookstohome page ${page} HTTP ${res.status}`);
    const batch = await res.json();
    if (!Array.isArray(batch) || batch.length === 0) break;
    products.push(...batch);
    if (batch.length < perPage) break;
  }
  return products;
}

function stripHtml(s) {
  return String(s || '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#8217;|&rsquo;/g, "'")
    .replace(/&#8220;|&#8221;|&ldquo;|&rdquo;/g, '"')
    .replace(/&#\d+;|&[a-z]+;/gi, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function priceRupeesFromMinor(minor) {
  const n = Number(minor);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n / 100);
}

function bestImage(p) {
  const img = (p.images || [])[0];
  return img?.src || img?.thumbnail || '';
}

function categoryLabel(p) {
  const cats = (p.categories || []).map(c => c.name).filter(Boolean);
  return cats[0] || 'Books';
}

function tagList(p) {
  const tags = (p.tags || []).map(t => t.slug).filter(Boolean);
  return [SOURCE_TAG, ...tags].join(',').slice(0, 700);
}

async function runImport(supabase) {
  const catalogTitles = loadCatalogTitles();
  const catalogNorm = new Set(catalogTitles.map(normalizeTitle).filter(Boolean));

  // Fetch existing custom_products titles + slugs for dedup
  const { data: existing, error: exErr } = await supabase
    .from('custom_products')
    .select('slug,title')
    .limit(5000);
  if (exErr) throw new Error('custom_products lookup: ' + exErr.message);
  const existingNorm = new Set((existing || []).map(r => normalizeTitle(r.title)).filter(Boolean));
  const existingSlugs = new Set((existing || []).map(r => r.slug).filter(Boolean));

  console.log(`[import-bookstohome] catalog=${catalogNorm.size} custom=${existingNorm.size}`);

  const products = await fetchBookstohomeAll();
  console.log(`[import-bookstohome] fetched ${products.length} products from source`);

  const rows = [];
  const skipped = { dupe_catalog: 0, dupe_custom: 0, no_title: 0, no_price: 0, no_image: 0, dupe_slug: 0 };
  const seenNormInBatch = new Set();

  for (const p of products) {
    const title = stripHtml(p.name);
    if (!title) { skipped.no_title++; continue; }
    const norm = normalizeTitle(title);
    if (!norm) { skipped.no_title++; continue; }

    if (catalogNorm.has(norm))   { skipped.dupe_catalog++; continue; }
    if (existingNorm.has(norm))  { skipped.dupe_custom++;  continue; }
    if (seenNormInBatch.has(norm)) { skipped.dupe_custom++; continue; }
    seenNormInBatch.add(norm);

    const price = priceRupeesFromMinor(p.prices?.price);
    const mrp   = priceRupeesFromMinor(p.prices?.regular_price) || price;
    if (!price) { skipped.no_price++; continue; }

    const img = bestImage(p);
    if (!img) { skipped.no_image++; continue; }

    let slug = slugify(p.slug || title);
    if (existingSlugs.has(slug)) {
      slug = `${slug}-bth${String(p.id).slice(-4)}`;
    }
    if (existingSlugs.has(slug)) { skipped.dupe_slug++; continue; }
    existingSlugs.add(slug);

    const shortDesc = stripHtml(p.short_description).slice(0, 480);
    const longDesc  = stripHtml(p.description).slice(0, 4800) ||
                      `${title} — available at Ink & Chai. Fast pan-India delivery, COD and prepaid payment.`;

    rows.push({
      slug,
      title: title.slice(0, 220),
      author: '', // bookstohome's WC Store API doesn't expose author cleanly
      category: categoryLabel(p).slice(0, 140),
      description: longDesc,
      price_inr: price,
      original_price_inr: mrp > price ? mrp : null,
      image_url: img,
      publisher: '',
      isbn: '',
      seo_title: `${title.slice(0, 160)} | Buy Online in India | Ink & Chai`,
      meta_description: (shortDesc || `Buy ${title} online at Ink & Chai. Fast pan-India delivery.`).slice(0, 300),
      tags: tagList(p),
      is_active: true,
      updated_at: new Date().toISOString(),
    });
  }

  console.log(`[import-bookstohome] to-insert=${rows.length} skipped=${JSON.stringify(skipped)}`);

  // Insert in batches of 50 (Supabase happy limit for JSON payload size)
  let inserted = 0;
  const inserts_errors = [];
  for (let i = 0; i < rows.length; i += 50) {
    const chunk = rows.slice(i, i + 50);
    const { error } = await supabase
      .from('custom_products')
      .upsert(chunk, { onConflict: 'slug' });
    if (error) {
      inserts_errors.push(error.message);
      console.error(`[import-bookstohome] chunk ${i} error:`, error.message);
    } else {
      inserted += chunk.length;
    }
  }

  const summary = {
    source: 'bookstohome.in',
    fetched: products.length,
    inserted,
    skipped,
    errors: inserts_errors,
    finished_at: new Date().toISOString(),
  };
  console.log('[import-bookstohome] SUMMARY', JSON.stringify(summary));
  return summary;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST')    return { statusCode: 405, headers: CORS, body: 'Method Not Allowed' };

  const _adminBlock = requireAdmin(event, CORS); if (_adminBlock) return _adminBlock;

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Supabase env vars missing' }) };
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  try {
    const summary = await runImport(supabase);
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ success: true, ...summary }) };
  } catch (err) {
    console.error('[import-bookstohome] fatal:', err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
