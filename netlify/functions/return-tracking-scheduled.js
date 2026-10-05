/**
 * Scheduled + owner endpoint: return-tracking-scheduled
 *
 * Keeps every return's reverse pickup tracked, so the Returns panel and the
 * WhatsApp bot can say where a customer's return is and whether it has been
 * DELIVERED BACK TO US.
 *
 *   cron (hourly, jobs.toml)  refresh + save
 *   GET  (owner)              live tracking for every return with an AWB, read-only
 *                             ?raw=1 adds the courier payloads, ?id=<return id> one row
 *   POST (owner)              the same refresh the cron runs, now
 *
 * A refresh does three things:
 *   1. AWB backfill. Returns pushed to NimbusPost without a courier get their
 *      AWB in the NimbusPost panel, under order number R-RET-<display id>
 *      (process-return.js), and it never came back to us. The NimbusPost
 *      shipment list is read once and any match is written to the return,
 *      compare-and-set on status 'pushed_to_nimbus' with no AWB.
 *   2. Live tracking for every open return with an AWB (utils/return-tracking.js),
 *      saved to the tracking_* columns (sql/return_requests_tracking.sql). Until
 *      that SQL is run the columns are skipped and only the GET shows tracking.
 *   3. One WhatsApp to the owner the first time a return is delivered back,
 *      claimed through delivered_alerted_at so it is sent once. No column, no
 *      alert: without it the alert would repeat every hour.
 *
 * NOTHING HERE MOVES MONEY OR MESSAGES CUSTOMERS. Prepaid refunds on receipt
 * stay with the NimbusPost webhook (utils/return-auto-refund.js); the owner
 * alert says when a received return still has its refund pending.
 */

const { createClient } = require('@supabase/supabase-js');
const { requireAdmin } = require('./utils/admin-auth');
const { trackReturns } = require('./utils/return-tracking');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key, X-Admin-Token',
  'Content-Type': 'application/json',
};
const json = (statusCode, body) => ({ statusCode, headers: { ...CORS, 'Cache-Control': 'no-store' }, body: JSON.stringify(body) });

const WINDOW_DAYS = 120;
const CLOSED = ['rejected', 'cancelled'];

const TRACKING_COLUMNS = ['tracking_status', 'tracking_last_scan', 'tracking_last_scan_at',
  'tracking_checked_at', 'return_delivered_at', 'tracking_events'];

/** update() that drops columns the table does not have yet (see process-return softUpdate). */
async function softUpdate(db, id, patch, guard) {
  const fields = { ...patch };
  for (let attempt = 0; attempt < 10; attempt++) {
    let q = db.from('return_requests').update(fields).eq('id', id);
    if (guard) q = guard(q);
    const { data, error } = await q.select('id');
    if (!error) return { ok: true, rows: (data || []).length, dropped: Object.keys(patch).filter((k) => !(k in fields)) };
    const msg = error.message || '';
    const missing = Object.keys(fields).filter((k) => msg.includes(k)).sort((a, b) => b.length - a.length)[0];
    if (!missing) return { ok: false, error: msg };
    delete fields[missing];
    if (!Object.keys(fields).length) return { ok: false, error: msg, dropped: Object.keys(patch) };
  }
  return { ok: false, error: 'too many unknown columns' };
}

const rs = (paise) => `₹${Math.round((Number(paise) || 0) / 100)}`;

