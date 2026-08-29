const fs = require('fs');
const path = require('path');
const { requireAdmin } = require('./utils/admin-auth');
const { readManifest, writeSiteReels, writeHiddenReels } = require('./utils/site-reels-store');

/**
 * The reels that ship with the site, read from the same file the build reads.
 *
 * They are baked into every product page, so the admin panel has no other way
 * to know what it is being asked to hide.
 */
function builtinReels() {
  const candidates = [
    path.join(process.cwd(), 'data', 'social_proof.json'),
    path.join(__dirname, '..', '..', 'data', 'social_proof.json'),
    path.join('/var/task', 'data', 'social_proof.json'),
  ];
  const found = candidates.find(c => fs.existsSync(c));
  if (!found) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(found, 'utf8'));
    return (parsed.items || []).filter(it => it && it.src).map(it => ({
      src: String(it.src),
      poster: String(it.poster || ''),
      caption: String(it.caption || ''),
      type: String(it.type || 'video'),
    }));
  } catch (err) {
    console.warn('[admin-site-reels] could not read built-in reels:', err.message);
    return [];
  }
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key, X-Admin-Token',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Content-Type': 'application/json; charset=utf-8',
};
const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  const blocked = requireAdmin(event, CORS);
  if (blocked) return blocked;
  try {
    if (event.httpMethod === 'GET') {
      const { items, hidden } = await readManifest();
      return json(200, { items, hidden, builtin: builtinReels() });
    }
    if (event.httpMethod === 'DELETE') {
      const params = event.queryStringParameters || {};
      const id = String(params.id || '').trim();
      const src = String(params.src || '').trim();
      // Hiding a built-in rather than deleting it: the file is baked into the
      // deployed pages, and it can be brought back without a rebuild.
      if (src) {
        const { hidden } = await readManifest();
        if (hidden.includes(src)) return json(200, { success: true, hidden });
        const next = await writeHiddenReels([...hidden, src]);
        return json(200, { success: true, hidden: next });
      }
      if (!id) return json(400, { error: 'Missing reel id' });
      const { items } = await readManifest();
      const next = items.filter(item => item.id !== id);
      if (next.length === items.length) return json(404, { error: 'Reel not found' });
      await writeSiteReels(next);
      return json(200, { success: true, items: next });
    }
    if (event.httpMethod === 'POST') {
      let body;
      try { body = JSON.parse(event.body || '{}'); }
      catch { return json(400, { error: 'Invalid JSON' }); }
      const restore = String(body.restore || '').trim();
      if (!restore) return json(400, { error: 'Nothing to restore' });
      const { hidden } = await readManifest();
      const next = await writeHiddenReels(hidden.filter(v => v !== restore));
      return json(200, { success: true, hidden: next });
    }
    return json(405, { error: 'Method Not Allowed' });
  } catch (error) {
    console.error('[admin-site-reels]', error.message);
    return json(500, { error: error.message });
  }
};
