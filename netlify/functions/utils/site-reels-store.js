const { createClient } = require('@supabase/supabase-js');

// Reel metadata lives beside product media instead of in a database table.
// That keeps this admin feature migration-free while still allowing every
// generated and dynamic product page to discover new uploads immediately.
const BUCKET = 'product-images';
const MANIFEST_KEY = 'reels/admin-manifest.json';
const MAX_REELS = 100;

function client() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_KEY are required.');
  }
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
}

function cleanItem(value) {
  const src = String(value?.src || '').trim();
  if (!/^https:\/\//i.test(src)) return null;
  const poster = String(value?.poster || '').trim();
  return {
    id: String(value?.id || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 100),
    src,
    poster: /^https:\/\//i.test(poster) ? poster : '',
    caption: String(value?.caption || '').trim().slice(0, 180),
    instagram: '',
    type: 'video',
    created_at: String(value?.created_at || ''),
    position: Math.max(1, Number(value?.position) || 1),
  };
}

async function ensureBucket(supabase) {
  await supabase.storage.createBucket(BUCKET, { public: true }).catch(() => {});
}

async function readSiteReels() {
  const supabase = client();
  const { data, error } = await supabase.storage.from(BUCKET).download(MANIFEST_KEY);
  if (error) {
    // The manifest does not exist until the first admin upload.
    if (String(error.statusCode || error.status || '') === '404'
      || /not found|does not exist/i.test(String(error.message || ''))) return [];
    throw error;
  }
  let parsed;
  try { parsed = JSON.parse(await data.text()); }
  catch { return []; }
  const items = Array.isArray(parsed) ? parsed : parsed?.items;
  return (Array.isArray(items) ? items : [])
    .map(cleanItem).filter(Boolean)
    .sort((a, b) => a.position - b.position || a.created_at.localeCompare(b.created_at))
    .slice(0, MAX_REELS);
}

async function writeSiteReels(items) {
  const supabase = client();
  await ensureBucket(supabase);
  const clean = (Array.isArray(items) ? items : [])
    .map(cleanItem).filter(Boolean)
    .sort((a, b) => a.position - b.position || a.created_at.localeCompare(b.created_at))
    .slice(0, MAX_REELS);
  const payload = Buffer.from(JSON.stringify({ version: 1, items: clean }, null, 2));
  const { error } = await supabase.storage.from(BUCKET).upload(MANIFEST_KEY, payload, {
    contentType: 'application/json; charset=utf-8',
    cacheControl: '0',
    upsert: true,
  });
  if (error) throw error;
  return clean;
}

module.exports = { BUCKET, MANIFEST_KEY, MAX_REELS, client, ensureBucket, readSiteReels, writeSiteReels };
