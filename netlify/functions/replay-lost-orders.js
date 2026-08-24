/**
 * Netlify Function: replay-lost-orders
 * Scheduled: every 5 minutes (netlify.toml)
 * Manual:    POST /orders-backup (this one cannot be invoked over HTTP)
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
const { replayLostOrders, reconcileMirror } = require('./utils/order-fallback');
const { reconcileFromNeon, isEnabled: neonEnabled } = require('./utils/neon-mirror');

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

  // No manual branch here on purpose: Netlify answers 403 to a direct HTTP
  // call of a scheduled function before the handler runs, so anything served
  // from this file by hand would be unreachable. The admin trigger lives in
  // orders-backup (POST), which is not scheduled.

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

  // Third copy: the Neon standby. Checked independently of the blob mirror on
  // purpose — one of them is meant to still be there when the other is not.
  const neon = await reconcileFromNeon(supabase, {});
  if (neon.restored || neon.failed) {
    console.error('[replay-lost-orders] neon reconcile:', JSON.stringify(neon));
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
  return json(200, { success: true, summary, mirror, neon, neon_enabled: neonEnabled() });
};
