/**
 * Netlify Function: ad-spend-ingest
 * POST /.netlify/functions/ad-spend-ingest
 * Header: X-Ad-Spend-Key: <AD_SPEND_KEY>
 * Body:   { platform: 'google', account: '123-456-7890', currency: 'INR',
 *           rows: [{ date: '2026-10-19', cost: 1234.5, clicks, impressions, conversions }] }
 *
 * Where the Google Ads script (scripts/google-ads-spend.gs, pasted into each
 * Google Ads account under Tools → Bulk actions → Scripts, run hourly) sends
 * that account's spend per day. A script inside the account needs no developer
 * token or OAuth app, which the Google Ads API would.
 *
 * Writes ad spend figures only. Reads nothing back and touches no order.
 */

const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const S = require('./utils/ad-spend');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Ad-Spend-Key',
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
};
const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });
const MIGRATION = 'The ad_spend_daily table is missing — run sql/ad_spend_daily.sql in Supabase first.';

function keyOk(given) {
  const want = String(process.env.AD_SPEND_KEY || '');
  const got = String(given || '');
  if (want.length < 16 || got.length !== want.length) return false;
  return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });
  const headers = event.headers || {};
  if (!keyOk(headers['x-ad-spend-key'] || headers['X-Ad-Spend-Key'])) return json(401, { error: 'Unauthorized' });
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) return json(500, { error: 'Supabase is not configured.' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }
  if (body.platform !== 'google') return json(400, { error: 'Only platform "google" is posted here; Meta is pulled by meta-ad-spend-scheduled.' });
  if (String(body.currency || 'INR').toUpperCase() !== 'INR') return json(400, { error: `Account bills in ${body.currency}; only INR is supported.` });

  const norm = S.normalizeRows('google', body.account, body.rows);
  if (norm.error) return json(400, { error: norm.error });

  try {
    const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const saved = await S.upsertRows(db, norm.rows);
    return json(200, { ok: true, saved, account: norm.rows[0].account });
  } catch (e) {
    return json(e.missingTable ? 503 : 500, { error: e.missingTable ? MIGRATION : e.message });
  }
};
