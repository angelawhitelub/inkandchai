/**
 * Netlify Function: admin-not-picked-up
 * GET /.netlify/functions/admin-not-picked-up?min_hours=48&days=30   (admin)
 *
 * Orders placed at least `min_hours` ago (default 48) that no courier has
 * picked up: either never booked, or booked and not moved. Read-only — the
 * admin "Not Picked Up" tab. Classification lives in utils/not-picked-up.js.
 */

const { createClient } = require('@supabase/supabase-js');
const { requireAdmin } = require('./utils/admin-auth');
const { DEFAULT_MIN_HOURS } = require('./utils/not-picked-up');
const { listNotPicked, REPORT_DAYS } = require('./utils/not-picked-up-list');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key, X-Admin-Token',
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
};
const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  const block = requireAdmin(event, CORS); if (block) return block;
  if (event.httpMethod !== 'GET') return json(405, { error: 'GET only' });

  const q = event.queryStringParameters || {};
  const minHours = Math.min(24 * 30, Math.max(1, Number(q.min_hours) || DEFAULT_MIN_HOURS));
  const days = Math.min(120, Math.max(3, Number(q.days) || REPORT_DAYS));
  const now = Date.now();

  try {
    const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const { rows, counts } = await listNotPicked(db, { minHours, days, now });
    return json(200, { generated_at: new Date(now).toISOString(), min_hours: minHours, days, counts, orders: rows });
  } catch (e) {
    console.error('[admin-not-picked-up]', e.message);
    return json(500, { error: e.message });
  }
};
