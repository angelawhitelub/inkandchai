/**
 * Scheduled function: unpicked-auto-cancel-scheduled   (hourly, jobs.toml)
 *
 * Owner rule (24 Nov 2026): "auto cancel order if order is not picked up for
 * more than 10 days. Auto issue refund also as soon as 10 days passes."
 *
 * Each hour, orders placed AUTO_DAYS+ days ago that no courier has picked up
 * (utils/not-picked-up classify: no AWB, or an AWB that has not moved) go
 * through admin-not-picked-up-cancel.handleOne, the Not Picked Up tab's own
 * cancel & refund, oldest first, at most PER_RUN a run:
 *   1. the courier is asked LIVE; picked up / moved -> left alone;
 *   2. the AWB is voided with the courier; no explicit success -> left alone;
 *   3. update-order-status cancels it (reason out_of_stock: the customer gets
 *      the usual "we could not get your book" email + WhatsApp) and refunds a
 *      paid order in full (Razorpay there, PhonePe via notifyOrderCancelled);
 *      a replacement goes through cancel-replacement.
 * No courier answer, a courier refusal, or a booked XpressBees panel row whose
 * AWB never came back: nothing is changed and the owner is told once.
 *
 * Not touched: pre-orders and handling-time books still inside their hold,
 * split orders, orders with a cancellation already in hand, late cancels.
 *
 * OFF until the owner switches it on (KV catalog:auto-cancel-unpicked, admin
 * Not Picked Up tab). Admin POST { dry_run: true } lists what a run would do
 * without changing anything.
 */
const { createClient } = require('@supabase/supabase-js');
const { requireAdmin, signAdminToken } = require('./utils/admin-auth');
const { classify, UNBOOKED } = require('./utils/not-picked-up');
const { preorderChecker } = require('./utils/preorder-hold');
const { splitCancelBlock } = require('./utils/order-split');
const { xbPanelIndex, baseOrderNumber } = require('./utils/booking-guard');
const { sendEmail } = require('./utils/email');
const { sendText } = require('./utils/whatsapp');

let blobs = null;
try { blobs = require('@netlify/blobs'); } catch { blobs = null; }
const store = () => {
  if (!blobs || typeof blobs.getStore !== 'function') throw new Error('Blob store is not available');
  return blobs.getStore('catalog');
};

const KEY = 'auto-cancel-unpicked';
const LOG_KEY = 'auto-cancel-unpicked-log';
const AUTO_DAYS = 10;
const PER_RUN = 10;
const DRY_RUN_MAX = 25;
const RETRY_MS = 24 * 3600 * 1000;     // an order we could not stop is tried again a day later
const LOOKBACK_DAYS = 120;
const NOTE = `Auto cancel: not picked up ${AUTO_DAYS}+ days after ordering (full refund).`;
const DAY = 86400000;

const json = (statusCode, body) => ({ statusCode, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(body) });
const idOf = (o) => o.razorpay_order_id || o.id;

async function readSwitch() {
  try { const d = await store().get(KEY, { type: 'json' }); return { on: !!(d && d.on), updated_at: (d && d.updated_at) || null }; }
  catch { return { on: false, updated_at: null }; }     // unreadable counts as OFF
}
async function setSwitch(on) {
  const doc = { on: !!on, days: AUTO_DAYS, updated_at: new Date().toISOString() };
  await store().setJSON(KEY, doc);
  return doc;
}
async function readLog() {
  try { const d = await store().get(LOG_KEY, { type: 'json' }); return (d && d.orders) || {}; } catch { return {}; }
}
async function writeLog(orders) {
  const cutoff = Date.now() - 60 * DAY;
  const kept = Object.fromEntries(Object.entries(orders).filter(([, v]) => Date.parse(v.at) > cutoff));
  try { await store().setJSON(LOG_KEY, { orders: kept, updated_at: new Date().toISOString() }); } catch (e) { console.warn('[auto-cancel-unpicked] log not saved', e.message); }
}

