const { createClient } = require('@supabase/supabase-js');
const { purgeAplus } = require('./utils/purge-cache');
const { requireAdmin } = require('./utils/admin-auth');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key, X-Admin-Token',
  'Content-Type': 'application/json',
};

function cleanText(value, max) {
  const text = String(value || '').replace(/\r\n/g, '\n').trim();
  return text ? text.slice(0, max) : null;
}

function cleanSlug(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 160);
}

function extensionFromMime(mime) {
  if (mime === 'image/png') return 'png';
  if (mime === 'image/webp') return 'webp';
  return 'jpg';
}

async function storeImage(supabase, slug, index, value) {
  const image = String(value || '').trim();
  if (!image.startsWith('data:image/')) return cleanText(image, 4000);
  const match = image.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (!match) throw new Error(`A+ module ${index + 1} has an invalid image.`);
  const mime = match[1];
  const buffer = Buffer.from(match[2], 'base64');
  if (buffer.length > 4 * 1024 * 1024) throw new Error(`A+ module ${index + 1} image must be below 4 MB.`);

  const bucket = 'product-images';
  const filePath = `aplus/${slug}-${index + 1}-${Date.now()}.${extensionFromMime(mime)}`;
  await supabase.storage.createBucket(bucket, { public: true }).catch(() => {});
  const { error } = await supabase.storage.from(bucket).upload(filePath, buffer, { contentType: mime, upsert: true });
  if (error) throw error;
  const { data } = supabase.storage.from(bucket).getPublicUrl(filePath);
  return data?.publicUrl || null;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  const blocked = requireAdmin(event, CORS); if (blocked) return blocked;
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Supabase is not configured.' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const slug = cleanSlug(body.slug);
  if (!slug) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Missing product slug' }) };

  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const incoming = Array.isArray(body.blocks) ? body.blocks.slice(0, 8) : [];
    const blocks = [];
    for (let index = 0; index < incoming.length; index += 1) {
      const block = incoming[index] || {};
      const imageUrl = await storeImage(supabase, slug, index, block.image_url || block.image_data_url);
      const layout = ['wide', 'image-left', 'image-right'].includes(block.layout) ? block.layout : 'wide';
      const next = {
        layout,
        heading: cleanText(block.heading, 180),
        body: cleanText(block.body, 1500),
        image_url: imageUrl,
        image_alt: cleanText(block.image_alt, 220),
      };
      if (next.heading || next.body || next.image_url) blocks.push(next);
    }

    const payload = {
      slug,
      heading: cleanText(body.heading, 180),
      intro: cleanText(body.intro, 1200),
      blocks,
      is_active: body.is_active !== false,
      updated_at: new Date().toISOString(),
    };
    const { data, error } = await supabase
      .from('product_aplus_content')
      .upsert(payload, { onConflict: 'slug' })
      .select()
      .single();
    if (error) throw error;
    // A+ modules are read through a cached endpoint AND embedded in the Lambda
    // product page, so both have to be invalidated or the save is invisible.
    const purge = await purgeAplus();
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ success: true, content: data, cache_purged: purge.purged }) };
  } catch (err) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
