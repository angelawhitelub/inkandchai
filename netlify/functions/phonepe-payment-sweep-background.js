/**
 * Background worker: find orders the customer HAS paid on PhonePe but which our
 * DB still records as unpaid, and write the payment back.
 *
 * Why this exists
 * ---------------
 * A PhonePe payment reaches us two ways — the webhook, and the browser's return
 * to phonepe-verify-status. When BOTH miss (webhook dropped, customer closes the
 * app before the redirect), the money is captured and nothing here knows. The
 * order keeps a status with no payment id, and from then on every money check we
 * have — including the COD/prepaid decision in nimbuspost-order-push — reads it
 * as unpaid and ships it COD. The courier then collects a second time.
 *
 * That happened to 41 orders. phonepe-reconcile existed but only ever re-checked
 * status='pending_phonepe', so an order that had moved on to any other status
 * was invisible to it, and nothing else looked. The failure was silent and only
 * surfaced when a customer complained.
 *
 * PhonePe's status endpoint is keyed by OUR order id, so the authoritative
 * answer is always one call away. This asks for every recent order that carries
 * no payment id, rather than waiting to be told.
 *
 * Deliberate limits
 * -----------------
 *  - Never emails the customer. By the time this runs the order may already be
 *    delivered, and a "payment received" mail days later reads as a second
 *    charge. The owner gets one digest instead and decides.
 *  - Never marks an order paid on a part payment — a partial-COD deposit maps to
 *    partial_cod_pending, exactly as phonepe-webhook does.
 *  - Never touches the shipment. An AWB already carrying a COD instruction can
 *    only be changed inside NimbusPost, so a live COD shipment on a paid order is
 *    escalated to the owner, loudly, as money about to be collected twice.
 *  - Writes only where razorpay_payment_id IS NULL, so it can't race the webhook.
 */

const { createClient } = require('@supabase/supabase-js');
const { sendEmail } = require('./utils/email');
const { requireAdmin } = require('./utils/admin-auth');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key, X-Admin-Token',
  'Content-Type': 'application/json',
};

const HOST = () => process.env.PHONEPE_HOST || 'https://api.phonepe.com/apis';
// How far back to look. A payment that never landed is found within minutes at
// this cadence; the window only matters after an outage.
const SWEEP_DAYS = Number(process.env.PHONEPE_SWEEP_DAYS || 14);
// Ceiling on PhonePe calls per run so the worker always finishes well inside its
// budget. At 120ms apiece this is ~1 minute of the 15 available.
const MAX_CHECKS = Number(process.env.PHONEPE_SWEEP_MAX || 400);

// Statuses that already account for the money, so there is nothing to discover.
const SETTLED = new Set(['paid', 'refunded', 'partially_refunded', 'refund_pending', 'partial_cod_pending']);

// The admin "mark prepaid" button writes a synthetic `prepaid:<uuid>` in place
// of a gateway reference. That is a bookkeeping marker, not a payment id: it
// records that a human believes the order is paid, and it must NOT stop us
// finding and recording the real transaction. Refunds and support both need the
// actual PhonePe reference.
const PLACEHOLDER_ID = /^(prepaid|manual|cod)\s*:/i;
const hasRealGatewayId = (v) => Boolean(String(v || '').trim()) && !PLACEHOLDER_ID.test(String(v));

