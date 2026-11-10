/**
 * Scheduled: cancelled-parcels-scheduled -- daily, 09:00 IST (jobs.toml)
 *
 * "Is any courier still carrying a parcel for an order we cancelled?"
 *
 * WHY
 * ---
 * On 10 Nov 2026 the Couriers <-> Admin check found 42 cancelled or refunded
 * orders still live with XpressBees: 9 delivered, 21 RTO, 6 in transit, 2
 * waiting for pickup. 38 were COD orders the customer cancelled from My
 * Orders after the AWB was on the order; cancel-order.js asked only
 * NimbusPost to stop it, so the XpressBees parcel went out. 21 more were
 * found waiting for pickup and stopped by hand that day.
 *
 * WHAT IT DOES
 * ------------
 * Reads every XpressBees and NimbusPost shipment of the last 30 days (the same
 * read as admin-xb-reconcile) and takes the ones whose order is closed here:
 *
 *   waiting for pickup  -> stopped through courier-cancel-shipment's
 *                          stopShipment: the courier is asked LIVE first and
 *                          only a parcel still waiting is cancelled; an AWB
 *                          another order carries is refused; the order must be
 *                          cancelled here (or customer-cancelled and refunded).
 *                          A refunded order that is not a customer cancel is
 *                          NOT stopped, only listed.
 *   picked up, moving   -> listed for the owner: ask the courier for an RTO.
 *   delivered / RTO     -> counted in the email only; nothing left to do.
 *
 * Order status is never changed, and the customer is never messaged. The owner
 * gets an email (STORE_OWNER_EMAIL) and a WhatsApp text (STORE_OWNER_PHONE,
 * plain text, so it only arrives inside the 24-hour window; the email is the
 * record). Nothing is sent on a day with nothing to report.
 *
 * Off switch: CANCELLED_PARCELS_STOP=0 lists only, stops nothing.
 *
 * Also POSTed by the owner: { dry_run } -- dry_run defaults to TRUE over HTTP,
 * so a manual call shows what the job would do and changes nothing.
 */
const { createClient } = require('@supabase/supabase-js');
const { requireAdmin } = require('./utils/admin-auth');
const { makeCaller } = require('./admin-xpressbees-labels').lib;
const { report } = require('./admin-xb-reconcile').lib;
const { stopShipment } = require('./courier-cancel-shipment').__test;
const { sendEmail } = require('./utils/email');
const { sendText } = require('./utils/whatsapp');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key, X-Admin-Token',
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
};
const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });

const DAYS = 30;
const MAX_STOPS = 60;
const DONE = /^\s*delivered\s*$|rto|return|lost|damage|destroy/i;   // nothing left to stop
const OFD = /out[\s_]*for[\s_]*delivery|undelivered|in[\s_]*transit/i;
const WAITING = /pending[\s_]*pickup|pickup[\s_]*(pending|scheduled)|not[\s_]*picked|awaiting|booked|manifest|ready[\s_]*to[\s_]*ship|data[\s_]*received|^\s*new\s*$/i;

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** Pure: what the courier list says about a closed order's parcel. */
function stage(courierStatus) {
  const s = String(courierStatus || '');
  if (/rto|return/i.test(s)) return 'done';   // "rto in transit" is on its way back to us
  if (OFD.test(s)) return 'moving';
  if (WAITING.test(s)) return 'waiting';
  if (DONE.test(s)) return 'done';
  return 'moving';
}

async function run(db, { dryRun, stop }, deps = {}) {
  const rep = await (deps.report || report)(db, deps.call || makeCaller({}), { days: DAYS }, deps);
  const closed = rep.rows.filter((r) => r.kind === 'order_closed');
  const out = { checked: rep.live, closed: closed.length, errors: rep.errors, stopped: [], already: [], moving: [], not_stopped: [], done: [] };

  for (const r of closed) {
    const line = { order_id: r.order_id, status: r.our_status, courier: r.courier, awb: r.awb, courier_status: r.xb_status, customer: r.customer };
    const st = stage(r.xb_status);
    if (st === 'done') { out.done.push(line); continue; }
    if (st === 'moving') { out.moving.push(line); continue; }
    if (dryRun || !stop || out.stopped.length + out.not_stopped.length >= MAX_STOPS) {
      out.not_stopped.push({ ...line, why: dryRun ? 'dry run' : (!stop ? 'stopping is switched off' : 'too many in one run') });
      continue;
    }
    let res;
    try {
      res = await (deps.stopShipment || stopShipment)(db, r._order, deps.stopDeps || {}, {
        awb: r.awb, courierHint: r.source === 'XpressBees' ? 'xpressbees' : 'nimbuspost',
      });
    } catch (e) {
      res = { code: 500, body: { error: e.message } };
    }
    const action = res.body && res.body.courier && res.body.courier.action;
    if (action === 'cancelled') out.stopped.push(line);
    else if (action === 'already_cancelled') out.already.push(line);
    else if (action === 'moving') out.moving.push({ ...line, courier_status: res.body.courier.state || line.courier_status });
    else out.not_stopped.push({ ...line, why: (res.body && (res.body.error || (res.body.courier && res.body.courier.message))) || 'unknown' });
  }
  return out;
}

