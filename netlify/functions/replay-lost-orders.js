/**
 * Netlify Function: replay-lost-orders
 * Scheduled: every 5 minutes (netlify.toml)
 * Manual:    POST with X-Admin-Key  { dry_run?: true, limit?: number }
 *
 * Drains the `lost-orders` blob store — orders that were paid for, emailed to
 * the customer and in some cases already handed to the courier, but that the
 * database refused to accept. See utils/order-fallback.js for why they end up
 * there.
 *
 * Cheap when idle: an empty store is one list() call, which is why running it
 * every five minutes costs nothing. The interval IS the recovery latency, and
 * during an outage the pen fills silently — five minutes means an order missing
 * from admin resolves itself before anyone looks for it.
 *
 * Never destructive. A row that still cannot be inserted stays in the pen with
 * an incremented attempt count; only a confirmed insert (or a confirmed
 * duplicate) deletes a blob.
 */

const { createClient } = require('@supabase/supabase-js');
const { requireAdmin } = require('./utils/admin-auth');
const { replayLostOrders, countLostOrders, reconcileMirror } = require('./utils/order-fallback');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key, X-Admin-Token',
  'Content-Type': 'application/json',
};

const json = (statusCode, obj) => ({ statusCode, headers: CORS, body: JSON.stringify(obj) });

function supabaseClient() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) return null;
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  // Manual trigger (admin) — also the only way to ask for a dry run.
  if (event.httpMethod === 'POST') {
    const _adminBlock = requireAdmin(event, CORS); if (_adminBlock) return _adminBlock;

    let body = {};
    try { body = JSON.parse(event.body || '{}'); } catch {}

    if (body.dry_run) {
      const pending = await countLostOrders(event);
      const supabase = supabaseClient();
      const mirror = supabase ? await reconcileMirror(event, supabase, { dryRun: true }) : null;
      return json(200, { success: true, dry_run: true, pending, mirror });
    }

    const supabase = supabaseClient();
    if (!supabase) return json(500, { error: 'SUPABASE_URL and SUPABASE_SERVICE_KEY are required.' });

    const limit = Math.min(Math.max(Number(body.limit) || 100, 1), 500);
    const summary = await replayLostOrders(event, supabase, { limit });
    const mirror = await reconcileMirror(event, supabase, { dryRun: !!body.reconcile_dry_run });
    return json(200, { success: true, summary, mirror });
  }

  // Scheduled run.
  const supabase = supabaseClient();
  if (!supabase) {
    console.error('[replay-lost-orders] Supabase env not configured');
    return json(500, { error: 'Supabase not configured' });
  }

  const summary = await replayLostOrders(event, supabase, { limit: 100 });

  // Second line of defence: the pen only holds orders the database refused.
  // This compares the mirror against the orders table and puts back anything
  // that went missing after being accepted.
  const mirror = await reconcileMirror(event, supabase, {});
  if (mirror.restored || mirror.failed) {
    console.error('[replay-lost-orders] mirror reconcile:', JSON.stringify(mirror));
  }

  if (summary.found) {
    console.log('[replay-lost-orders]', JSON.stringify(summary));
  }
  if (summary.abandoned) {
    // Past the attempt cap means something about the row itself is wrong (a
    // column that no longer exists, a constraint it can never satisfy). Retrying
    // will not fix it, so say so loudly rather than looping forever in silence.
    console.error(`[replay-lost-orders] ${summary.abandoned} order(s) past the retry cap and need a human`);
  }
  return json(200, { success: true, summary, mirror });
};
