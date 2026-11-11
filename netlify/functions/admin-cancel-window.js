/**
 * Netlify Function: admin-cancel-window   (admin)
 *
 * The owner's "cancel until shipped" switch (utils/cancel-window).
 *   GET               → { on, updated_at, by }
 *   POST { on: bool } → { on, updated_at, by }
 *
 * ON: paid orders with no AWB can be cancelled by the customer (My Orders,
 * WhatsApp bot) for a full refund. OFF: the cancellation window is closed and
 * the usual rules apply. My Orders and the bot see a change within a minute.
 */

const { requireAdmin, getAdminPayload } = require('./utils/admin-auth');
const W = require('./utils/cancel-window');

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
  try {
    if (event.httpMethod === 'GET') return json(200, await W.readState());
    if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });
    let body;
    try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }
    if (typeof body.on !== 'boolean') return json(400, { error: 'Send { on: true } or { on: false }' });
    let by = null;
    try { const who = getAdminPayload(event); by = (who && (who.sub || who.email)) || null; } catch { by = null; }
    const doc = await W.setUntilShipped(body.on, { by });
    console.log(`[admin-cancel-window] cancel until shipped → ${doc.on ? 'OPEN' : 'CLOSED'}${by ? ` by ${by}` : ''}`);
    return json(200, doc);
  } catch (e) {
    console.error('[admin-cancel-window]', e);
    return json(500, { error: e.message });
  }
};
