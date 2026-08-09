const { createClient } = require('@supabase/supabase-js');
const { requireAdmin } = require('./utils/admin-auth');

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

function extensionFromMime(mime) {
  if (mime === 'image/png') return 'png';
  if (mime === 'image/webp') return 'webp';
  return 'jpg';
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
    is_active: body.is_active !== false,
    image_url: imageUrl,
    updated_at: new Date().toISOString(),
    };
    // Omitted means preserve the current gallery; [] explicitly clears it.
    if (galleryImages !== undefined) payload.gallery_images = galleryImages;
    let { data, error } = await supabase
      .from('product_overrides')
      .upsert(payload, { onConflict: 'slug' })
      .select()
      .single();
    // Resilience: if sql/product_stock.sql hasn't been run yet, the stock_qty
    // column won't exist. Rather than fail the whole save, retry once without it
    // (stock simply won't persist until the migration is applied).
    if (error && /stock_qty/i.test(error.message || '')) {
      const { stock_qty, ...withoutStock } = payload;
      ({ data, error } = await supabase
        .from('product_overrides')
        .upsert(withoutStock, { onConflict: 'slug' })
        .select()
        .single());
      if (!error) {
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ success: true, override: data, warning: 'Saved, but stock quantity was ignored — run sql/product_stock.sql to enable it.' }) };
      }
    }
    if (error) throw error;
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ success: true, override: data }) };
  } catch (err) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
