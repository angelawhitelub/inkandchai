const { createClient } = require('@supabase/supabase-js');
const { requireAdmin } = require('./utils/admin-auth');
const { handlingDays, isMissingTable } = require('./utils/product-settings');
const { purgeCacheTags } = require('./utils/purge-cache');
const { catalogueBook } = require('./utils/catalog-content');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key, X-Admin-Token',
  'Content-Type': 'application/json',
};

function cleanText(v, max = 500) {
  const s = String(v || '').replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, max) : null;
}

function money(v) {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(String(v).replace(/[^0-9.]/g, ''));
  if (!Number.isFinite(n) || n < 0) return null;
  return n.toFixed(2);
}

// Manual stock quantity. Blank/omitted → null (in stock / unlimited). A number
// is clamped to a non-negative integer (0 = sold out). Cap avoids absurd values.
function stockQty(v) {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(9999999, Math.round(n)));
}

// The extension has to follow the real MIME: these handlers accept any
// `data:image/*`, so an AVIF used to be stored as ".jpg" while carrying
// contentType image/avif.
const MIME_EXTENSIONS = {
  'image/png': 'png',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/jpeg': 'jpg',
};

const PARTIAL_KEYS = ['price_inr', 'original_price_inr', 'stock_qty', 'scarcity'];

/**
 * A partial body filled out to the full row the handler expects: the stored
 * override and product_settings values, with the sent PARTIAL_KEYS on top.
 * With no override row yet, title/author/category come from the listing, as
 * the desktop form fills them, so a new row never carries a blank title.
 */
async function withStoredValues(supabase, slug, body) {
  const [row, setting] = await Promise.all([
    supabase.from('product_overrides').select('*').ilike('slug', slug).maybeSingle(),
    supabase.from('product_settings').select('price_inr,original_price_inr,handling_days').eq('slug', slug).maybeSingle(),
  ]);
  if (row.error) throw row.error;
  const o = row.data;
  const s = setting.error ? null : setting.data;   // the table may not exist yet
  let base = o;
  if (!base) {
    const custom = await supabase.from('custom_products').select('title,author,category').eq('slug', slug).maybeSingle();
    base = (custom.data && custom.data.title) ? custom.data : catalogueBook(slug);
    if (!base || !base.title) throw new Error(`No product with slug "${slug}"`);
  }
  const pick = (key) => (s && s[key] !== null && s[key] !== undefined ? s[key] : o ? o[key] : null);
  const full = {
    slug,
    title: base.title,
    author: base.author,
    category: base.category,
    price_inr: pick('price_inr'),
    original_price_inr: pick('original_price_inr'),
    handling_days: s ? s.handling_days : null,
    scarcity: o ? o.scarcity === true : false,
    stock_qty: o ? o.stock_qty : null,
    is_active: o ? o.is_active !== false : true,
    image_url: o ? o.image_url || '' : '',
  };
  for (const key of PARTIAL_KEYS) if (Object.prototype.hasOwnProperty.call(body, key)) full[key] = body[key];
  return full;
}

function extensionFromMime(mime) {
  return MIME_EXTENSIONS[String(mime || '').toLowerCase()] || 'jpg';
}

