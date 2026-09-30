/**
 * Background function: book the reverse pickup for a return, with fallbacks.
 *
 * Invoked fire-and-forget by request-return the moment a customer's return is
 * auto-approved (the booking takes ~10s, too long to do inline).
 *
 *   1. XpressBees reverse pickup      (process-return, action 'xpressbees')
 *   2. else NimbusPost reverse pickup (process-return, default action)
 *   3. else the customer is asked to send the parcel by India Post Speed Post,
 *      and told we pay the postage: they send the receipt and their UPI ID and
 *      the owner reimburses them. The owner is alerted with both courier errors.
 *
 * Both courier attempts go through process-return -- the exact code behind the
 * Returns-tab buttons -- so the record, guards and customer "pickup scheduled"
 * notice are the ones a manual booking produces.
 *
 * process-return answers a REFUSED booking with HTTP 200 and `pushed: false`
 * (the return itself still stands). Only `pushed: true` counts as booked here;
 * reading anything else as success is how failed pickups used to go unreported.
 *
 * Safe to run twice: a return that already has an AWB, is not 'approved', or
 * has already been sent the India Post notice is left alone, and the India Post
 * step claims the row before messaging, so a customer gets that notice once.
 * The return stays 'approved', so the owner can still book a pickup by hand.
 *
 * Body: { return_request_id }   Header: X-Admin-Key: ADMIN_SECRET
 */

const { createClient } = require('@supabase/supabase-js');
const { requireAdmin } = require('./utils/admin-auth');

const CORS = { 'Content-Type': 'application/json' };
const INDIA_POST = 'India Post (customer posts)';
const WA_TEMPLATE = 'return_self_ship_india_post';

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const firstName = (n) => String(n || '').trim().split(/\s+/)[0] || 'there';

/** Where the customer posts it: the same warehouse the couriers deliver returns to. */
function returnAddress() {
  const p = require('./utils/xpressbees').pickupFromEnv();
  return {
    line: `${p.name}, ${p.address}, ${p.address_2 ? p.address_2 + ', ' : ''}${p.city}, ${p.state} ${p.pincode}. Phone ${p.phone}`,
    ...p,
  };
}

/** process-return, in-process, authenticated as the owner. */
async function callProcessReturn(body) {
  const res = await require('./process-return').handler({
    httpMethod: 'POST',
    path: '/.netlify/functions/process-return',
    headers: { 'content-type': 'application/json', 'x-admin-key': process.env.ADMIN_SECRET || '' },
    body: JSON.stringify(body),
  });
  let data = {};
  try { data = JSON.parse(res.body || '{}'); } catch { /* reported below */ }
  return { statusCode: res.statusCode, data };
}

function refusal(r) {
  return String(r.data.np_error || r.data.error || r.data.message || `HTTP ${r.statusCode}`).slice(0, 300);
}

function customerEmailHtml(ret, addr) {
  const oid = esc(ret.order_display_id || ret.order_id || '');
  return `<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#2a2018;background:#faf7f2;">
    <h2 style="font-family:Georgia,serif;font-weight:400;color:#8a6a1f;">Please post your return to us</h2>
    <p>Hi ${esc(firstName(ret.customer_name))},</p>
    <p>Your return for <strong>${oid}</strong> is approved, but none of our courier partners can collect parcels from your pincode. Please send the book(s) to us by <strong>India Post (Speed Post)</strong> instead &mdash; <strong>we will pay the postage</strong>.</p>
    <p style="background:#fff;border:1px solid #e6dcc8;padding:12px 14px;line-height:1.6;"><strong>Send to:</strong><br/>${esc(addr.name)}<br/>${esc(addr.address)}${addr.address_2 ? '<br/>' + esc(addr.address_2) : ''}<br/>${esc(addr.city)}, ${esc(addr.state)} ${esc(addr.pincode)}<br/>Phone: ${esc(addr.phone)}</p>
    <ol style="line-height:1.7;padding-left:18px;">
      <li>Pack the book(s) securely and write your order ID <strong>${oid}</strong> on the parcel.</li>
      <li>Send it by Speed Post from any post office and keep the receipt.</li>
      <li>Reply to this email (or WhatsApp us) with a photo of the receipt, the tracking number and your UPI ID.</li>
    </ol>
    <p>We will reimburse the full postage to your UPI, and process your return as soon as the parcel reaches us.</p>
    <p style="font-size:12px;color:#8a7a62;margin-top:20px;">Ink &amp; Chai &middot; support@inkandchai.in</p>
  </div>`;
}

async function defaultNotifyCustomer(ret, addr) {
  const out = { email: null, whatsapp: null };
  if (ret.customer_email) {
    try {
      await require('./utils/email').sendEmail({
        to: ret.customer_email,
        subject: `Please post your return to us — we pay the postage (${ret.order_display_id || ret.order_id || ''})`,
        html: customerEmailHtml(ret, addr),
      });
      out.email = { ok: true };
    } catch (e) { out.email = { ok: false, error: e.message }; }
  }
  if (ret.customer_phone) {
    // Needs the Meta-approved template; until it is approved this fails and
    // the email above is the notice.
    try {
      out.whatsapp = await require('./utils/whatsapp').sendWhatsApp({
        to: ret.customer_phone,
        template: WA_TEMPLATE,
        params: [firstName(ret.customer_name), String(ret.order_display_id || ret.order_id || ''), addr.line],
      });
    } catch (e) { out.whatsapp = { ok: false, error: e.message }; }
  }
  return out;
}

