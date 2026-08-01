/**
 * Background function: auto-book a NimbusPost reverse pickup for a return.
 *
 * Invoked fire-and-forget (Netlify returns 202 immediately) by request-return
 * the moment a customer's return is auto-approved. Doing the reverse pickup here
 * — instead of inline in request-return — means the heavy NimbusPost work
 * (login + serviceability + shipment + notifications, ~10s) never blocks the
 * customer's request or trips the 10s synchronous-function timeout. Background
 * functions get a 15-minute budget.
 *
 * It reuses process-return (the exact code the admin Returns-tab buttons call)
 * via an internal admin-secret-authed call, so there's one reverse-pickup code
 * path. If that fails (e.g. no reverse-capable courier for the pincode, or NP is
 * down) it emails the store owner so they can push the return manually — the
 * return still stands as "approved" in the Returns tab.
 *
 * Body: { return_request_id }   Header: X-Admin-Key: ADMIN_SECRET
 */

const { createClient } = require('@supabase/supabase-js');
const { sendEmail } = require('./utils/email');
const { requireAdmin } = require('./utils/admin-auth');

const CORS = { 'Content-Type': 'application/json' };

function ownerFailHtml(order, reason) {
  const oid = order?.order_display_id || order?.order_id || '(unknown order)';
  return `<div style="background:#0d0b08;color:#f0e8d8;font-family:Georgia,serif;max-width:600px;margin:0 auto;padding:32px;">
    <h1 style="color:#c9a84c;font-size:22px;font-weight:400;margin-bottom:4px;">Ink &amp; Chai</h1>
    <p style="color:#a09080;font-size:12px;letter-spacing:2px;text-transform:uppercase;margin-bottom:20px;">Admin notification</p>
    <h2 style="color:#e0a84c;font-size:19px;font-weight:400;">⚠️ Return couldn't be auto-scheduled</h2>
    <p>A customer return for <strong style="color:#c9a84c;">${oid}</strong> was approved, but NimbusPost auto-pickup failed.</p>
    <p style="color:#a09080;font-size:13px;"><strong>Reason:</strong> ${String(reason || 'unknown').slice(0, 300)}</p>
    <p style="font-size:14px;">Open the <strong>Returns</strong> tab and push it manually (Push to NP / Auto Pickup), or enter your own tracking ID.</p>
    <hr style="border:none;border-top:1px solid #2a2a2a;margin:24px 0;"/>
    <p style="color:#7a6330;font-size:11px;">Sent to the store owner &middot; inkandchai.in</p>
  </div>`;
}

async function alertOwner(returnRequestId, reason) {
  const ownerEmail = process.env.STORE_OWNER_EMAIL || 'support@inkandchai.in';
  let ret = null;
  try {
    if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY) {
      const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
        auth: { autoRefreshToken: false, persistSession: false },
      });
      const { data } = await supabase.from('return_requests')
        .select('order_display_id, order_id').eq('id', returnRequestId).maybeSingle();
      ret = data;
    }
  } catch (e) { /* naming the order is best-effort */ }
  try {
    await sendEmail({
      to: ownerEmail,
      subject: `⚠️ Return auto-pickup failed — ${ret?.order_display_id || returnRequestId}`,
      html: ownerFailHtml(ret, reason),
    });
  } catch (e) { console.error('[auto-return-pickup] owner alert email:', e.message); }
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

  const site = String(process.env.SITE_URL || process.env.URL || 'https://inkandchai.in').replace(/\/$/, '');
  const secret = process.env.ADMIN_SECRET || '';

  try {
    const pr = await fetch(`${site}/.netlify/functions/process-return`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': secret },
      body: JSON.stringify({ return_request_id: returnRequestId }),
    });
    const data = await pr.json().catch(() => ({}));
    if (!pr.ok || data.error) {
      const reason = data.error || `HTTP ${pr.status}`;
      console.warn(`[auto-return-pickup] ${returnRequestId} failed: ${reason}`);
      await alertOwner(returnRequestId, reason);
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: false, error: reason }) };
    }
    console.log(`[auto-return-pickup] ${returnRequestId} ok awb=${data.awb || '(none)'} courier=${data.courier_name || '-'}`);
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, awb: data.awb || null }) };
  } catch (e) {
    console.error(`[auto-return-pickup] ${returnRequestId} error:`, e.message);
    await alertOwner(returnRequestId, e.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: e.message }) };
  }
};
