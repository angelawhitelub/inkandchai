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
    // The manifest used to hard-code 'video' here, which quietly rewrote every
    // stored type on the way out: a still could be uploaded but never read back
    // as one. The kind of a reel is decided at upload and preserved.
    type: String(value?.type || '').toLowerCase() === 'image' ? 'image' : 'video',
    created_at: String(value?.created_at || ''),
    position: Math.max(1, Number(value?.position) || 1),
  };
}

async function ensureBucket(supabase) {
  await supabase.storage.createBucket(BUCKET, { public: true }).catch(() => {});
}

const MAX_HIDDEN = 200;

function sortItems(items) {
  return (Array.isArray(items) ? items : [])
    .map(cleanItem).filter(Boolean)
    .sort((a, b) => a.position - b.position || a.created_at.localeCompare(b.created_at))
    .slice(0, MAX_REELS);
}

/**
 * The built-in reels are baked into every product page at build time, so they
 * cannot be deleted the way an uploaded one can. Hiding is by source URL, held
 * in the same manifest: the storefront drops any built-in whose src is listed.
 */
function cleanHidden(list) {
  return [...new Set((Array.isArray(list) ? list : [])
    .map(v => String(v || '').trim())
    .filter(v => /^https?:\/\//i.test(v) || v.startsWith('/')))].slice(0, MAX_HIDDEN);
}

const EMPTY = { items: [], hidden: [] };

/**
 * Read the manifest, defeating the storage CDN.
 *
 * supabase.storage.download() is served through a cache, and the manifest
 * object was created with a default cacheControl that an upsert does not
 * reset. That turned every upload into a lost update: each one read a stale
 * list, appended its own item, and wrote the whole array back -- overwriting
 * whatever the previous upload had just added. Uploads reported success and
 * then vanished, which is exactly what happened to a batch of screenshots.
 *
 * A one-per-request cache-buster on the authenticated object endpoint is
 * enough; there is no supported way to pass one through download(). The
 * client is kept as the fallback so a change in that endpoint degrades to the
 * old behaviour rather than breaking reads outright.
 */
async function readManifest() {
  const base = String(process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (base && key) {
    try {
      const url = `${base}/storage/v1/object/${BUCKET}/${MANIFEST_KEY}?_=${Date.now()}`;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${key}`, apikey: key, 'Cache-Control': 'no-cache' },
      });
      if (res.status === 404) return { ...EMPTY };
      if (res.ok) return parseManifest(await res.text());
      console.warn('[site-reels-store] fresh read failed with HTTP', res.status, '— falling back');
    } catch (err) {
      console.warn('[site-reels-store] fresh read failed:', err.message, '— falling back');
    }
  }

  const supabase = client();
  const { data, error } = await supabase.storage.from(BUCKET).download(MANIFEST_KEY);
  if (error) {
    // The manifest does not exist until the first admin upload.
    if (String(error.statusCode || error.status || '') === '404'
      || /not found|does not exist/i.test(String(error.message || ''))) return { ...EMPTY };
    throw error;
  }
  return parseManifest(await data.text());
}

function parseManifest(text) {
  let parsed;
  try { parsed = JSON.parse(text); }
  catch { return { ...EMPTY }; }
  const items = Array.isArray(parsed) ? parsed : parsed?.items;
  return { items: sortItems(items), hidden: cleanHidden(parsed?.hidden) };
}

async function writeManifest({ items, hidden }) {
  const supabase = client();
  await ensureBucket(supabase);
  const clean = sortItems(items);
  const cleanHiddenList = cleanHidden(hidden);
  const payload = Buffer.from(JSON.stringify({ version: 1, items: clean, hidden: cleanHiddenList }, null, 2));
  const { error } = await supabase.storage.from(BUCKET).upload(MANIFEST_KEY, payload, {
    contentType: 'application/json; charset=utf-8',
    cacheControl: '0',
    upsert: true,
  });
  if (error) throw error;
  return { items: clean, hidden: cleanHiddenList };
}

async function readSiteReels() {
  return (await readManifest()).items;
}

async function readHiddenReels() {
  return (await readManifest()).hidden;
}

// Both writers re-read first so that saving one half never drops the other:
// the two live in one object, and a blind overwrite would un-hide every
// built-in reel the moment somebody uploaded a new one.
async function writeSiteReels(items) {
  const current = await readManifest();
  return (await writeManifest({ items, hidden: current.hidden })).items;
}

async function writeHiddenReels(hidden) {
  const current = await readManifest();
  return (await writeManifest({ items: current.items, hidden })).hidden;
}

module.exports = {
  BUCKET, MANIFEST_KEY, MAX_REELS, client, ensureBucket,
  readSiteReels, writeSiteReels, readHiddenReels, writeHiddenReels, readManifest,
};
