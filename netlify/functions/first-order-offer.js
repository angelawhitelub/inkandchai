/**
 * Public endpoint: first-order-offer
 *
 *   POST { phone, email? } -> { eligible: boolean, percent: 5, code: 'FIRST5', label }
 *
 * The checkout page asks this once the phone number is typed, so the summary
 * shows the same total the till will charge (utils/first-order). It decides
 * nothing: create-order, phonepe-create-order and cod-order each check again.
 * A lookup failure answers eligible:false, matching the tills.
 *
 * Read-only. Same-origin only (no wildcard CORS), POST so the number never
 * sits in a URL or a log line.
 */

const { createClient } = require('@supabase/supabase-js');
const { ALLOWED_ORIGINS } = require('./ink-ai');
const { FIRST_ORDER, hasOrderedBefore, last10 } = require('./utils/first-order');

function cors(event) {
  const origin = (event.headers && (event.headers.origin || event.headers.Origin)) || '';
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
  };
}

async function handle(event = {}, deps = {}) {
  const headers = { ...cors(event), 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'POST only' }) };

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch { /* answered below */ }
  const offer = { percent: FIRST_ORDER.percent, code: FIRST_ORDER.code, label: FIRST_ORDER.label };
  if (last10(body.phone).length !== 10) {
    return { statusCode: 200, headers, body: JSON.stringify({ eligible: false, ...offer, reason: 'phone' }) };
  }
  const supabase = deps.supabase || createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const before = await hasOrderedBefore(supabase, { phone: body.phone, email: body.email });
  return { statusCode: 200, headers, body: JSON.stringify({ eligible: before === false, ...offer }) };
}

exports.handler = (event) => handle(event, {});
exports._test = { handle };
