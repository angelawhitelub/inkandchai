const { createClient } = require('@supabase/supabase-js');
const { purgeCacheTags } = require('./utils/purge-cache');
const { requireAdmin } = require('./utils/admin-auth');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key',
  'Content-Type': 'application/json',
};

function cleanText(value, max = 1000) {
  const text = String(value || '').replace(/\r\n/g, '\n').trim();
  return text ? text.slice(0, max) : null;
}

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function money(value, required = false) {
  const n = Number(String(value || '').replace(/[^0-9.]/g, ''));
  if (!Number.isFinite(n) || n <= 0) {
    if (required) throw new Error('Enter a valid product price.');
    return null;
  }
  return n.toFixed(2);
}

function extensionFromMime(mime) {
  if (mime === 'image/png') return 'png';
  if (mime === 'image/webp') return 'webp';
  return 'jpg';
}

function slugWithSuffix(baseSlug, sequence) {
  if (sequence <= 1) return baseSlug.slice(0, 80);
  const suffix = `-${sequence}`;
  return `${baseSlug.slice(0, 80 - suffix.length).replace(/-+$/g, '')}${suffix}`;
}

// Creating two listings whose titles slug the same used to silently overwrite
// the first one — the upsert below keys on slug, so the second save replaced
// the price, description and images of a live product. Creation now takes the
// next free -2/-3 slug instead; edits still address their listing directly.
async function nextAvailableSlug(supabase, baseSlug) {
  const { data, error } = await supabase
    .from('custom_products')
    .select('slug')
    .like('slug', `${baseSlug}%`)
    .limit(1000);
  if (error) throw error;

  const occupied = new Set((data || []).map(row => String(row.slug || '').toLowerCase()));
  for (let sequence = 1; sequence <= 1001; sequence += 1) {
    const candidate = slugWithSuffix(baseSlug, sequence);
    if (!occupied.has(candidate)) return candidate;
  }
  throw new Error('Could not allocate a unique product URL. Please use a more specific title.');
}

