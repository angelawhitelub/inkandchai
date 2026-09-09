/**
 * Netlify Function: list-deleted-products
 * GET /.netlify/functions/list-deleted-products
 *
 * Admin — the takedown list behind "🗑 Delete Product Page", so a deletion is
 * something you can review and undo rather than a one-way action with no
 * record. Also reports whether the KV mirror the Worker actually reads is in
 * sync with the table, because that is the difference between "recorded" and
 * "the URL is really 410ing".
 *
 * Headers: X-Admin-Token / X-Admin-Key.
 */

const { createClient } = require('@supabase/supabase-js');
const { requireAdmin } = require('./utils/admin-auth');
const { readDeleted, publishDeletedIndex } = require('./utils/deleted-products');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Admin-Token, X-Admin-Key',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  // Never cache: the admin reads this straight after deleting something.
  'Cache-Control': 'no-store',
  'Content-Type': 'application/json',
};

const json = (statusCode, obj) => ({ statusCode, headers: CORS, body: JSON.stringify(obj) });

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  const _adminBlock = requireAdmin(event, CORS); if (_adminBlock) return _adminBlock;
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return json(500, { error: 'Supabase env vars missing' });
  }

  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const { rows, ok, error } = await readDeleted(supabase);
    if (!ok) return json(200, { deleted: [], table_missing: true, warning: error });

    // ?republish=1 re-pushes the table to KV. The escape hatch for a delete
    // whose KV write failed after the row landed — without it the only fix
    // would be deleting and re-deleting the product.
    let republished = null;
    if (String(event.queryStringParameters?.republish || '') === '1') {
      republished = await publishDeletedIndex(supabase);
    }

    return json(200, { deleted: rows, count: rows.length, republished });
  } catch (err) {
    return json(500, { error: err.message });
  }
};
