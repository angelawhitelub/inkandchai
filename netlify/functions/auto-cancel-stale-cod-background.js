/** Long-running worker for pure-COD orders left without an AWB for seven days. */

const { createClient } = require('@supabase/supabase-js');
const { requireAdmin } = require('./utils/admin-auth');
const { _runSweep: runSweep } = require('./auto-cancel-stale-cod');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key, X-Admin-Token',
  'Content-Type': 'application/json',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }
  const adminBlock = requireAdmin(event, CORS);
  if (adminBlock) return adminBlock;

  let dryRun = false;
  try { dryRun = !!JSON.parse(event.body || '{}').dry_run; } catch {}
  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const summary = await runSweep(supabase, { dryRun });
    console.log('[stale-cod]', JSON.stringify(summary));
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ success: true, dry_run: dryRun, summary }) };
  } catch (error) {
    console.error('[stale-cod] sweep failed:', error.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: error.message }) };
  }
};