function message(out) {
  const ln = (x) => `${x.order_id} · ${x.courier} ${x.awb} · ${x.courier_status || '?'}${x.why ? ` · ${x.why}` : ''}`;
  const parts = ['📦 Cancelled orders still with a courier'];
  if (out.stopped.length) parts.push(`\n✅ Stopped before pickup (${out.stopped.length}):\n${out.stopped.map(ln).join('\n')}`);
  if (out.moving.length) parts.push(`\n🚚 Already picked up (${out.moving.length}). Ask the courier for an RTO, or the customer can refuse it:\n${out.moving.map(ln).join('\n')}`);
  if (out.not_stopped.length) parts.push(`\n⚠️ Waiting for pickup but NOT stopped (${out.not_stopped.length}). Use Stop shipment on the order:\n${out.not_stopped.map(ln).join('\n')}`);
  return parts.join('\n');
}

function html(out) {
  const table = (title, rows) => (rows.length ? `<h3>${esc(title)} (${rows.length})</h3><table border="1" cellpadding="4" cellspacing="0" style="border-collapse:collapse;font:13px sans-serif">`
    + '<tr><th>Order</th><th>Our status</th><th>Courier</th><th>AWB</th><th>Courier says</th><th>Note</th></tr>'
    + rows.map((x) => `<tr><td>${esc(x.order_id)}</td><td>${esc(x.status)}</td><td>${esc(x.courier)}</td><td>${esc(x.awb)}</td><td>${esc(x.courier_status)}</td><td>${esc(x.why || '')}</td></tr>`).join('')
    + '</table>' : '');
  return `<div style="font:14px sans-serif"><p>Daily check of every XpressBees and NimbusPost shipment of the last ${DAYS} days against orders cancelled or refunded here. Order statuses were not changed and no customer was messaged.</p>`
    + table('Stopped before pickup', out.stopped)
    + table('Already picked up: ask the courier for an RTO', out.moving)
    + table('Waiting for pickup but not stopped', out.not_stopped)
    + table('Finished (delivered or returned), for the record', out.done)
    + (Object.keys(out.errors || {}).length ? `<p>Could not read: ${esc(JSON.stringify(out.errors))}</p>` : '')
    + '</div>';
}

/** Something the owner should hear about today? Finished parcels alone are not news. */
const worthSending = (out) => out.stopped.length + out.moving.length + out.not_stopped.length > 0;

exports.handler = async (event = {}) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  const fromCron = !!(event.headers && event.headers['x-cloudflare-cron']);
  if (!fromCron) { const block = requireAdmin(event, CORS); if (block) return block; }
  let body = {};
  try { body = JSON.parse(event.body || '{}') || {}; } catch { body = {}; }
  // Over HTTP nothing is stopped unless the owner says dry_run:false.
  const dryRun = fromCron ? false : body.dry_run !== false;
  const stop = !/^(0|false|no|off)$/i.test(String(process.env.CANCELLED_PARCELS_STOP || ''));

  try {
    const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const out = await run(db, { dryRun, stop });
    const summary = { dry_run: dryRun, stop_enabled: stop, checked: out.checked, closed: out.closed,
      stopped: out.stopped, already_cancelled: out.already.length, moving: out.moving, not_stopped: out.not_stopped, done: out.done.length, errors: out.errors };
    if (dryRun) return json(200, { ...summary, would_send: worthSending(out) });
    if (!worthSending(out)) return json(200, { ...summary, sent: false });

    const subject = `Cancelled orders with a courier: ${out.stopped.length} stopped, ${out.moving.length} picked up`;
    const sent = {};
    if (process.env.STORE_OWNER_EMAIL) {
      sent.email = await sendEmail({ to: process.env.STORE_OWNER_EMAIL, subject, html: html(out) }).then((r) => !!(r && r.ok !== false)).catch(() => false);
    }
    if (process.env.STORE_OWNER_PHONE) {
      sent.whatsapp = await sendText(process.env.STORE_OWNER_PHONE, message(out).slice(0, 4000)).then((r) => !!(r && r.ok !== false)).catch(() => false);
    }
    return json(200, { ...summary, sent });
  } catch (e) {
    console.error('[cancelled-parcels-scheduled]', e);
    return json(500, { error: e.message });
  }
};

exports._test = { run, stage, message, html, worthSending };