/** Orders past AUTO_DAYS that nobody has picked up, oldest first. */
async function candidates(db, now, deps = {}) {
  const until = new Date(now - AUTO_DAYS * DAY).toISOString();
  const since = new Date(now - LOOKBACK_DAYS * DAY).toISOString();
  const { data, error } = await db.from('orders').select('*')
    .in('status', ['shipped', ...UNBOOKED])
    .lte('created_at', until).gte('created_at', since)
    .is('shipment_moved_at', null).is('cancelled_at', null)
    .is('cancellation_requested_at', null).is('late_cancel_at', null)
    .order('created_at', { ascending: true }).limit(1000);
  if (error) throw new Error(error.message);
  const held = await (deps.preorderChecker || preorderChecker)(db, now);
  const out = []; const skipped = [];
  for (const o of data || []) {
    if (!classify(o, now, AUTO_DAYS * 24)) continue;
    if (held(o)) { skipped.push({ order_id: idOf(o), reason: 'pre-order / handling time hold' }); continue; }
    if (splitCancelBlock(o)) { skipped.push({ order_id: idOf(o), reason: 'split order' }); continue; }
    out.push(o);
  }
  return { orders: out, skipped };
}

function internalEvent() {
  const token = signAdminToken({ sub: 'system:auto-cancel-unpicked', role: 'owner', ttlMs: 10 * 60 * 1000 });
  return { headers: { 'x-admin-token': token } };
}

async function alertOwner(text) {
  const jobs = [];
  if (process.env.STORE_OWNER_PHONE) jobs.push(sendText(process.env.STORE_OWNER_PHONE, text.slice(0, 3800)).catch(() => {}));
  if (process.env.STORE_OWNER_EMAIL) {
    jobs.push(sendEmail({
      to: process.env.STORE_OWNER_EMAIL,
      subject: `🤖 Auto-cancel (not picked up ${AUTO_DAYS}+ days)`,
      html: `<pre style="font-family:Arial,sans-serif;font-size:14px;white-space:pre-wrap;">${text.replace(/</g, '&lt;')}</pre>`,
    }).catch(() => {}));
  }
  await Promise.all(jobs);
}

/**
 * An XpressBees panel order with no AWB: a queued row is safe to cancel here
 * (woo-channel voids an AWB booked afterwards); a booked one is shipping
 * under an AWB we do not have, so it is left to the owner.
 */
async function panelTarget(order, deps) {
  if (!order.xpressbees_feed_at || String(order.tracking_id || '').trim()) return { target: order };
  try {
    const row = (await (deps.xbPanelIndex || xbPanelIndex)()).get(baseOrderNumber(idOf(order)));
    if (row && row.state === 'booked') return { stop: 'booked on the XpressBees panel, AWB not back yet' };
    return { target: { ...order, xpressbees_feed_at: null } };
  } catch (e) {
    return { stop: `XpressBees panel unreadable (${e.message})` };
  }
}

