/**
 * Netlify Function: xpressbees-webhook
 * POST /.netlify/functions/xpressbees-webhook
 *
 * Real-time shipment events from XpressBees. Registered in their panel under
 * Services -> Webhooks with a shared secret.
 *
 * WHY THIS EXISTS
 * ---------------
 * Until now XpressBees reported nothing: their panel said webhooks were
 * "available soon" for as long as we had the account, so 219 of 235 orders
 * froze at `shipped` and xpressbees-status-sync-background had to poll for
 * them. Webhooks now exist, so this is the live path and the poller becomes
 * the backstop -- for anything shipped before this was registered, and for
 * events the webhook drops.
 *
 * Their payload:
 *   { awb_number, status, event_time, location, message, rto_awb }
 *
 * THEIR RULES, WHICH SHAPE THIS FILE
 * ----------------------------------
 *   - FIVE SECOND TIMEOUT. Anything slower is recorded as a failure.
 *   - 100 consecutive failures DISABLES the webhook, silently, and we would
 *     be back to polling without knowing. So this does the minimum before
 *     answering: verify, map, one update. No notifications are sent inline.
 *   - Only a 2xx counts as received. A 3xx is a failure -- they do not follow
 *     redirects -- so this must answer directly, never via a redirect.
 *
 * Because of that, an event we cannot act on still answers 200. A 500 here
 * buys nothing and spends one of the 100 lives.
 *
 * VERIFICATION
 * ------------
 * X-Hmac-SHA256: base64(hmac_sha256(raw_body, XPRESSBEES_WEBHOOK_SECRET)),
 * compared with timingSafeEqual. Unsigned requests are refused when the
 * secret is configured: this endpoint can move an order to delivered, which
 * starts the return window, so an unauthenticated caller must not reach it.
 *
 * The status rules live in utils/xpressbees-status.js and are shared with the
 * poller, so the two can never disagree about what a scan means.
 */

const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { interpret, SYNCABLE, TERMINAL, RANK } = require('./utils/xpressbees-status');

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const ok = (body) => ({ statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify(body) });

/** Constant-time compare that tolerates unequal lengths. */
function safeEqual(a, b) {
  const x = Buffer.from(String(a || ''), 'utf8');
  const y = Buffer.from(String(b || ''), 'utf8');
  if (x.length !== y.length) return false;
  try { return crypto.timingSafeEqual(x, y); } catch { return false; }
}

function header(event, name) {
  const h = event.headers || {};
  const want = name.toLowerCase();
  for (const k of Object.keys(h)) if (k.toLowerCase() === want) return String(h[k] || '');
  return '';
}

function verify(event, rawBody) {
  const secret = String(process.env.XPRESSBEES_WEBHOOK_SECRET || '').trim();
  // Unconfigured is a deployment state, not an authorisation: say so loudly
  // and accept, so registering the webhook before setting the secret does not
  // burn 100 failures and disable it.
  if (!secret) return { okToProcess: true, note: 'XPRESSBEES_WEBHOOK_SECRET is not set — event accepted UNVERIFIED' };
  const sent = header(event, 'x-hmac-sha256');
  if (!sent) return { okToProcess: false, note: 'missing X-Hmac-SHA256' };
  const want = crypto.createHmac('sha256', secret).update(rawBody, 'utf8').digest('base64');
  return safeEqual(sent, want)
    ? { okToProcess: true }
    : { okToProcess: false, note: 'signature mismatch' };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: JSON_HEADERS, body: '' };
  if (event.httpMethod !== 'POST') return ok({ ignored: 'POST only' });

  const rawBody = event.body || '';
  const check = verify(event, rawBody);
  if (!check.okToProcess) {
    console.warn(`[xpressbees-webhook] refused: ${check.note}`);
    return { statusCode: 401, headers: JSON_HEADERS, body: JSON.stringify({ error: check.note }) };
  }
  if (check.note) console.warn(`[xpressbees-webhook] ${check.note}`);

  let payload;
  try { payload = JSON.parse(rawBody || '{}'); }
  catch { return ok({ ignored: 'invalid JSON' }); }

  // They may send one event or a batch; accept either without asking.
  const events = Array.isArray(payload) ? payload : (Array.isArray(payload.data) ? payload.data : [payload]);
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const results = [];

  for (const evt of events) {
    const awb = String(evt?.awb_number || evt?.awb || '').trim();
    const raw = String(evt?.status || '').trim();
    if (!awb) { results.push({ ignored: 'no awb_number' }); continue; }

    const { data: order, error } = await supabase
      .from('orders')
      .select('id, razorpay_order_id, status, tracking_id, shipment_moved_at, delivered_at')
      .eq('tracking_id', awb)
      .maybeSingle();
    if (error) { results.push({ awb, error: error.message }); continue; }
    if (!order) { results.push({ awb, ignored: 'no order carries this AWB' }); continue; }

    const ref = order.razorpay_order_id || order.id;
    const verdict = interpret(raw);
    const at = new Date().toISOString();
    const fields = {
      last_courier_status: raw.slice(0, 200),
      last_courier_status_at: at,
    };
    if (verdict.moved) fields.shipment_moved_at = order.shipment_moved_at || at;

    const current = String(order.status || '').toLowerCase();
    const target = verdict.status;
    const forward = target
      && SYNCABLE.includes(current)
      && !TERMINAL.includes(current)
      && !(RANK[target] && RANK[current] && RANK[target] <= RANK[current]);

    if (target && forward) {
      fields.status = target;
      if (target === 'delivered') fields.delivered_at = order.delivered_at || at;
    }

    let { error: wErr } = await supabase.from('orders').update(fields).eq('id', order.id);
    if (wErr && /last_courier_status/.test(wErr.message || '')) {
      const { last_courier_status, last_courier_status_at, ...rest } = fields;
      ({ error: wErr } = await supabase.from('orders').update(rest).eq('id', order.id));
    }
    if (wErr) { results.push({ awb, order: ref, error: wErr.message }); continue; }

    results.push({ awb, order: ref, courier_says: raw, status: fields.status || current, changed: !!fields.status });
    console.log(`[xpressbees-webhook] ${ref} ${awb} "${raw}"${fields.status ? ` → ${fields.status}` : ' (recorded only)'}`);
  }

  // Always 200 once the signature is good. See THEIR RULES.
  return ok({ received: events.length, results });
};

exports.__test = { verify, safeEqual, header };
