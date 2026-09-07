/**
 * Scheduled: retry orders whose panel push never happened.
 *
 * WHY
 * ---
 * Until now the auto-push had no retry at all. Every path pushed once, inline,
 * at the moment the order was created or paid, and if that single attempt did
 * not happen the order simply sat in the admin looking like any other. The
 * only recovery was a human noticing and clicking "Push to NimbusPost Panel".
 * On 8 Sep that meant seven COD orders pushed by hand, the oldest 70 hours
 * after it was placed.
 *
 * Two independent ways an order got missed:
 *
 *  1. The push was a floating promise. Cloudflare cancels un-awaited work once
 *     the response is sent. Fixed at the call sites with utils/after-response,
 *     but "fixed" is not "guaranteed" -- an isolate can still be torn down.
 *
 *  2. replay-lost-orders pushes nothing. An order that reaches the fallback pen
 *     because Supabase was unreachable at checkout gets inserted minutes or
 *     days later by the replay, and the push that would have happened inline
 *     never runs, because it lives in the code path that threw. Nothing in that
 *     job has ever mentioned NimbusPost. Four of the seven arrived this way --
 *     all inserted within a minute of each other, carrying order IDs from days
 *     earlier.
 *
 * A sweep fixes both without either fix having to be perfect.
 *
 * SAFETY
 * ------
 * A panel push creates a DRAFT order: no AWB, no courier assigned, nothing
 * shipped and nothing charged. It is the same action as the admin's own bulk
 * button and it goes through the same handler, so the two cannot drift apart.
 * Pushing is also idempotent twice over -- nimbus_pushed_at is claimed with a
 * conditional update, and nimbuspost-order-push checks the panel's own order
 * numbers before importing.
 *
 * The age gate is what keeps this from racing checkout: an order is only swept
 * once the inline push has had MIN_AGE_MINUTES to finish and be stamped.
 */

'use strict';

const { createClient } = require('@supabase/supabase-js');

const HEADERS = { 'Content-Type': 'application/json' };

// Long enough that a slow-but-working inline push is never double-handled.
const MIN_AGE_MINUTES = 15;

// Matches nimbuspost-order-push's own list. Replacements are excluded: they
// have their own sweeper (auto-push-replacements) with its own preconditions.
const SWEEPABLE_STATUSES = ['paid', 'confirmed', 'cod_pending', 'partial_cod_pending'];

// A cap, not a target. If this ever fires in the dozens something upstream is
// broken and should be looked at rather than quietly drained.
const MAX_PER_RUN = 25;

exports.handler = async () => {
  const secret = process.env.ADMIN_SECRET;
  const site = String(process.env.SITE_URL || process.env.URL || 'https://inkandchai.in').replace(/\/$/, '');
  if (!secret) {
    console.error('[np-push-sweep] ADMIN_SECRET is not configured');
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: 'Scheduler auth not configured' }) };
  }
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    console.error('[np-push-sweep] Supabase is not configured');
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: 'Supabase not configured' }) };
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const cutoff = new Date(Date.now() - MIN_AGE_MINUTES * 60000).toISOString();

  // Find the gap first and push only those ids. Handing the bulk endpoint
  // `all_unshipped` instead would make it page the entire NimbusPost order list
  // every run just to discover there is nothing to do.
  let stuck;
  try {
    const { data, error } = await supabase
      .from('orders')
      .select('razorpay_order_id,status,created_at')
      .is('nimbus_pushed_at', null)
      .is('tracking_id', null)
      .is('cancelled_at', null)
      .in('status', SWEEPABLE_STATUSES)
      .lt('created_at', cutoff)
      .or('source.is.null,source.neq.paperbound')
      .order('created_at', { ascending: true })
      .limit(MAX_PER_RUN);
    if (error) throw error;
    stuck = data || [];
  } catch (e) {
    console.error('[np-push-sweep] lookup failed:', e.message);
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: e.message }) };
  }

  if (!stuck.length) return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ swept: 0 }) };

  const ids = stuck.map(o => o.razorpay_order_id);
  const oldestHours = ((Date.now() - new Date(stuck[0].created_at)) / 3600000).toFixed(1);
  console.log(`[np-push-sweep] ${ids.length} unpushed order(s), oldest ${oldestHours}h: ${ids.join(', ')}`);

  try {
    const response = await fetch(`${site}/.netlify/functions/nimbuspost-order-push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': secret },
      body: JSON.stringify({ order_ids: ids }),
    });
    const detail = await response.text().catch(() => '');
    if (!response.ok) throw new Error(`push returned ${response.status}: ${detail.slice(0, 300)}`);
    console.log(`[np-push-sweep] pushed ${ids.length}: ${detail.slice(0, 300)}`);
    return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ swept: ids.length, order_ids: ids }) };
  } catch (error) {
    // Left unstamped on purpose: the next run retries rather than the order
    // being quietly written off.
    console.error('[np-push-sweep] failed:', error.message);
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: error.message, order_ids: ids }) };
  }
};
