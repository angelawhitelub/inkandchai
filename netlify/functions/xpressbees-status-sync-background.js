/**
 * Netlify Function: xpressbees-status-sync-background
 * POST (X-Admin-Key / X-Admin-Token)   { "limit": 120, "dry_run": false }
 *
 * Pulls live status for XpressBees shipments and writes it onto the order.
 *
 * WHY THIS EXISTS
 * ---------------
 * Every other courier we use reports itself. NimbusPost fires webhooks into
 * nimbuspost-webhook.js, and iThink's Delhivery shipments arrive the same way,
 * which is why 129 of 335 Delhivery orders read `delivered` and 14 read
 * `out_for_delivery`. XpressBees reports nothing: their panel has said
 * "Webhooks will be available soon" for as long as we have had the account,
 * and the channel push-back deliberately applies only the booked transition
 * (see woo-channel.js applyPushBack -- In Transit, Delivered and RTO are
 * recorded there and applied to nothing).
 *
 * So XpressBees orders froze at `shipped` and stayed there. Measured
 * 20 Sep 2026: 219 of 235. Tracking 150 of them live found 104 in transit,
 * 4 delivered and 2 already RTO -- including two customers emailed the night
 * before about a COD charge that will now never be collected. Nothing was
 * wrong with the data; nobody was reading it.
 *
 * Their tracking API does work (utils/xpressbees track()), so this polls it.
 *
 * WHAT IT REFUSES TO DO
 * ---------------------
 * 1. `cancelled` from the courier NEVER cancels the order. Cancelling a stale
 *    panel row is our own housekeeping -- 51 were cancelled on 19 Sep for
 *    orders that had already shipped through iThink -- and mapping that back
 *    onto `status` would have cancelled 51 live shipments.
 * 2. RTO sets `status` and nothing else. A returned parcel is not a refund,
 *    and no money path may key off this job.
 * 3. An order in a refund state keeps its status; the courier's view is
 *    recorded beside it. Where the money is outranks where the parcel is.
 * 4. `in transit` never touches `status`, matching the webhook: hub scans
 *    repeat endlessly and admin filters and revenue must not move with them.
 *    Only `shipment_moved_at` advances.
 * 5. Nothing walks backwards, and nothing leaves a terminal state.
 *
 * Customer notifications are OFF unless XPRESSBEES_SYNC_NOTIFY=1. Switching
 * this on with 219 stale orders waiting would fire 219 messages at once.
 */

const { createClient } = require('@supabase/supabase-js');
const { requireAdmin } = require('./utils/admin-auth');
const xb = require('./utils/xpressbees');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key, X-Admin-Token',
  'Content-Type': 'application/json',
};
const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body, null, 2) });

const DEFAULT_LIMIT = 120;
const MAX_LIMIT = 250;

// Statuses this job may read FROM. Anything else is either finished or owned
// by the money side of the system.
const SYNCABLE = ['shipped', 'out_for_delivery'];
const REFUND_STATES = ['refunded', 'partially_refunded', 'refund_pending', 'refund_failed'];
const TERMINAL = ['delivered', 'cancelled', 'rto', 'rto_delivered', 'lost', ...REFUND_STATES];

// Same ordering the NimbusPost webhook uses, so the two agree about what
// counts as forward. Absent = rank 0 = decided by the explicit guards.
const RANK = { shipped: 1, out_for_delivery: 2, delivered: 3 };

/**
 * XpressBees status text -> what we do about it.
 *
 *   status  : the order status to move to
 *   moved   : the parcel has physically moved (advance shipment_moved_at)
 *   record  : recognised, but status is not ours to change from here
 */
function interpret(raw) {
  const s = String(raw || '').toLowerCase().trim();
  if (!s) return { record: true };
  if (/^delivered$|delivered to|shipment delivered/.test(s)) return { status: 'delivered', moved: true };
  if (/out for delivery|^ofd$/.test(s))                      return { status: 'out_for_delivery', moved: true };
  // RTO in every spelling, including the delivered-back one: the parcel is
  // coming home, which is a shipping fact and never a money one.
  if (/^rto|rto|return to origin|returning/.test(s))         return { status: 'rto', moved: true };
  if (/transit|bagged|received at|reached|dispatch|picked|pickup done|out scan|in scan/.test(s))
    return { moved: true, record: true };
  if (/pending pickup|booked|manifest|awaiting|data received/.test(s)) return { record: true };
  // Exception / NDR: real, but we have no such order status and it must not
  // look like a delivery failure the customer caused. Recorded for the owner.
  if (/exception|undelivered|ndr|failed/.test(s))            return { record: true, attention: true };
  // "cancelled" lands here deliberately -- see WHAT IT REFUSES TO DO (1).
  return { record: true };
}

/**
 * Write, tolerating a database that has not had the migration yet.
 *
 * last_courier_status / last_courier_status_at are new. Referencing a column
 * that does not exist fails the WHOLE update, and this job's whole purpose is
 * to move statuses -- so on that specific failure it retries without them and
 * says so, rather than silently syncing nothing.
 */