/** What the owner needs to do now that the parcel is back. */
function receivedAlert(ret, view) {
  const oid = ret.order_display_id || ret.order_id;
  const when = view.delivered_at ? new Date(view.delivered_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' }) : 'just now';
  const refund = {
    awaiting_return_delivery: `Refund ${rs(ret.refund_amount_paise)} is still waiting. The webhook normally pays it on this scan; if it does not show as refunded in the admin within the hour, refund it by hand.`,
    manual_payout_pending: `Manual payout of ${rs(ret.refund_amount_paise)} is due${ret.upi_id ? ` to UPI ${ret.upi_id}` : ret.bank_account ? ' to the bank account on file' : ' (no payout destination on file)'}.`,
    manual_refund_pending: `Manual refund of ${rs(ret.refund_amount_paise)} is due from the admin.`,
    wallet_issued: 'Wallet credit was already issued.',
  }[ret.refund_status] || (ret.refund_status ? `Refund status: ${ret.refund_status}.` : 'No refund recorded — check the return in the admin.');
  return `📦 Return received\nOrder: ${oid}\nCustomer: ${ret.customer_name || '-'}\nAWB: ${ret.awb}${ret.courier_name ? ` (${ret.courier_name})` : ''}\nDelivered back: ${when}\n${refund}`;
}

async function defaultOwnerAlert(text) {
  const phone = process.env.STORE_OWNER_PHONE;
  if (!phone) return;
  try { await require('./utils/whatsapp').sendText(phone, text); } catch (e) { console.warn('[return-tracking] owner alert:', e.message); }
}

async function defaultAwbMap() {
  const apiKey = process.env.NIMBUSPOST_API_KEY;
  if (!apiKey) throw new Error('NIMBUSPOST_API_KEY is not set');
  return (await require('./nimbuspost-awb-sync-background')._test.fetchNimbusAwbMap(apiKey)).map;
}

const reverseOrderNumber = (ret) => `R-RET-${String(ret.order_display_id || ret.order_id).replace(/^IC-/, '')}`.slice(0, 20).toUpperCase();

async function openReturns(db) {
  const since = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await db.from('return_requests').select('*')
    .gte('created_at', since).order('created_at', { ascending: false }).limit(1000);
  if (error) throw error;
  return (data || []).filter((r) => !CLOSED.includes(String(r.status || '').toLowerCase()));
}

/** Backfill AWBs for returns NimbusPost booked without telling us. */
async function backfillAwbs(db, rows, awbMap, summary) {
  const waiting = rows.filter((r) => !r.awb && r.status === 'pushed_to_nimbus');
  summary.awb_missing = waiting.length;
  if (!waiting.length) return;
  let map;
  try { map = await awbMap(); } catch (e) { summary.errors.push(`awb backfill: ${e.message}`); return; }
  for (const ret of waiting) {
    const hit = map.get(reverseOrderNumber(ret));
    if (!hit || !hit.awb) continue;
    const r = await softUpdate(db, ret.id,
      { awb: String(hit.awb), courier_name: hit.courier || null, status: 'pickup_scheduled' },
      (q) => q.eq('status', 'pushed_to_nimbus').is('awb', null));
    if (r.ok && r.rows) {
      Object.assign(ret, { awb: String(hit.awb), courier_name: hit.courier || null, status: 'pickup_scheduled' });
      summary.awb_backfilled.push(`${ret.order_display_id || ret.order_id} → ${hit.awb}`);
    } else if (!r.ok) summary.errors.push(`awb ${ret.id}: ${r.error}`);
  }
}

/** One refresh: backfill, track, save, alert. */
async function refresh(db, deps = {}) {
  const track = deps.trackReturns || trackReturns;
  const ownerAlert = deps.ownerAlert || defaultOwnerAlert;
  const summary = { tracked: 0, saved: 0, delivered: [], alerted: [], awb_backfilled: [], awb_missing: 0, columns_missing: [], errors: [] };

  const rows = await openReturns(db);
  await backfillAwbs(db, rows, deps.awbMap || defaultAwbMap, summary);

  // A return already received stays received; re-reading it every hour is waste.
  // A cancelled pickup is still read: it is usually rebooked under a new AWB.
  const live = rows.filter((r) => r.awb && !r.return_delivered_at);
  if (!live.length) return summary;
  const views = await track(live.map((r) => r.awb));
  const now = new Date().toISOString();

  for (const ret of live) {
    const v = views.get(String(ret.awb).trim());
    if (!v) continue;
    summary.tracked++;
    if (v.error) { summary.errors.push(`${ret.awb}: ${v.error}`); continue; }
    const patch = {
      tracking_status: v.stage,
      tracking_last_scan: v.last_scan || v.status || null,
      tracking_last_scan_at: v.last_scan_at && !Number.isNaN(Date.parse(v.last_scan_at)) ? v.last_scan_at : null,
      tracking_checked_at: now,
      tracking_events: v.history.slice(0, 15),
    };
    if (v.stage === 'delivered') patch.return_delivered_at = v.delivered_at && !Number.isNaN(Date.parse(v.delivered_at)) ? v.delivered_at : now;
    const r = await softUpdate(db, ret.id, patch);
    const missing = (c) => { if (!summary.columns_missing.includes(c)) summary.columns_missing.push(c); };
    (r.dropped || []).forEach(missing);
    if (v.stage === 'delivered') summary.delivered.push(ret.order_display_id || ret.order_id);
    if (!r.ok) {
      // Every column missing = sql/return_requests_tracking.sql not run yet.
      // Not an error, but the once-only alert cannot be claimed either.
      if (r.dropped) missing('delivered_alerted_at');
      else summary.errors.push(`save ${ret.id}: ${r.error}`);
      continue;
    }
    if ((r.dropped || []).length < TRACKING_COLUMNS.length) summary.saved++;

    if (v.stage !== 'delivered') continue;
    // Claim the alert first: only the run whose claim lands sends it.
    const claim = await db.from('return_requests').update({ delivered_alerted_at: now })
      .eq('id', ret.id).is('delivered_alerted_at', null).select('id');
    if (claim.error) { missing('delivered_alerted_at'); continue; }
    if (!(claim.data || []).length) continue;
    await ownerAlert(receivedAlert(ret, v));
    summary.alerted.push(ret.order_display_id || ret.order_id);
  }
  return summary;
}

/** Owner GET: live tracking without writing anything. */
async function liveView(db, { raw = false, id = '' } = {}, deps = {}) {
  const track = deps.trackReturns || trackReturns;
  let rows = (await openReturns(db)).filter((r) => r.awb);
  if (id) rows = rows.filter((r) => String(r.id) === String(id));
  const views = await track(rows.map((r) => r.awb), { raw });
  const tracking = {};
  for (const r of rows) tracking[r.id] = views.get(String(r.awb).trim()) || null;
  return { count: rows.length, tracking };
}

exports.handler = async (event = {}) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  const fromCron = !!(event.headers && event.headers['x-cloudflare-cron']);
  if (!fromCron) {
    const block = requireAdmin(event, CORS);
    if (block) return block;
  }
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) return json(500, { error: 'Supabase is not configured' });
  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  try {
    if (!fromCron && event.httpMethod === 'GET') {
      const q = event.queryStringParameters || {};
      return json(200, await liveView(db, { raw: q.raw === '1', id: q.id || '' }));
    }
    if (event.httpMethod !== 'POST') return json(405, { error: 'GET or POST' });
    const summary = await refresh(db);
    console.log('[return-tracking]', JSON.stringify(summary));
    return json(200, { success: true, summary });
  } catch (e) {
    console.error('[return-tracking]', e);
    return json(500, { error: e.message });
  }
};

exports._test = { refresh, liveView, receivedAlert, reverseOrderNumber, softUpdate };