let _token = { value: null, expiresAt: 0 };
async function accessToken() {
  if (_token.value && Date.now() < _token.expiresAt - 60_000) return _token.value;
  const body = new URLSearchParams({
    client_id: process.env.PHONEPE_CLIENT_ID,
    client_secret: process.env.PHONEPE_CLIENT_SECRET,
    client_version: process.env.PHONEPE_CLIENT_VERSION || '1',
    grant_type: 'client_credentials',
  });
  const res = await fetch(`${HOST()}/identity-manager/v1/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Error('PhonePe OAuth failed: ' + (data.message || data.error || ('HTTP ' + res.status)));
  }
  _token = {
    value: data.access_token,
    expiresAt: data.expires_at ? data.expires_at * 1000 : Date.now() + (data.expires_in || 3300) * 1000,
  };
  return _token.value;
}

function paymentMeta(order) {
  const items = Array.isArray(order?.cart_items) ? order.cart_items : [];
  for (const i of items) if (i?._payment) return i._payment;
  return {};
}

/** A shipment is live once it has an AWB and hasn't finished its journey. */
function shipmentLive(order) {
  return Boolean(order.tracking_id)
    && !['cancelled', 'refunded', 'rto'].includes(String(order.status || ''));
}

function digestHtml(found, atRisk) {
  const row = (f) => `
    <tr>
      <td style="padding:6px 10px;border-bottom:1px solid #2a2a2a;color:#f0e8d8;">${f.id}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #2a2a2a;color:#a09080;">${f.name || '—'}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #2a2a2a;color:#c9a84c;">₹${f.paidRs.toLocaleString('en-IN')}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #2a2a2a;color:#a09080;">${f.wasStatus}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #2a2a2a;color:#a09080;font-size:11px;">${f.utr || f.txn}</td>
    </tr>`;
  return `
    <div style="background:#0d0b08;color:#f0e8d8;font-family:Georgia,serif;max-width:720px;margin:0 auto;padding:32px;">
      <h1 style="color:#c9a84c;font-size:22px;font-weight:400;margin-bottom:4px;">Ink &amp; Chai</h1>
      <h2 style="color:#f0e8d8;font-size:18px;font-weight:400;">PhonePe payments recovered</h2>
      <p style="color:#a09080;line-height:1.7;font-size:14px;">
        ${found.length} order${found.length === 1 ? ' was' : 's were'} paid on PhonePe but recorded here as unpaid.
        The payment has now been written to the order.
      </p>
      ${atRisk.length ? `
      <div style="margin:18px 0;padding:14px 16px;background:#2a1414;border-left:3px solid #d05050;">
        <p style="color:#ff9a9a;margin:0 0 8px;font-size:15px;"><strong>${atRisk.length} of these already have a LIVE COD shipment.</strong></p>
        <p style="color:#f0e8d8;margin:0;font-size:13px;line-height:1.7;">
          The courier will collect a second time. Only NimbusPost can change a booked AWB —
          convert these to prepaid / ₹0 collectable now:<br/><br/>
          ${atRisk.map(f => `<strong style="color:#c9a84c;">${f.awb}</strong> — ${f.id} — ₹${f.paidRs.toLocaleString('en-IN')}`).join('<br/>')}
        </p>
      </div>` : ''}
      <table style="width:100%;border-collapse:collapse;font-size:13px;margin-top:12px;">
        <thead><tr>
          <th align="left" style="padding:6px 10px;color:#7a6330;font-weight:400;">Order</th>
          <th align="left" style="padding:6px 10px;color:#7a6330;font-weight:400;">Customer</th>
          <th align="left" style="padding:6px 10px;color:#7a6330;font-weight:400;">Paid</th>
          <th align="left" style="padding:6px 10px;color:#7a6330;font-weight:400;">Was</th>
          <th align="left" style="padding:6px 10px;color:#7a6330;font-weight:400;">UTR / txn</th>
        </tr></thead>
        <tbody>${found.map(row).join('')}</tbody>
      </table>
      <p style="color:#7a6330;font-size:11px;margin-top:24px;">
        No customer was emailed — they already hold a payment receipt.
      </p>
    </div>`;
}

exports.handler = async (event) => {
  if (event && event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  // Invoked by the scheduler with ADMIN_SECRET, or by hand from the admin panel.
  const block = requireAdmin(event || {}, CORS);
  if (block) return block;

  if (!process.env.PHONEPE_CLIENT_ID || !process.env.PHONEPE_CLIENT_SECRET) {
    console.warn('[phonepe-sweep] PhonePe is not configured — nothing to do');
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ skipped: 'phonepe_not_configured' }) };
  }
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  const since = new Date(Date.now() - SWEEP_DAYS * 86400e3).toISOString();
  // Supabase caps a select at 1000 rows; page explicitly or the sweep silently
  // scans an arbitrary slice and reports a clean bill of health it never earned.
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from('orders')
      .select('id,razorpay_order_id,status,amount_paise,razorpay_payment_id,tracking_id,cart_items,customer_name,created_at')
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .range(from, from + 999);
    if (error) throw error;
    if (!data?.length) break;
    rows.push(...data);
    if (data.length < 1000) break;
  }

  // A placeholder id still counts as "no gateway reference", and an order marked
  // paid by hand still deserves its real transaction recorded — so the settled
  // check is skipped for those.
  const candidates = rows.filter(o => {
    if (!o.razorpay_order_id) return false;
    if (hasRealGatewayId(o.razorpay_payment_id)) return false;
    if (PLACEHOLDER_ID.test(String(o.razorpay_payment_id || ''))) return true;
    return !SETTLED.has(String(o.status || ''));
  });

  const token = await accessToken();
  const found = [], atRisk = [];
  let checked = 0, failed = 0;

  for (const o of candidates) {
    if (checked >= MAX_CHECKS) {
      console.warn(`[phonepe-sweep] hit the ${MAX_CHECKS}-check cap with ${candidates.length - checked} left; next run continues`);
      break;
    }
    checked++;
    let data = {};
    try {
      const res = await fetch(`${HOST()}/pg/checkout/v2/order/${encodeURIComponent(o.razorpay_order_id)}/status`,
        { headers: { Authorization: 'O-Bearer ' + token } });
      if (res.status === 404) continue;          // no PhonePe order — a genuine COD order
      data = await res.json().catch(() => ({}));
    } catch (e) {
      failed++;
      console.error(`[phonepe-sweep] ${o.razorpay_order_id}: ${e.message}`);
      continue;
    } finally {
      await new Promise(r => setTimeout(r, 120));  // stay inside PhonePe's rate limit
    }

    if (String(data.state || '') !== 'COMPLETED') continue;

    const paidPaise = Number(data.amount) || 0;
    const owedPaise = Number(o.amount_paise) || 0;
    const meta = paymentMeta(o);
    const isPartial = String(o.status || '').startsWith('pending_partial')
      || String(meta.mode || '') === 'partial_cod';

    // A payment short of the order total is a deposit, not a settlement. Marking
    // it 'paid' would tell every downstream check there is nothing left to
    // collect — the exact mistake this worker exists to prevent, inverted.
    if (!isPartial && owedPaise > 0 && paidPaise < owedPaise) {
      console.warn(`[phonepe-sweep] ${o.razorpay_order_id}: PhonePe has ₹${paidPaise / 100} against ₹${owedPaise / 100} — left alone for a human`);
      continue;
    }

    const detail = (Array.isArray(data.paymentDetails) ? data.paymentDetails : [])
      .find(d => String(d.state || '') === 'COMPLETED') || data.paymentDetails?.[0] || {};
    const txn = detail.transactionId || detail.paymentId || data.orderId || '';
    if (!txn) { console.warn(`[phonepe-sweep] ${o.razorpay_order_id}: COMPLETED but no transaction id`); continue; }

    const patch = {
      razorpay_payment_id: txn,
      shipment_payment_type: isPartial ? 'partial_cod' : 'prepaid',
    };
    // Only ever move a PRE-shipment status forward. These orders are usually
    // already shipped or delivered by the time the missing payment is found, and
    // writing 'paid' over 'delivered' would erase the fulfilment state — the
    // order would drop back into the unshipped list and could be sent twice.
    const PRE_SHIPMENT = ['cod_pending', 'cod_awaiting_confirmation', 'pending',
      'pending_phonepe', 'pending_partial_phonepe', 'confirmed'];
    if (PRE_SHIPMENT.includes(String(o.status || ''))) {
      patch.status = isPartial ? 'partial_cod_pending' : 'paid';
    }
    // Conditional on the id still being null so a webhook landing in the same
    // second wins instead of being overwritten.
    const { data: updated, error: uErr } = await supabase.from('orders')
      .update(patch).eq('id', o.id)
      .or('razorpay_payment_id.is.null,razorpay_payment_id.ilike.prepaid:%,razorpay_payment_id.ilike.manual:%,razorpay_payment_id.ilike.cod:%')
      .select('id');
    if (uErr) { failed++; console.error(`[phonepe-sweep] update ${o.razorpay_order_id}: ${uErr.message}`); continue; }
    if (!updated?.length) continue;              // webhook got there first

    const rec = {
      id: o.razorpay_order_id, name: o.customer_name, paidRs: paidPaise / 100,
      wasStatus: o.status, txn, utr: detail.rail?.utr || '', awb: o.tracking_id || '',
    };
    found.push(rec);
    if (shipmentLive(o)) atRisk.push(rec);
    console.log(`[phonepe-sweep] recovered ${o.razorpay_order_id} ₹${paidPaise / 100} (was ${o.status})${shipmentLive(o) ? ' — LIVE COD SHIPMENT' : ''}`);
  }

  if (found.length && process.env.STORE_OWNER_EMAIL) {
    try {
      await sendEmail({
        to: process.env.STORE_OWNER_EMAIL,
        subject: atRisk.length
          ? `🚨 ${atRisk.length} paid order${atRisk.length === 1 ? '' : 's'} shipping as COD — convert in NimbusPost now`
          : `✅ ${found.length} PhonePe payment${found.length === 1 ? '' : 's'} recovered`,
        html: digestHtml(found, atRisk),
      });
    } catch (e) { console.error('[phonepe-sweep] digest email failed:', e.message); }
  }

  const summary = { checked, candidates: candidates.length, recovered: found.length, live_cod_at_risk: atRisk.length, failed };
  console.log('[phonepe-sweep]', JSON.stringify(summary));
  return { statusCode: 200, headers: CORS, body: JSON.stringify(summary) };
};
