/**
 * Create a bundle: one saleable product made of two or more existing books.
 *
 * Bundles are worth the trouble. Over the last year an order containing one
 * averaged Rs 651 against Rs 359 for an order without -- and the catalogue is
 * full of pairs people already buy together with no bundle to buy (System
 * Design Vol 1 and Vol 2 shipped in the same parcel 117 times).
 *
 * Until now a bundle had to be hand-built as a custom product: type the combined
 * title, add up the prices, paste an image. This composes all of that from the
 * components and writes ONE custom_products row, which is what a bundle already
 * is on this site -- so bundles created here render, price, ship and appear in
 * feeds exactly like the ones that exist today. No new storefront concept.
 *
 * GET  ?q=…       search catalogue + custom listings for the component picker
 * POST            create/update the bundle
 */
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { requireAdmin } = require('./utils/admin-auth');
const { makeSlug } = require('./utils/pricing');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key, X-Admin-Token',
  'Content-Type': 'application/json',
};
const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });

const MAX_COMPONENTS = 6;

function catalogue() {
  const candidates = [
    path.join(process.cwd(), 'data', 'ALL_BOOKS.json'),
    path.join(__dirname, '..', '..', 'data', 'ALL_BOOKS.json'),
    path.join('/var/task', 'data', 'ALL_BOOKS.json'),
  ];
  const found = candidates.find((c) => fs.existsSync(c));
  if (!found) return [];
  try { return JSON.parse(fs.readFileSync(found, 'utf8')); } catch { return []; }
}

let _index = null;
function catalogueIndex() {
  if (_index) return _index;
  _index = new Map();
  for (const b of catalogue()) {
    const price = Number(b.price_inr) || 0;
    if (price <= 0) continue;
    const slug = makeSlug(b.title || '', b.shopify_id || '').toLowerCase();
    if (!slug || _index.has(slug)) continue;
    _index.set(slug, {
      slug,
      title: String(b.title || ''),
      author: String(b.author || ''),
      price,
      mrp: Number(b.original_price_inr) || 0,
      image: String(b.image_url || ''),
      category: String(b.category || ''),
      source: 'catalogue',
    });
  }
  return _index;
}

const money = (v) => Math.round((Number(v) || 0) * 100) / 100;