async function uploadImageIfPossible(supabase, slug, imageDataUrl) {
  const image = String(imageDataUrl || '');
  if (!image.startsWith('data:image/')) return cleanText(image, 4000);

  const match = image.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (!match) return image;

  const mime = match[1];
  const buffer = Buffer.from(match[2], 'base64');
  if (buffer.length > 4 * 1024 * 1024) {
    throw new Error('Image is too large. Please upload a cover below 4 MB.');
  }

  const bucket = 'product-images';
  const ext = extensionFromMime(mime);
  const filePath = `custom/${slug}-${Date.now()}.${ext}`;

  try {
    await supabase.storage.createBucket(bucket, { public: true }).catch(() => {});
    const { error } = await supabase.storage
      .from(bucket)
      .upload(filePath, buffer, { contentType: mime, upsert: true });
    if (error) throw error;
    const { data } = supabase.storage.from(bucket).getPublicUrl(filePath);
    if (data?.publicUrl) return data.publicUrl;
  } catch (err) {
    console.warn('product image storage upload failed, falling back to inline image:', err.message);
  }

  return image;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  const _adminBlock = requireAdmin(event, CORS); if (_adminBlock) return _adminBlock;
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'SUPABASE_URL and SUPABASE_SERVICE_KEY are required.' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  try {
    const title = cleanText(body.title, 220);
    if (!title) throw new Error('Product title is required.');
    const createOnly = body.mode === 'create';
    const baseSlug = slugify(createOnly ? title : (body.slug || title));
    if (!baseSlug) throw new Error('Could not create a product URL slug.');

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const productSlug = createOnly ? await nextAvailableSlug(supabase, baseSlug) : baseSlug;
    const imageUrl = await uploadImageIfPossible(supabase, productSlug, body.image_data_url || body.image_url);

    // Extra product images (back cover, spreads…) → gallery_images (array of URLs).
    // Accept an array, upload any data URLs, keep plain URLs as-is. Cap at 8.
    let galleryImages;
    if (Array.isArray(body.gallery_images)) {
      galleryImages = [];
      for (const g of body.gallery_images.slice(0, 8)) {
        const u = await uploadImageIfPossible(supabase, `${productSlug}-g`, g);
        if (u) galleryImages.push(u);
      }
    }

    const payload = {
      slug: productSlug,
      title,
      author: cleanText(body.author, 140),
      category: cleanText(body.category, 140) || 'Books',
      description: cleanText(body.description, 5000) || `Buy ${title} online at Ink & Chai. Fast pan-India delivery, COD and prepaid payment available.`,
      price_inr: money(body.price_inr, true),
      original_price_inr: money(body.original_price_inr, false),
      image_url: imageUrl,
      publisher: cleanText(body.publisher, 160),
      isbn: cleanText(body.isbn, 80),
      seo_title: cleanText(body.seo_title, 220) || `${title} | Buy Online in India | Ink & Chai`,
      meta_description: cleanText(body.meta_description, 300),
      tags: cleanText(body.tags, 700),
      is_active: body.is_active !== false,
      updated_at: new Date().toISOString(),
    };
    // "About the author" copy. Omitted (undefined) preserves whatever is
    // stored; an explicit empty string clears the section.
    if (body.author_bio !== undefined) payload.author_bio = cleanText(body.author_bio, 5000);
    // Binding and language. Both were hard-coded as Paperback/English on the
    // product page, which is wrong for the Hindi editions and for the handful
    // of hardbacks. Omitted preserves what is stored; empty falls back to the
    // store default at render time rather than printing a blank row.
    if (body.format !== undefined) payload.format = cleanText(body.format, 60);
    if (body.language !== undefined) payload.language = cleanText(body.language, 60);
    // Preserve an existing gallery when this update only changes listing data.
    // Supplying an explicit array (including []) still replaces/clears it.
    if (galleryImages !== undefined) payload.gallery_images = galleryImages;

    let { data, error } = await supabase
      .from('custom_products')
      .upsert(payload, { onConflict: 'slug' })
      .select()
      .single();
    // Resilience: these columns were added after the table shipped, so a
    // database that hasn't had the migration run yet rejects the whole upsert.
    // Rather than fail the save — losing the price and description edits with
    // it — drop whichever column the error names and retry, then say so.
    const OPTIONAL_COLUMNS = [
      { key: 'author_bio', fix: 'run sql/custom_products_author_bio.sql' },
      { key: 'format', fix: 'run sql/custom_products_format_language.sql' },
      { key: 'language', fix: 'run sql/custom_products_format_language.sql' },
    ];
    const dropped = [];
    let retryPayload = payload;
    for (let attempt = 0; attempt < OPTIONAL_COLUMNS.length && error; attempt++) {
      const missing = OPTIONAL_COLUMNS.find(c => c.key in retryPayload
        && new RegExp(`\\b${c.key}\\b`, 'i').test(error.message || ''));
      if (!missing) break;
      const { [missing.key]: _drop, ...without } = retryPayload;
      retryPayload = without;
      dropped.push(missing);
      ({ data, error } = await supabase
        .from('custom_products')
        .upsert(retryPayload, { onConflict: 'slug' })
        .select()
        .single());
    }
    if (error) throw error;
    // A custom listing is part of the same edge-cached storefront feed, so its
    // saves have to invalidate it too — otherwise the panel shows the new price
    // and the shop shows the old one.
    await purgeCacheTags(['product-overrides']);
    if (dropped.length) {
      const fixes = [...new Set(dropped.map(d => d.fix))].join(' and ');
      return {
        statusCode: 200,
        headers: CORS,
        body: JSON.stringify({
          success: true,
          product: data,
          url: `/product/${data.slug}/`,
          warning: `Saved, but ${dropped.map(d => d.key).join(', ')} ${dropped.length > 1 ? 'were' : 'was'} ignored — ${fixes} to enable ${dropped.length > 1 ? 'them' : 'it'}.`,
        }),
      };
    }

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        success: true,
        product: data,
        url: `/product/${data.slug}/`,
      }),
    };
  } catch (err) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
