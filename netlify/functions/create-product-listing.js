const { createClient } = require('@supabase/supabase-js');

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

  const adminKey = process.env.ADMIN_SECRET;
  const sentKey = event.headers['x-admin-key'];
  if (!adminKey || sentKey !== adminKey) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Unauthorized' }) };
  }
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'SUPABASE_URL and SUPABASE_SERVICE_KEY are required.' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  try {
    const title = cleanText(body.title, 220);
    if (!title) throw new Error('Product title is required.');
    const baseSlug = slugify(body.slug || title);
    if (!baseSlug) throw new Error('Could not create a product URL slug.');

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const imageUrl = await uploadImageIfPossible(supabase, baseSlug, body.image_data_url || body.image_url);

    const payload = {
      slug: baseSlug,
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

    const { data, error } = await supabase
      .from('custom_products')
      .upsert(payload, { onConflict: 'slug' })
      .select()
      .single();
    if (error) throw error;

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
