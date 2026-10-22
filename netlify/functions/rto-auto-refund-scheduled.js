/**
 * Scheduled: rto-auto-refund-scheduled
 *
 * Refunds prepaid RTO orders automatically -- what the customer paid minus both
 * courier legs, the same figure the admin "RTO Refunds" tab shows -- once the
 * courier confirms the parcel has been DELIVERED BACK to us.
 *
 * Hourly 13:00-18:00 IST (jobs.toml), alongside the PhonePe refund retries:
 * PhonePe fails a refund when the day's refunds exceed the day's takings, and
 * by the afternoon the day's payments have come in.
 *
 * WHAT MUST BE TRUE BEFORE MONEY MOVES (each one skips the order if not)
 *   1. RTO_AUTO_REFUND is on (wrangler.toml [vars]). Off = nothing is paid.
 *   2. orders.status is 'rto', no refund has ever been started (refund_id null),
 *      and there is a recorded gateway payment id. COD never appears.
 *   3. The order is inside the window (RTO_AUTO_REFUND_DAYS, default 90).
 *   4. No free replacement was created for it -- that customer got the books.
 *   5. After shipping there is something left to refund, and the parcel is at
 *      most 4 books (a bigger one weighs more than the bundle rate covers).
 *   6. The courier's live tracking for THIS order's AWB shows the parcel
 *      delivered back to origin (utils/rto-refund.js). Our own status column is
 *      never enough: it is written by webhooks, and it says "rto" from the
 *      moment the parcel is turned round.
 *   7. The order is atomically claimed (refund_state AUTO_CLAIMED where it is
 *      still rto with no refund), so a second run or a Refund click in the
 *      admin at the same moment cannot pay it twice.
 *
 * The refund itself goes through phonepe-refund / razorpay-refund -- the same
 * code the admin's Refund button runs -- so records, retries and the customer
 * message (sent only once the gateway says COMPLETED) are identical.
 *
 * At most RTO_AUTO_REFUND_MAX_PER_RUN (default 25) refunds per run. The owner
 * gets one WhatsApp summary per run that did anything.
 *
 * Over HTTP (owner only, via the admin tab's "Preview"), this is always a dry
 * run: it reports what the next run would refund and why the rest wait. Money
 * moves only on the scheduler's run.
 */

const { createClient } = require('@supabase/supabase-js');
const { requireAdmin } = require('./utils/admin-auth');
const rto = require('./utils/rto-refund');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key, X-Admin-Token',
  'Content-Type': 'application/json',
};
const json = (statusCode, body) => ({ statusCode, headers: { ...CORS, 'Cache-Control': 'no-store' }, body: JSON.stringify(body) });

const CLAIM = 'AUTO_CLAIMED';

function autoRefundOn() {
  return ['on', 'true', '1', 'yes'].includes(String(process.env.RTO_AUTO_REFUND || '').trim().toLowerCase());
}
const intEnv = (name, fallback, min, max) => {
  const n = parseInt(process.env[name], 10);
  return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : fallback;
};

/** Replacement orders carry the original's id in cart_items[0]._replacement. */
async function hasReplacement(supabase, orderId) {
  const { data, error } = await supabase.from('orders')
    .select('razorpay_order_id, status')
    .eq('source', 'replacement')
    // As a JSON string: given an array, supabase-js writes a Postgres array
    // literal, which a jsonb column rejects.
    .contains('cart_items', JSON.stringify([{ _replacement: { original_order_id: orderId } }]))
    .limit(5);
  if (error) throw new Error(`replacement check: ${error.message}`);
  return (data || []).filter(r => r.status !== 'cancelled').map(r => r.razorpay_order_id);
}

/** Calls the admin refund endpoint in-process, authenticated as the owner. */
function defaultRefund(gateway, orderId, amountPaise) {
  const name = gateway === 'razorpay' ? 'razorpay-refund' : 'phonepe-refund';
  // Static requires: a template-string require makes the bundler pull in every
  // file in this folder, test files included.
  const mod = gateway === 'razorpay' ? require('./razorpay-refund') : require('./phonepe-refund');
  return mod.handler({
    httpMethod: 'POST',
    path: `/.netlify/functions/${name}`,
    headers: { 'content-type': 'application/json', 'x-admin-key': process.env.ADMIN_SECRET || '' },
    body: JSON.stringify({ order_id: orderId, amount_paise: amountPaise, auto_rto: true }),
  });
}

