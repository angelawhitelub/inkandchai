/**
 * Netlify Function: admin-ship-holidays   (owner)
 *
 * The days dispatch is closed (utils/ship-holidays). Product pages leave them out
 * of the ship-by date and the delivery estimate.
 *
 *   GET                                       → { items: [{ from, to, note }] }
 *   POST { action: 'add', from, to?, note? }  → { items }
 *   POST { action: 'remove', from, to }       → { items }
 */

const { requireAdmin } = require('./utils/admin-auth');
const H = require('./utils/ship-holidays');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key, X-Admin-Token',
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
};
const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });

exports.handler = async (event = {}) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  const blocked = requireAdmin(event, CORS);
  if (blocked) return blocked;
  try {
    if (event.httpMethod === 'GET') return json(200, { items: await H.readHolidays() });
    if (event.httpMethod !== 'POST') return json(405, { error: 'GET or POST only' });
    let body;
    try { body = JSON.parse(event.body || '{}') || {}; } catch { return json(400, { error: 'Invalid JSON' }); }
    if (body.action === 'add') {
      const out = await H.addHoliday(body);
      return out.error ? json(400, { error: out.error }) : json(200, { items: out.items });
    }
    if (body.action === 'remove') return json(200, await H.removeHoliday(body));
    return json(400, { error: "action must be 'add' or 'remove'" });
  } catch (e) {
    console.error('[admin-ship-holidays]', e);
    return json(500, { error: e.message });
  }
};