async function uploadImage(supabase, slug, value) {
  const image = String(value || '').trim();
  if (!image.startsWith('data:image/')) return image.slice(0, 4000) || null;
  const match = image.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (!match) throw new Error('Invalid image upload');
  const buffer = Buffer.from(match[2], 'base64');
  if (buffer.length > 4 * 1024 * 1024) throw new Error('Image is too large. Use an image below 4 MB.');
  const bucket = 'product-images';
  const path = `overrides/${slug}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${extensionFromMime(match[1])}`;
  await supabase.storage.createBucket(bucket, { public: true }).catch(() => {});
  const { error } = await supabase.storage.from(bucket).upload(path, buffer, {
    contentType: match[1],
    upsert: false,
  });
  if (error) throw error;
  const { data } = supabase.storage.from(bucket).getPublicUrl(path);
  if (!data?.publicUrl) throw new Error('Could not create a public image URL');
  return data.publicUrl;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method Not Allowed' }) };

  const _adminBlock = requireAdmin(event, CORS); if (_adminBlock) return _adminBlock;
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'SUPABASE_URL and SUPABASE_SERVICE_KEY are required.' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  // LOWERCASE on write. get-product-overrides lowercases the slug it looks up
  // and then does a case-sensitive .eq(), so a row saved as "...-NG-HI" can
  // never be read back — the override silently does nothing. 13 rows (12 of
  // them price overrides, one a product video) were stranded exactly this way.
  const slug = cleanText(body.slug, 160).toLowerCase();
  if (!slug) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Missing product slug' }) };

  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    // partial: true -- the mobile admin's quick edit (public/admin/m/). Only the
    // keys it sends change; every other column keeps its stored value. The
    // desktop form always sends the whole row, so a full replace is right
    // there, but a phone screen showing four fields must not blank the rest.
    if (body.partial === true) body = await withStoredValues(supabase, slug, body);
    const imageValue = body.image_data_url !== undefined ? body.image_data_url : body.image_url;
    const imageUrl = await uploadImage(supabase, slug, imageValue);
    let galleryImages;
    if (Array.isArray(body.gallery_images)) {
      galleryImages = [];
      for (const value of body.gallery_images.slice(0, 8)) {
        const url = await uploadImage(supabase, `${slug}-gallery`, value);
        if (url) galleryImages.push(url);
      }
    }

    const payload = {
    slug,
    title: cleanText(body.title, 220),
    author: cleanText(body.author, 120),
    category: cleanText(body.category, 120),
    price_inr: money(body.price_inr),
    original_price_inr: money(body.original_price_inr),
    // scarcity: shows "Only 4 left" urgency badge — always pinned, never runs out
    scarcity: body.scarcity === true || body.scarcity === 'true',
    // stock_qty: manual inventory. null (field omitted/blank) = in stock / unlimited;
    // 0 or less = sold out → storefront shows "Coming Soon". Clamped to a sane int.
    stock_qty: stockQty(body.stock_qty),
    // publisher_sourced: the "Genuine — Publisher Sourced" badge, for catalogue
    // books as well as admin-created listings. Tri-state: omit the key entirely
    // and the stored value is left alone, so a caller that predates this field
    // cannot silently clear a badge someone set.
    ...(body.publisher_sourced === undefined || body.publisher_sourced === null
      ? {}
      : { publisher_sourced: body.publisher_sourced === true || body.publisher_sourced === 'true' }),
    is_active: body.is_active !== false,
    image_url: imageUrl,
    updated_at: new Date().toISOString(),
    };
    // Omitted means preserve the current gallery; [] explicitly clears it.
    if (galleryImages !== undefined) payload.gallery_images = galleryImages;
    // Resilience: these columns come from optional migrations. Rather than fail
    // the whole save when one hasn't been run, drop the offending key and retry
    // — that field simply won't persist until the migration is applied. The
    // longest matching name wins so an error naming `publisher_sourced` is not
    // attributed to some shorter column whose name is a prefix of it.
    const OPTIONAL_COLUMNS = {
      stock_qty: 'stock quantity was ignored — run sql/product_stock.sql to enable it',
      publisher_sourced: 'the Publisher Sourced badge was ignored — run sql/product_overrides_publisher_sourced.sql to enable it',
    };
    const attempt = { ...payload };
    const skipped = [];
    let data = null, error = null;
    for (let i = 0; i <= Object.keys(OPTIONAL_COLUMNS).length; i++) {
      ({ data, error } = await supabase
        .from('product_overrides')
        .upsert(attempt, { onConflict: 'slug' })
        .select()
        .single());
      if (!error) break;
      const msg = String(error.message || '');
      const missing = Object.keys(OPTIONAL_COLUMNS)
        .filter(col => col in attempt && msg.includes(col))
        .sort((a, b) => b.length - a.length)[0];
      if (!missing) break;
      delete attempt[missing];
      skipped.push(OPTIONAL_COLUMNS[missing]);
    }
    if (error) throw error;

    // Price, MRP and handling time are written to product_settings as well, and
    // that copy is what every reader prefers. It is deliberately NOT governed by
    // is_active: "Disable Override" hands presentation back to the catalogue but
    // must not silently undo a price the admin set. Saving the price box empty
    // clears it here, which is how a product goes back to the catalogue price.
    const settingsRow = {
      slug,
      price_inr: payload.price_inr,
      original_price_inr: payload.original_price_inr,
      handling_days: handlingDays(body.handling_days),
      updated_at: payload.updated_at,
    };
    const hasSetting = settingsRow.price_inr !== null
      || settingsRow.original_price_inr !== null
      || settingsRow.handling_days !== null;
    const settingsResult = hasSetting
      ? await supabase.from('product_settings').upsert(settingsRow, { onConflict: 'slug' })
      : await supabase.from('product_settings').delete().eq('slug', slug);
    if (settingsResult.error) {
      if (isMissingTable(settingsResult.error)) {
        skipped.push('the live price and handling time were only stored on the override — run sql/product_settings.sql so they survive "Disable Override"');
      } else {
        skipped.push(`the live price/handling copy failed (${settingsResult.error.message})`);
      }
    }

    // The storefront feed is edge-cached for up to an hour. Without this the
    // admin saves a price, reloads the product page, and still sees the old one
    // until the TTL expires — which is exactly what it looks like when a save
    // has silently failed.
    const purge = await purgeCacheTags(['product-overrides']);

    const warning = skipped.length ? `Saved, but ${skipped.join('; ')}.` : undefined;
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ success: true, override: data, cache_purged: purge.purged, ...(warning ? { warning } : {}) }),
    };
  } catch (err) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
