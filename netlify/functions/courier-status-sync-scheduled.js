/**
 * Scheduled function: courier-status-sync-scheduled   (hourly, jobs.toml)
 * POST (admin) { "limit": 80, "dry_run": true }   -- manual run / preview
 * POST (admin) { "order_ids": [uuid, …], "dry_run": true }   -- named orders, delivered only
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

// Orders a person named, for parcels past the poller's window (about 500 May-Aug
// parcels sat at out_for_delivery for months after being delivered). It asks the
// courier again and only ever moves an order to delivered.
//
// Delivered is not just a label for some orders: the XpressBees status job pays
// a pending wrong-COD refund on any delivered order within 15 minutes, and the
// late-cancel sweep acts on it too. Those are held back for a person.
function heldBack(o) {
  if (o.wrong_cod_paise != null && !o.wrong_cod_refund_at) return 'wrong_cod_refund_pending';
  if (o.late_cancel_state) return 'late_cancel';
  if (o.cancellation_requested_at) return 'cancellation_requested';
  return '';
}

async function runSelected(supabase, { orderIds, dryRun = false, check = checkPickups, now = new Date() }) {
  const { data: orders, error } = await supabase
    .from('orders')
    .select('id, razorpay_order_id, status, tracking_id, courier_name, nimbus_pushed_at, ithink_pushed_at, '
          + 'last_nimbuspost_status, last_courier_status, shipment_moved_at, delivered_at, shipped_at, '
          + 'wrong_cod_paise, wrong_cod_refund_at, late_cancel_state, cancellation_requested_at')
    .in('id', orderIds)
    .in('status', SYNCABLE)
    .not('tracking_id', 'is', null);
  if (error) throw new Error(`orders query failed: ${error.message}`);

  const live = await check(orders || []);
  const stamp = now.toISOString();
  const changes = [];
  const held = [];
  const notDelivered = [];
  const failed = [];
  for (const o of orders || []) {
    const ref = o.razorpay_order_id || o.id;
    const answer = live.get(o.id);
    const { fields, to } = planUpdate(o, answer, stamp);
    if (to !== 'delivered') { notDelivered.push({ order: ref, courier_says: answer?.status || '' }); continue; }
    const why = heldBack(o);
    if (why) { held.push({ order: ref, why }); continue; }
    changes.push({ order: ref, delivered_at: fields.delivered_at || null });
    if (dryRun) continue;
    const { error: upErr } = await supabase.from('orders').update(fields).eq('id', o.id).in('status', SYNCABLE);
    if (upErr) failed.push({ order: ref, error: upErr.message });
  }
  return {
    dry_run: dryRun,
    requested: orderIds.length,
    found: (orders || []).length,
    to_delivered: changes.length,
    undated: changes.filter((c) => !c.delivered_at).length,
    held,
    not_delivered: notDelivered,
    failed,
    changes,
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
    if (Array.isArray(body.order_ids)) {
      const orderIds = [...new Set(body.order_ids.map(String).filter(Boolean))];
      if (!orderIds.length || orderIds.length > MAX_LIMIT) return json(400, { error: `Send 1 to ${MAX_LIMIT} order_ids` });
      return json(200, await runSelected(supabase, { orderIds, dryRun: body.dry_run === true }));
    }
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

exports._test = { run, runSelected };