/** Title for a bundle of N books, in the "A + B" shape the site already uses. */
function composeTitle(parts) {
  const joined = parts.map((p) => p.title).join(' + ');
  // custom_products.title is capped at 220 by create-product-listing; a long
  // join is trimmed to a countable label rather than cut mid-title.
  if (joined.length <= 200) return joined;
  return `${parts[0].title} + ${parts.length - 1} More Books | ${parts.length} Book Combo`;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  const block = requireAdmin(event, CORS); if (block) return block;

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return json(500, { error: 'SUPABASE_URL and SUPABASE_SERVICE_KEY are required.' });
  }
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  // ── Component picker ──────────────────────────────────────────────────────
  if (event.httpMethod === 'GET') {
    const q = String(event.queryStringParameters?.q || '').trim().slice(0, 120);
    if (!q) return json(200, { products: [] });
    const needle = q.toLowerCase();

    const fromCatalogue = [];
    for (const entry of catalogueIndex().values()) {
      if (entry.title.toLowerCase().includes(needle) || entry.author.toLowerCase().includes(needle)) {
        fromCatalogue.push(entry);
        if (fromCatalogue.length >= 40) break;
      }
    }

    // Custom listings live in the database, and are searched there.
    let fromCustom = [];
    try {
      const safe = q.replace(/[%,()]/g, ' ').replace(/\s+/g, ' ').trim();
      if (safe) {
        const { data } = await supabase
          .from('custom_products')
          .select('slug,title,author,price_inr,original_price_inr,image_url,category')
          .or(`title.ilike.%${safe}%,author.ilike.%${safe}%,slug.ilike.%${safe}%`)
          .eq('is_active', true)
          .limit(40);
        fromCustom = (data || []).map((r) => ({
          slug: String(r.slug || '').toLowerCase(),
          title: String(r.title || ''),
          author: String(r.author || ''),
          price: Number(r.price_inr) || 0,
          mrp: Number(r.original_price_inr) || 0,
          image: String(r.image_url || ''),
          category: String(r.category || ''),
          source: 'custom',
        })).filter((r) => r.slug && r.price > 0);
      }
    } catch (err) {
      console.warn('[admin-bundle] custom search failed:', err.message);
    }

    // A custom listing overrides a catalogue book with the same slug.
    const merged = new Map();
    for (const p of fromCatalogue) merged.set(p.slug, p);
    for (const p of fromCustom) merged.set(p.slug, p);
    return json(200, { products: [...merged.values()].slice(0, 60) });
  }

  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

  // ── Create the bundle ─────────────────────────────────────────────────────
  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: 'Invalid JSON' }); }

  const slugs = [...new Set((Array.isArray(body.components) ? body.components : [])
    .map((v) => String(v || '').trim().toLowerCase()).filter(Boolean))];
  if (slugs.length < 2) return json(400, { error: 'A bundle needs at least 2 different products.' });
  if (slugs.length > MAX_COMPONENTS) return json(400, { error: `A bundle can hold at most ${MAX_COMPONENTS} products.` });

  // Resolve every component, from the database first and the catalogue second.
  const parts = [];
  const missing = [];
  const { data: customRows } = await supabase
    .from('custom_products')
    .select('slug,title,author,price_inr,original_price_inr,image_url,category')
    .in('slug', slugs);
  const customBySlug = new Map((customRows || []).map((r) => [String(r.slug).toLowerCase(), r]));
  const index = catalogueIndex();

  for (const slug of slugs) {
    const custom = customBySlug.get(slug);
    if (custom && Number(custom.price_inr) > 0) {
      parts.push({
        slug, title: String(custom.title || ''), author: String(custom.author || ''),
        price: Number(custom.price_inr) || 0, mrp: Number(custom.original_price_inr) || 0,
        image: String(custom.image_url || ''), category: String(custom.category || ''),
      });
      continue;
    }
    const cat = index.get(slug);
    if (cat) { parts.push({ ...cat }); continue; }
    missing.push(slug);
  }
  // Refusing here matters: a bundle silently built from 2 of 3 chosen books
  // would be priced for 2 and picked as 3.
  if (missing.length) return json(400, { error: `Could not find: ${missing.join(', ')}` });

  const sumPrice = money(parts.reduce((s, p) => s + p.price, 0));
  // A component with no MRP falls back to its selling price, so the bundle's
  // "was" figure is never lower than the sum of what the books actually cost.
  const sumMrp = money(parts.reduce((s, p) => s + (p.mrp > p.price ? p.mrp : p.price), 0));

  let price;
  if (body.price_inr !== undefined && body.price_inr !== null && body.price_inr !== '') {
    price = money(body.price_inr);
  } else {
    const pct = Math.min(60, Math.max(0, Number(body.discount_percent) || 0));
    price = money(sumPrice * (1 - pct / 100));
  }
  if (!(price > 0)) return json(400, { error: 'Bundle price must be greater than zero.' });
  // A bundle that costs more than buying the books separately is a bundle
  // nobody should be sold; it is almost always a typo in the price field.
  if (price > sumPrice) {
    return json(400, {
      error: `Bundle price ₹${price} is higher than buying the ${parts.length} books separately (₹${sumPrice}).`,
      sum_price_inr: sumPrice,
    });
  }

  const title = String(body.title || '').trim().slice(0, 220) || composeTitle(parts);
  const slug = String(body.slug || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    || `${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48)}-combo-${parts.length}`;

  if (body.dry_run) {
    return json(200, { preview: { slug, title, price_inr: price, original_price_inr: sumMrp, sum_price_inr: sumPrice, components: parts } });
  }

  const payload = {
    slug,
    title,
    author: parts.map((p) => p.author).filter(Boolean)[0] || '',
    category: body.category || parts[0].category || 'Books',
    description: String(body.description || '').trim()
      || `${title}. A ${parts.length}-book set: ${parts.map((p) => p.title).join(', ')}. `
       + `Buy all ${parts.length} together for ₹${price} instead of ₹${sumPrice} separately. `
       + `Genuine paperbacks, fast pan-India delivery, cash on delivery available at Ink & Chai.`,
    price_inr: price,
    original_price_inr: sumMrp,
    image_url: body.image_url || parts.find((p) => p.image)?.image || '',
    // The component list is what makes this a bundle rather than a product with
    // a "+" in its name, so it is recorded rather than inferred from the title.
    tags: [`bundle`, `combo-${parts.length}`, ...parts.map((p) => `bundle-of:${p.slug}`)].join(', ').slice(0, 700),
    seo_title: `${title} | Buy Online in India | Ink & Chai`.slice(0, 220),
    is_active: body.is_active !== false,
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await supabase
    .from('custom_products')
    .upsert(payload, { onConflict: 'slug' })
    .select()
    .single();
  if (error) return json(500, { error: error.message });

  return json(200, {
    success: true,
    product: data,
    url: `/product/${data.slug}/`,
    sum_price_inr: sumPrice,
    saving_inr: money(sumPrice - price),
    components: parts.map((p) => ({ slug: p.slug, title: p.title, price: p.price })),
  });
};