async function defaultAlertOwner(subject, text) {
  const ownerEmail = process.env.STORE_OWNER_EMAIL || 'support@inkandchai.in';
  try {
    await require('./utils/email').sendEmail({
      to: ownerEmail, subject,
      html: `<div style="font-family:Arial,sans-serif;max-width:600px;padding:20px;white-space:pre-wrap;">${esc(text)}</div>`,
    });
  } catch (e) { console.error('[auto-return-pickup] owner email:', e.message); }
  if (process.env.STORE_OWNER_PHONE) {
    try { await require('./utils/whatsapp').sendText(process.env.STORE_OWNER_PHONE, `${subject}\n${text}`); } catch { /* email is the record */ }
  }
}

const BOOKED = ['pickup_scheduled', 'pushed_to_nimbus'];

/**
 * @param deps { supabase, processReturn, notifyCustomer, alertOwner, address }
 * @returns {{ outcome: 'xpressbees'|'nimbuspost'|'india_post'|'skipped', ... }}
 */
async function runReturnPickup(deps, returnRequestId) {
  const { supabase } = deps;
  const processReturn = deps.processReturn || callProcessReturn;
  const notifyCustomer = deps.notifyCustomer || defaultNotifyCustomer;
  const alertOwner = deps.alertOwner || defaultAlertOwner;

  const load = async () => {
    const { data, error } = await supabase.from('return_requests').select('*').eq('id', returnRequestId).maybeSingle();
    if (error) throw new Error(error.message);
    return data;
  };
  const settled = (r) => {
    if (!r) return 'return request not found';
    if (r.awb || BOOKED.includes(r.status)) return `already booked${r.awb ? ` (AWB ${r.awb})` : ''}`;
    if (r.courier_name === INDIA_POST) return 'customer already asked to post it by India Post';
    if (r.status !== 'approved') return `return is ${r.status || 'not approved'}`;
    return null;
  };

  let ret = await load();
  const why = settled(ret);
  if (why) return { outcome: 'skipped', reason: why };

  const xb = await processReturn({ return_request_id: returnRequestId, action: 'xpressbees' });
  if (xb.data.pushed === true) return { outcome: 'xpressbees', awb: xb.data.awb || null };
  const xbWhy = refusal(xb);

  // A refusal from the XpressBees branch may itself be "already booked" by a
  // concurrent run; re-check before trying the next courier.
  ret = await load();
  const mid = settled(ret);
  if (mid) return { outcome: 'skipped', reason: mid, xpressbees: xbWhy };

  const np = await processReturn({ return_request_id: returnRequestId });
  if (np.data.pushed === true) return { outcome: 'nimbuspost', awb: np.data.awb || null, xpressbees: xbWhy };
  const npWhy = refusal(np);

  // Claim before messaging, so the customer hears this once.
  const { data: claimed, error: claimErr } = await supabase.from('return_requests')
    .update({
      courier_name: INDIA_POST,
      last_push_error: `XpressBees: ${xbWhy} | NimbusPost: ${npWhy}`.slice(0, 500),
      last_push_error_at: new Date().toISOString(),
    })
    .eq('id', returnRequestId).eq('status', 'approved').is('awb', null)
    // Quoted: the value has parentheses, which PostgREST's or() syntax reserves.
    .or(`courier_name.is.null,courier_name.neq."${INDIA_POST}"`)
    .select('id');
  if (claimErr) throw new Error(`India Post claim: ${claimErr.message}`);
  if (!claimed || !claimed.length) return { outcome: 'skipped', reason: 'changed while booking', xpressbees: xbWhy, nimbuspost: npWhy };

  const addr = deps.address || returnAddress();
  const notified = await notifyCustomer(ret, addr);
  const oid = ret.order_display_id || ret.order_id || returnRequestId;
  await alertOwner(`📮 Return ${oid}: no courier pickup — customer asked to use India Post`,
    `Neither courier would book a reverse pickup.\nXpressBees: ${xbWhy}\nNimbusPost: ${npWhy}\n\n`
    + `The customer (${ret.customer_name || '—'} · ${ret.customer_phone || '—'}) has been asked to Speed Post it to the warehouse and send the receipt, tracking number and UPI ID. `
    + `Reimburse the postage from the receipt once it arrives. `
    + `Email: ${notified.email?.ok ? 'sent' : 'not sent'} · WhatsApp: ${notified.whatsapp?.ok ? 'sent' : 'not sent (template ' + WA_TEMPLATE + ' approved?)'}.\n`
    + `The return stays approved in the Returns tab: enter the India Post tracking number there when they send it.`);
  return { outcome: 'india_post', xpressbees: xbWhy, nimbuspost: npWhy, notified };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  const block = requireAdmin(event, CORS); if (block) return block;

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch { /* empty */ }
  const returnRequestId = String(body.return_request_id || '').trim();
  if (!returnRequestId) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'return_request_id required' }) };
  }

  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const out = await runReturnPickup({ supabase }, returnRequestId);
    console.log(`[auto-return-pickup] ${returnRequestId} → ${out.outcome}${out.awb ? ' awb=' + out.awb : ''}${out.reason ? ' (' + out.reason + ')' : ''}`);
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, ...out }) };
  } catch (e) {
    console.error(`[auto-return-pickup] ${returnRequestId} error:`, e.message);
    await defaultAlertOwner(`⚠️ Return auto-pickup failed — ${returnRequestId}`,
      `${e.message}\n\nOpen the Returns tab and book the pickup by hand.`);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: e.message }) };
  }
};

exports.runReturnPickup = runReturnPickup;
exports.INDIA_POST = INDIA_POST;
exports.WA_TEMPLATE = WA_TEMPLATE;
exports.customerEmailHtml = customerEmailHtml;