async function handle(event = {}, deps = {}) {
  let dryRun = false;
  if (event.rawUrl && !deps.skipAuth) {
    const blocked = requireAdmin(event, { 'Content-Type': 'application/json' });
    if (blocked) return blocked;
  }
  if (event.httpMethod === 'POST' && event.body) {
    let body = {};
    try { body = JSON.parse(event.body); } catch { return json(400, { error: 'Invalid JSON' }); }
    if (body.action === 'switch') {
      const doc = await setSwitch(body.on === true);
      console.log(`[auto-cancel-unpicked] switched ${doc.on ? 'ON' : 'OFF'}`);
      return json(200, doc);
    }
    if (body.action === 'status') return json(200, { ...(await readSwitch()), days: AUTO_DAYS, per_run: PER_RUN });
    dryRun = body.dry_run === true;
  }
  const sw = deps.switch || await readSwitch();
  if (!sw.on && !dryRun) return json(200, { ok: true, off: true });

  const db = deps.db || createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const now = deps.now || Date.now();
  const handleOne = deps.handleOne || require('./admin-not-picked-up-cancel').handleOne;
  const log = deps.log || await readLog();
  const { orders, skipped } = await candidates(db, now, deps);
  const due = orders.filter((o) => !log[o.id] || now - Date.parse(log[o.id].at) > RETRY_MS);
  const batch = due.slice(0, dryRun ? DRY_RUN_MAX : PER_RUN);
  const results = [];

  for (const order of batch) {
    const id = idOf(order);
    const pt = await panelTarget(order, deps);
    if (pt.stop) { results.push({ order_id: id, outcome: 'needs_manual', reason: pt.stop }); continue; }

    if (dryRun) {
      const r = await handleOne(internalEvent(), db, pt.target, { dryRun: true, confirmManual: false, cancelReason: 'out_of_stock' }).catch((e) => ({ outcome: 'failed', reason: e.message }));
      results.push({ order_id: id, created_at: order.created_at, outcome: r.outcome, reason: r.reason || '', refund: r.refund || null });
      continue;
    }

    // Claim, so a customer cancel or a second run cannot act on it at the same time.
    const at = new Date().toISOString();
    const { data: claimed } = await db.from('orders').update({ cancellation_requested_at: at, cancellation_request_note: NOTE })
      .eq('id', order.id).is('cancellation_requested_at', null).select('id');
    if (!claimed || !claimed.length) continue;
    let r;
    try {
      r = await handleOne(internalEvent(), db, { ...pt.target, cancellation_requested_at: at }, { dryRun: false, confirmManual: false, cancelReason: 'out_of_stock' });
    } catch (e) { r = { outcome: 'failed', reason: e.message }; }
    if (r.outcome !== 'cancelled') {
      // Nothing was cancelled: hand the order back as it was.
      await db.from('orders').update({ cancellation_requested_at: null, cancellation_request_note: null })
        .eq('id', order.id).eq('cancellation_requested_at', at);
    }
    results.push({ order_id: id, outcome: r.outcome, reason: r.reason || '', refund: r.refund || null });
    console.log('[auto-cancel-unpicked]', id, r.outcome, r.reason || '');
  }

  if (dryRun) {
    const would = results.filter((r) => r.outcome === 'would_cancel');
    return json(200, {
      dry_run: true, on: sw.on, days: AUTO_DAYS, per_run: PER_RUN, eligible: due.length, checked: results.length,
      would_cancel: would.length,
      would_refund_rs: Math.round(would.reduce((t, r) => t + (r.refund && r.refund.via === 'gateway' ? Number(r.refund.amount_rs) || 0 : 0), 0)),
      results, skipped,
    });
  }

  // Owner summary: every cancel, and each order we could not stop (once a day).
  const newLog = { ...log };
  for (const r of results) {
    const o = batch.find((x) => idOf(x) === r.order_id);
    if (o) newLog[o.id] = { at: new Date(now).toISOString(), order_id: r.order_id, outcome: r.outcome, reason: String(r.reason || '').slice(0, 200) };
  }
  if (!deps.log) await writeLog(newLog);
  const done = results.filter((r) => r.outcome === 'cancelled');
  const stuck = results.filter((r) => ['needs_manual', 'courier_refused', 'failed'].includes(r.outcome));
  if (done.length || stuck.length) {
    const money = (r) => (r.refund && Number(r.refund.amount_rs) > 0 ? ` · refund ₹${r.refund.amount_rs} (${r.refund.status || r.refund.via || ''})` : ' · COD, nothing to refund');
    const text = [
      done.length ? `🤖 Cancelled ${done.length} order(s) not picked up in ${AUTO_DAYS}+ days:\n${done.map((r) => `• ${r.order_id}${money(r)}`).join('\n')}` : '',
      stuck.length ? `⚠️ Could not stop ${stuck.length} (nothing changed, tried again tomorrow):\n${stuck.map((r) => `• ${r.order_id}: ${r.outcome} — ${r.reason}`).join('\n')}` : '',
    ].filter(Boolean).join('\n\n');
    await (deps.alertOwner || alertOwner)(text);
  }
  return json(200, { ok: true, cancelled: done.map((r) => r.order_id), stuck: stuck.map((r) => r.order_id), left: Math.max(0, due.length - batch.length) });
}

exports.handler = (event) => handle(event);
exports._test = { handle, candidates, AUTO_DAYS, PER_RUN };
