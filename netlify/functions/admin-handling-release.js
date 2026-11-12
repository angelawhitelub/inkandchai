/**
 * Netlify Function: admin-handling-release   (admin)
 *
 * "Push anyway" for orders held by a book's extra handling time
 * (utils/handling-release). Sends nothing to anyone and books nothing: it only
 * lets the named orders through the handling hold, so the next courier run
 * (XpressBees, NimbusPost, ...) picks them up. Pre-orders stay held.
 *
 *   POST { order_ids: ["IC-..."], on: true }   release
 *   POST { order_ids: ["IC-..."], on: false }  hold again
 */

const { requireAdmin, getAdminPayload } = require('./utils/admin-auth');
const R = require('./utils/handling-release');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key, X-Admin-Token',
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
};
const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  const blocked = requireAdmin(event, CORS);
  if (blocked) return blocked;
  if (event.httpMethod !== 'POST') return json(405, { error: 'POST only' });
  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }
  if (!Array.isArray(body.order_ids) || !body.order_ids.length) return json(400, { error: 'Send { order_ids: [...], on: true }' });
  if (typeof body.on !== 'boolean') return json(400, { error: 'Send on: true (push anyway) or on: false (hold again)' });
  let by = null;
  try { const who = getAdminPayload(event); by = (who && (who.sub || who.email)) || null; } catch { by = null; }
  try {
    const out = await R.setReleased(body.order_ids, body.on, { by });
    console.log(`[admin-handling-release] ${out.on ? 'released' : 're-held'} ${out.released.length} order(s)${by ? ` by ${by}` : ''}`);
    return json(200, out);
  } catch (e) {
    console.error('[admin-handling-release]', e);
    return json(400, { error: e.message });
  }
};