async function defaultXbTrack(awb) {
  return require('./utils/xpressbees').track(awb);
}

async function defaultOwnerAlert(text) {
  const phone = process.env.STORE_OWNER_PHONE;
  if (!phone) return;
  try { await require('./utils/whatsapp').sendText(phone, text); } catch (e) { console.warn('[rto-auto-refund] owner alert:', e.message); }
}

const rs = (paise) => `₹${(paise / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

/**
 * @param deps { supabase, xbTrack, npTrackMany, refund, ownerAlert, now }
 * @param opts { dryRun, days, maxPerRun }
 */
async function runAutoRefund(deps, opts = {}) {
  const { supabase } = deps;
  const xbTrack = deps.xbTrack || defaultXbTrack;
  const npTrackMany = deps.npTrackMany || rto.npTrackMany;
  const refund = deps.refund || defaultRefund;
  const ownerAlert = deps.ownerAlert || defaultOwnerAlert;
  const now = deps.now ? deps.now() : Date.now();
  const dryRun = !!opts.dryRun;
  const days = opts.days || 90;
  const maxPerRun = opts.maxPerRun || 25;
  const maxAutoBooks = opts.maxAutoBooks || 4;
  const rates = opts.rates || rto.defaultRates();

  const summary = {
    dry_run: dryRun, window_days: days, max_per_run: maxPerRun,
    considered: 0, verified: 0, refunded: [], would_refund: [], waiting: [], skipped: [], failed: [],
  };

  const sinceIso = new Date(now - days * 86400000).toISOString();
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from('orders')
      .select('id, razorpay_order_id, razorpay_payment_id, amount_paise, status, created_at, customer_name, '
            + 'cart_items, tracking_id, courier_name, refund_id, refund_state')
      .eq('status', 'rto')
      .is('refund_id', null)
      .gte('created_at', sinceIso)
      .order('created_at', { ascending: true })
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    rows.push(...(data || []));
    if (!data || data.length < 1000) break;
  }

  // Cheap checks first; live tracking only for orders that could be paid.
  const eligible = [];
  for (const o of rows) {
    const id = o.razorpay_order_id;
    const calc = rto.rtoRefundFor(o, { rates });
    if (!calc.gateway) continue;                        // COD: nothing of theirs to return
    summary.considered++;
    const base = { order_id: id, gateway: calc.gateway, paid_paise: calc.gross, deduction_paise: calc.deduction, refund_paise: calc.refund, awb: o.tracking_id || '', courier: o.courier_name || '' };
    if (o.refund_state) { summary.skipped.push({ ...base, reason: `refund state ${o.refund_state}` }); continue; }
    if (calc.refund <= 0) { summary.skipped.push({ ...base, reason: 'nothing left after shipping' }); continue; }
    if (calc.refund > calc.gross) { summary.skipped.push({ ...base, reason: 'refund exceeds amount paid' }); continue; }
    if (!o.tracking_id) { summary.skipped.push({ ...base, reason: 'no AWB to verify' }); continue; }
    // The bundle rate is two slabs. A big parcel crosses many more, so the flat
    // deduction would over-refund it: those are left for the owner to price.
    if ((calc.parcel.books || 0) > maxAutoBooks) {
      summary.skipped.push({ ...base, reason: `${calc.parcel.books}-book parcel: deduct the real courier charge and refund by hand` });
      continue;
    }
    eligible.push({ order: o, base });
  }

  // One NimbusPost login for the whole batch.
  const npAwbs = eligible.filter(e => rto.courierFor(e.order.tracking_id) === 'nimbuspost').map(e => e.order.tracking_id);
  let npRows = new Map();
  let npError = null;
  if (npAwbs.length) {
    try { npRows = await npTrackMany(npAwbs); } catch (e) { npError = e.message; }
  }

  for (const { order, base } of eligible) {
    const awb = String(order.tracking_id).trim();
    let check;
    if (rto.courierFor(awb) === 'xpressbees') {
      try { check = rto.xbReturnedToOrigin(await xbTrack(awb), awb); }
      catch (e) { check = { verified: false, reason: `XpressBees lookup failed: ${String(e.message || e).slice(0, 120)}` }; }
    } else {
      check = npError ? { verified: false, reason: `NimbusPost lookup failed: ${npError}` } : rto.npReturnedToOrigin(npRows.get(awb), awb);
    }
    if (!check.verified) { summary.waiting.push({ ...base, reason: check.reason }); continue; }
    summary.verified++;

    let repl;
    try { repl = await hasReplacement(supabase, base.order_id); }
    catch (e) { summary.skipped.push({ ...base, reason: e.message }); continue; }
    if (repl.length) { summary.skipped.push({ ...base, reason: `replacement sent (${repl.join(', ')})` }); continue; }

    const item = { ...base, scan: check.scan };
    if (dryRun) { summary.would_refund.push(item); continue; }
    if (summary.refunded.length + summary.failed.length >= maxPerRun) {
      summary.skipped.push({ ...item, reason: `per-run cap of ${maxPerRun} reached; next run` });
      continue;
    }

    // Claim: only if it is still an untouched RTO. Loses to a concurrent
    // admin click or another run, which is the point.
    const { data: claimed, error: claimErr } = await supabase.from('orders')
      .update({ refund_state: CLAIM, refund_updated_at: new Date(now).toISOString() })
      .eq('id', order.id).eq('status', 'rto').is('refund_id', null).is('refund_state', null)
      .select('id');
    if (claimErr || !claimed || !claimed.length) {
      summary.skipped.push({ ...item, reason: claimErr ? `claim failed: ${claimErr.message}` : 'changed since it was read' });
      continue;
    }

    let res, out = {};
    try {
      res = await refund(base.gateway, base.order_id, base.refund_paise);
      try { out = JSON.parse(res.body || '{}'); } catch { out = {}; }
    } catch (e) {
      res = { statusCode: 500 }; out = { error: e.message };
    }
    if (res.statusCode === 200 && out.success) {
      summary.refunded.push({ ...item, state: out.state || null, message: out.message || null });
    } else {
      summary.failed.push({ ...item, error: String(out.error || `HTTP ${res.statusCode}`).slice(0, 200) });
      // If the endpoint refused before recording anything, the claim is all
      // that is on the row: release it so the tab shows the order as payable
      // again. A gateway failure it DID record (refund_failed + refund_id) is
      // left alone for the retry job.
      await supabase.from('orders').update({ refund_state: null })
        .eq('id', order.id).eq('refund_state', CLAIM).is('refund_id', null)
        .then(() => {}, () => {});
    }
  }

  if (!dryRun && (summary.refunded.length || summary.failed.length)) {
    const total = summary.refunded.reduce((s, r) => s + r.refund_paise, 0);
    const lines = [`↩️ RTO auto-refund: ${summary.refunded.length} refunded (${rs(total)})`
      + (summary.failed.length ? `, ${summary.failed.length} failed` : '')];
    for (const r of summary.refunded.slice(0, 15)) lines.push(`✅ ${r.order_id} ${rs(r.refund_paise)} (paid ${rs(r.paid_paise)} − ${rs(r.deduction_paise)} shipping) · ${r.state || ''}`);
    for (const f of summary.failed.slice(0, 10)) lines.push(`⚠️ ${f.order_id} ${rs(f.refund_paise)}: ${f.error}`);
    if (summary.waiting.length) lines.push(`${summary.waiting.length} more are still on their way back and will be refunded once delivered to us.`);
    await ownerAlert(lines.join('\n'));
  }
  return summary;
}

exports.handler = async (event = {}) => {
  const fromCron = !event.rawUrl;
  if (!fromCron) {
    if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
    const blocked = requireAdmin(event, CORS);
    if (blocked) return blocked;
  }
  // Only the scheduler moves money. An HTTP call is always a preview.
  const dryRun = !fromCron;
  if (!dryRun && !autoRefundOn()) {
    console.log('[rto-auto-refund] skipped: RTO_AUTO_REFUND is off');
    return json(200, { ok: true, enabled: false });
  }
  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const summary = await runAutoRefund({ supabase }, {
      dryRun,
      days: intEnv('RTO_AUTO_REFUND_DAYS', 90, 1, 365),
      maxPerRun: intEnv('RTO_AUTO_REFUND_MAX_PER_RUN', 25, 1, 100),
    });
    console.log(`[rto-auto-refund] ${dryRun ? 'preview' : 'run'} considered=${summary.considered} verified=${summary.verified} refunded=${summary.refunded.length} failed=${summary.failed.length} waiting=${summary.waiting.length}`);
    return json(200, { ok: true, enabled: autoRefundOn(), ...summary });
  } catch (e) {
    console.error('[rto-auto-refund]', e);
    return json(500, { error: e.message });
  }
};

exports.runAutoRefund = runAutoRefund;
exports.CLAIM = CLAIM;
