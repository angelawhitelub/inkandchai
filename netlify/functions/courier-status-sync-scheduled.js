/**
 * Scheduled function: courier-status-sync-scheduled   (hourly, jobs.toml)
 * POST (admin) { "limit": 80, "dry_run": true }   -- manual run / preview
 *
 * Moves no-scan bookings (Amazon, iThink Delhivery, NimbusPost DTDC/Ekart...)
 * to out_for_delivery / delivered from the courier's own tracking, via
 * utils/pickup-live. The rules are in utils/courier-status-sync.js.
 *
 * Sends no customer messages. A newly delivered order becomes eligible for the
 * normal daily review request (request-reviews-scheduled: delivered in the last
 * 21 days, capped and de-duplicated), exactly like every other courier's.
 */

const { createClient } = require('@supabase/supabase-js');
const { requireAdmin } = require('./utils/admin-auth');
const { checkPickups } = require('./utils/pickup-live');
const { planUpdate } = require('./utils/courier-status-sync');
const { SYNCABLE } = require('./utils/xpressbees-status');

const HEADERS = { 'Content-Type': 'application/json' };
const json = (statusCode, body) => ({ statusCode, headers: HEADERS, body: JSON.stringify(body, null, 2) });

const DEFAULT_LIMIT = 80;
const MAX_LIMIT = 200;
const WINDOW_DAYS = 60;   // older than this is a person's job, not a poller's

async function run(supabase, { limit = DEFAULT_LIMIT, dryRun = false, check = checkPickups, now = new Date() } = {}) {
  const since = new Date(now.getTime() - WINDOW_DAYS * 86400000).toISOString();
  // Least recently checked first, so dead AWBs cannot starve the rest.
  const { data: orders, error } = await supabase
    .from('orders')
    .select('id, razorpay_order_id, status, tracking_id, courier_name, nimbus_pushed_at, ithink_pushed_at, '
          + 'last_nimbuspost_status, last_courier_status, shipment_moved_at, delivered_at, shipped_at')
    .in('status', SYNCABLE)
    .not('tracking_id', 'is', null)
    .or('courier_name.is.null,courier_name.not.ilike.*xpressbees*')
    .gte('created_at', since)
    .order('last_courier_status_at', { ascending: true, nullsFirst: true })
    .limit(limit);
  if (error) throw new Error(`orders query failed: ${error.message}`);

  const live = await check(orders || []);
  const stamp = now.toISOString();
  const changes = [];
  const failed = [];
  let unknown = 0;
  for (const o of orders || []) {
    const answer = live.get(o.id);
    if (!answer || answer.state === 'unknown') unknown++;
    const { fields, to } = planUpdate(o, answer, stamp);
    if (to) changes.push({ order: o.razorpay_order_id || o.id, courier: o.courier_name, from: o.status, to, courier_says: answer.status, delivered_at: fields.delivered_at || null });
    if (dryRun) continue;
    const { error: upErr } = await supabase.from('orders').update(fields).eq('id', o.id).in('status', SYNCABLE);
    if (upErr) failed.push({ order: o.razorpay_order_id || o.id, error: upErr.message });
  }
  return {
    dry_run: dryRun,
    scanned: (orders || []).length,
    no_answer: unknown,
    to_delivered: changes.filter((c) => c.to === 'delivered').length,
    to_out_for_delivery: changes.filter((c) => c.to === 'out_for_delivery').length,
    failed: failed.length,
    changes,
    failures: failed,
  };
}

exports.handler = async (event = {}) => {
  // The scheduler's event has no rawUrl; anything over HTTP must be an admin.
  let body = {};
  if (event.rawUrl) {
    const blocked = requireAdmin(event, HEADERS);
    if (blocked) return blocked;
    try { body = JSON.parse(event.body || '{}'); } catch { body = {}; }
  }
  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const out = await run(supabase, {
      limit: Math.min(MAX_LIMIT, Math.max(1, Number(body.limit) || DEFAULT_LIMIT)),
      dryRun: body.dry_run === true,
    });
    console.log('[courier-status-sync]', JSON.stringify({ scanned: out.scanned, delivered: out.to_delivered, ofd: out.to_out_for_delivery, no_answer: out.no_answer, failed: out.failed, dry_run: out.dry_run }));
    return json(200, out);
  } catch (e) {
    console.error('[courier-status-sync] failed:', e.message);
    return json(500, { error: e.message });
  }
};

exports._test = { run };