async function updateOrder(supabase, id, fields, warn) {
  let { error } = await supabase.from('orders').update(fields).eq('id', id);
  if (error && /last_courier_status/.test(error.message || '')) {
    warn.migration = 'orders.last_courier_status / last_courier_status_at are missing — run sql/orders_last_courier_status.sql; statuses are syncing, the courier text is not';
    const { last_courier_status, last_courier_status_at, ...rest } = fields;
    ({ error } = await supabase.from('orders').update(rest).eq('id', id));
  }
  if (error) throw new Error(error.message);
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  const block = requireAdmin(event, CORS);
  if (block) return block;

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch { /* scheduler sends {} */ }

  const limit = Math.min(MAX_LIMIT, Math.max(1, Number(body.limit) || DEFAULT_LIMIT));
  const dryRun = body.dry_run === true;
  const notify = String(process.env.XPRESSBEES_SYNC_NOTIFY || '') === '1';

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  // LEAST RECENTLY CHECKED FIRST, not oldest-shipped.
  //
  // The first live run took the 60 oldest by shipped_at and spent almost all
  // of them on 12 September orders whose AWBs answer "Record not found" --
  // they were booked through NimbusPost with XpressBees as the carrier, so
  // they are not in our account and never will be. Those 13 are permanently
  // unresolvable, and ordering by shipped_at parks them at the head of the
  // queue forever: every run would re-fetch the same dead AWBs while the
  // orders that actually move never get looked at. Stamping every scanned
  // order and taking the stalest first rotates the whole set instead.
  const baseSelect = () => supabase
    .from('orders')
    .select('id, razorpay_order_id, status, tracking_id, courier_name, customer_name, '
          + 'customer_phone, customer_email, shipment_moved_at, delivered_at, shipped_at')
    .ilike('courier_name', '%xpressbees%')
    .in('status', SYNCABLE)
    .not('tracking_id', 'is', null)
    .limit(limit);

  const warn = {};
  let { data: orders, error } = await baseSelect()
    .order('last_courier_status_at', { ascending: true, nullsFirst: true });

  // Same tolerance as the write path: the column is new, and referencing a
  // missing one fails the WHOLE query. Falling back keeps the job running --
  // it just cannot rotate, so the note says what that costs.
  if (error && /last_courier_status_at/.test(error.message || '')) {
    warn.migration = 'orders.last_courier_status / last_courier_status_at are missing — run sql/orders_last_courier_status.sql; '
      + 'until then this re-checks the oldest shipments every run instead of rotating, and dead AWBs crowd out live ones';
    ({ data: orders, error } = await baseSelect().order('shipped_at', { ascending: true }));
  }
  if (error) return json(500, { error: `orders query failed: ${error.message}` });
  const changed = [];
  const recorded = [];
  const missing = [];
  const failed = [];
  const now = new Date().toISOString();

  // Serial: one shared bearer token, same as admin-xpressbees-track.
  for (const o of orders || []) {
    const ref = o.razorpay_order_id || o.id;
    let live;
    try {
      live = await xb.track(o.tracking_id);
    } catch (e) {
      // AWBs booked through NimbusPost with XpressBees as the carrier are not
      // in our XpressBees account and never will be. 13 of the first 150 were
      // these. They are not an error to chase.
      // Stamp even the unresolvable ones. An AWB that is not in our account
      // is still "checked"; leaving it unstamped would keep it first in line
      // on every future run, which is the queue starvation this ordering
      // exists to prevent.
      const stamp = { last_courier_status: `lookup failed: ${e.message}`.slice(0, 200), last_courier_status_at: now };
      if (!dryRun) await updateOrder(supabase, o.id, stamp, warn).catch(() => {});
      if (/record not found/i.test(e.message)) { missing.push({ order: ref, awb: o.tracking_id }); continue; }
      failed.push({ order: ref, awb: o.tracking_id, error: e.message });
      continue;
    }

    const raw = String(live?.status || '');
    const verdict = interpret(raw);
    const fields = { last_courier_status: raw.slice(0, 200), last_courier_status_at: now };
    if (verdict.moved) fields.shipment_moved_at = o.shipment_moved_at || now;

    const target = verdict.status;
    const forward = target
      && !TERMINAL.includes(String(o.status || '').toLowerCase())
      && !(RANK[target] && RANK[o.status] && RANK[target] <= RANK[o.status]);

    if (target && forward) {
      fields.status = target;
      if (target === 'delivered') fields.delivered_at = o.delivered_at || now;
      if (!dryRun) {
        try { await updateOrder(supabase, o.id, fields, warn); }
        catch (e) { failed.push({ order: ref, error: e.message }); continue; }
      }
      changed.push({ order: ref, awb: o.tracking_id, from: o.status, to: target, courier_says: raw });
      continue;
    }

    if (!dryRun) {
      try { await updateOrder(supabase, o.id, fields, warn); }
      catch (e) { failed.push({ order: ref, error: e.message }); continue; }
    }
    recorded.push({ order: ref, status: o.status, courier_says: raw, attention: !!verdict.attention });
  }

  const to = (s) => changed.filter((c) => c.to === s).length;
  const out = {
    dry_run: dryRun,
    notifications: notify ? 'on' : 'off (set XPRESSBEES_SYNC_NOTIFY=1 to enable)',
    scanned: (orders || []).length,
    changed: changed.length,
    to_delivered: to('delivered'),
    to_out_for_delivery: to('out_for_delivery'),
    to_rto: to('rto'),
    recorded_only: recorded.length,
    needs_attention: recorded.filter((r) => r.attention).length,
    awb_not_in_account: missing.length,
    failed: failed.length,
    changes: changed,
    attention: recorded.filter((r) => r.attention),
    failures: failed,
  };
  if (warn.migration) out.warning = warn.migration;
  console.log('[xpressbees-status-sync]', JSON.stringify({
    scanned: out.scanned, changed: out.changed, delivered: out.to_delivered,
    ofd: out.to_out_for_delivery, rto: out.to_rto, missing: out.awb_not_in_account, failed: out.failed,
  }));
  return json(200, out);
};

exports.__test = { interpret, RANK, SYNCABLE, TERMINAL };
