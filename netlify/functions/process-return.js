/**
 * Netlify Function: process-return
 * POST /.netlify/functions/process-return
 *
 * Admin endpoint — create a NimbusPost reverse pickup for a return request.
 *
 * Pickup:      customer's delivery address
 * Destination: 2969, Kucha Mai Dass, Sitaram Bazar, Delhi - 110006
 *
 * Required env vars:
 *   NIMBUSPOST_EMAIL
 *   NIMBUSPOST_PASSWORD
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_KEY
 *   ADMIN_SECRET
 *
 * Body: { return_request_id: "uuid" }
 *       OR { order_display_id: "IC-..." } to look up by order ID
 */

const { createClient } = require('@supabase/supabase-js');
const { sendWhatsApp } = require('./utils/whatsapp');
const { sendEmail } = require('./utils/email');
const { requireAdmin } = require('./utils/admin-auth');

const NP_BASE = 'https://api.nimbuspost.com/v1';
const STORE_NAME = 'Ink and Chai';

// ── Our warehouse / return destination ────────────────────────────────────
const RETURN_ADDRESS = {
  name:    'Ink and Chai',
  address: '2969, Kucha Mai Dass, Sitaram Bazar',
  city:    'Delhi',
  state:   'Delhi',
  pincode: '110006',
  phone:   '9999999999', // fallback — NimbusPost requires a phone
};

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key',
  'Content-Type': 'application/json',
};

// ── Address parser ─────────────────────────────────────────────────────────
function parseAddress(addr) {
  if (!addr) return { addr1: '', city: '', state: '', pincode: '' };
  const parts = addr.split(',').map(p => p.trim()).filter(Boolean);

  let pincode = '';
  for (let i = parts.length - 1; i >= 0; i--) {
    const m = parts[i].match(/\b(\d{6})\b/);
    if (m) {
      pincode = m[1];
      const cleaned = parts[i].replace(m[0], '').replace(/[-–\s]+$/, '').trim();
      if (cleaned) parts[i] = cleaned; else parts.splice(i, 1);
      break;
    }
  }

  const n = parts.length;
  const state = n >= 1 ? parts[n - 1] : '';
  const city  = n >= 2 ? parts[n - 2] : state;
  const addr1 = n >= 3 ? parts.slice(0, n - 2).join(', ') : (parts[0] || '');
  return { addr1: addr1 || city, city, state, pincode };
}

// ── NimbusPost helpers ─────────────────────────────────────────────────────
async function npFetch(path, { method = 'GET', token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${NP_BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data;
  try { data = await res.json(); } catch { data = {}; }
  return { ok: res.ok, status: res.status, data };
}

async function npAuthenticate() {
  const email = process.env.NIMBUSPOST_EMAIL;
  const password = process.env.NIMBUSPOST_PASSWORD;
  if (!email || !password) throw new Error('NIMBUSPOST_EMAIL / NIMBUSPOST_PASSWORD env vars not set');

  const { ok, data } = await npFetch('/users/login', {
    method: 'POST',
    body: { email, password },
  });
  const token = data.data || data.token;
  if (!ok || !token) throw new Error(`NimbusPost auth failed: ${JSON.stringify(data)}`);
  return token;
}

// ── Customer notifications ───────────────────────────────────────────────────
function firstName(name) {
  return (name || 'there').trim().split(/\s+/)[0] || 'there';
}

function approvedEmailHtml(ret) {
  const oid = ret.order_display_id || ret.order_id || '';
  return `<div style="font-family:Georgia,serif;color:#3a2f25;max-width:520px;margin:0 auto;">
    <h2 style="color:#8a6a1f;">Your return has been approved ✓</h2>
    <p>Hi ${firstName(ret.customer_name)},</p>
    <p>Good news — your return request for order <strong>${oid}</strong> has been approved.</p>
    <p>We're arranging a courier pickup from your address. You'll receive another message with the
       courier name and tracking ID once the pickup is scheduled. Please keep the books packed and ready.</p>
    <p style="color:#6f6255;font-size:13px;">Thank you,<br>${STORE_NAME}</p>
  </div>`;
}

function pickupEmailHtml(ret, awb, courier) {
  const oid = ret.order_display_id || ret.order_id || '';
  const courierLine = courier ? ` by <strong>${courier}</strong>` : '';
  return `<div style="font-family:Georgia,serif;color:#3a2f25;max-width:520px;margin:0 auto;">
    <h2 style="color:#8a6a1f;">Return pickup scheduled 🚚</h2>
    <p>Hi ${firstName(ret.customer_name)},</p>
    <p>Your return for order <strong>${oid}</strong> has been scheduled for pickup${courierLine}.</p>
    ${awb ? `<p><strong>Tracking ID:</strong> ${awb}</p>` : ''}
    <p>Please <strong>keep the books packed</strong> and hand them over to the courier partner when they
       arrive to collect the parcel.</p>
    <p style="color:#6f6255;font-size:13px;">Thank you,<br>${STORE_NAME}</p>
  </div>`;
}

// Best-effort: email + WhatsApp. Never throws (notifications must not block the flow).
async function notifyApproved(ret) {
  try {
    if (ret.customer_email) {
      await sendEmail({
        to: ret.customer_email,
        subject: `Your return has been approved (${ret.order_display_id || ret.order_id})`,
        html: approvedEmailHtml(ret),
      });
    }
    if (ret.customer_phone) {
      await sendWhatsApp({
        to: ret.customer_phone,
        template: 'return_approved',
        params: [firstName(ret.customer_name), String(ret.order_display_id || ret.order_id || '')],
      });
    }
  } catch (e) { console.error('notifyApproved failed:', e.message); }
}

async function notifyPickupScheduled(ret, awb, courier) {
  const oid = ret.order_display_id || ret.order_id || '';
  try {
    if (ret.customer_email) {
      await sendEmail({
        to: ret.customer_email,
        subject: `Return pickup scheduled (${oid})`,
        html: pickupEmailHtml(ret, awb, courier),
      });
    }
    if (ret.customer_phone) {
      await sendWhatsApp({
        to: ret.customer_phone,
        template: 'return_pickup_scheduled',
        params: [
          firstName(ret.customer_name),
          String(oid),
          courier || 'our courier partner',
          String(awb || ''),
        ],
      });
    }
  } catch (e) { console.error('notifyPickupScheduled failed:', e.message); }
}

// ── Handler ────────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'POST only' }) };

  const _adminBlock = requireAdmin(event, CORS); if (_adminBlock) return _adminBlock;
  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { return_request_id, action } = body;
  if (!return_request_id) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'return_request_id required' }) };

  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

    // Fetch return request
    const { data: ret, error: retErr } = await supabase
      .from('return_requests')
      .select('*')
      .eq('id', return_request_id)
      .maybeSingle();

    if (retErr) throw retErr;
    if (!ret) return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: 'Return request not found' }) };

    // Handle status updates (approve/reject without creating pickup)
    if (action === 'reject') {
      await supabase.from('return_requests').update({ status: 'rejected' }).eq('id', return_request_id);
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ success: true, status: 'rejected' }) };
    }

    if (action === 'approve') {
      await supabase.from('return_requests').update({ status: 'approved' }).eq('id', return_request_id);
      await notifyApproved(ret);
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ success: true, status: 'approved', notified: true }) };
    }

    // Manually attach a tracking ID + courier (when you ship the return yourself,
    // outside NimbusPost) and notify the customer to hand over the books.
    if (action === 'add_tracking') {
      const awb = String(body.awb || body.tracking_id || '').trim();
      const courierName = String(body.courier_name || '').trim();
      if (!awb) {
        return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Tracking ID (awb) required' }) };
      }
      await supabase.from('return_requests').update({
        status:       'pickup_scheduled',
        awb,
        courier_name: courierName || null,
        processed_at: new Date().toISOString(),
      }).eq('id', return_request_id);
      await notifyPickupScheduled(ret, awb, courierName);
      return { statusCode: 200, headers: CORS, body: JSON.stringify({
        success: true, status: 'pickup_scheduled', awb, courier_name: courierName, notified: true,
      }) };
    }

    // Reverse pickups MUST go through the Partners /v1/shipments API. The seller-
    // panel Orders API (ship.nimbuspost.com/api/orders/create) silently ignores
    // every reverse-marker field and always creates a FORWARD order (confirmed
    // in the NP panel — the pushed order showed a "Ship" button, not reverse).
    // /v1/shipments with payment_type='reverse' is the only endpoint that
    // produces a true reverse order. We first query serviceability to pick a
    // reverse-capable courier for the customer's pincode, then create the
    // shipment with that courier so it doesn't auto-cancel.
    if (ret.status !== 'approved') {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Approve this return before pushing it to NimbusPost.' }) };
    }
    if (ret.awb || ret.status === 'pushed_to_nimbus' || ret.status === 'pickup_scheduled') {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: ret.awb ? `Already pushed. AWB: ${ret.awb}` : 'This return has already been pushed to NimbusPost.' }) };
    }

    // Parse customer address (pickup location)
    const { addr1, city, state, pincode } = parseAddress(ret.customer_address || '');
    if (!pincode) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: `Cannot parse pincode from customer address: "${ret.customer_address}"` }) };
    }

    // Reverse order number shown in the NimbusPost panel.
    const orderNumber = `R-RET-${String(ret.order_display_id || ret.order_id).replace(/^IC-/, '')}`.slice(0, 20);

    // ── Reverse SHIPMENT with auto-pickup (assigns an AWB now) ────────────────
    const token = await npAuthenticate();
    const cartItems = Array.isArray(ret.items) ? ret.items : [];
    const products  = cartItems.length
      ? cartItems.map(i => ({ name: i.title || 'Book', sku: i.sku || '', qty: i.qty || 1, price: i.price || 0 }))
      : [{ name: 'Book', sku: '', qty: 1, price: ret.amount_paise ? Math.round(ret.amount_paise / 100) : 0 }];
    const phone = (ret.customer_phone || '9999999999').replace(/\D/g, '').slice(-10);

    // ── Serviceability lookup: which courier services reverse from this pincode? ─
    // NP's default auto-assignment tries Delhivery/Xpressbees/Amazon — all of
    // which skip reverse pickup for most Tier-2/3 pincodes. So we explicitly
    // query serviceability first and pass a reverse-capable courier_id.
    const orderAmountRs = ret.amount_paise ? Math.round(ret.amount_paise / 100) : 0;
    const svcBody = {
      origin: pincode,                       // customer's pincode (pickup)
      destination: RETURN_ADDRESS.pincode,   // our warehouse
      payment_type: 'prepaid',
      order_type: 'reverse',
      // NP expects grams as an integer here — sending 0.4 kg triggers
      // "The Package Weight field must contain an integer".
      weight: 400,
      order_amount: orderAmountRs,
    };
    const { ok: svcOk, data: svcData } = await npFetch('/courier/serviceability', {
      method: 'POST', token, body: svcBody,
    });
    // NP shapes: sometimes {data: [{courier_id, courier_name, is_serviceable, reverse: true, ...}]}
    // sometimes {data: [{id, name, reverse_serviceable: true, ...}]} — accept both.
    const svcList = Array.isArray(svcData?.data) ? svcData.data
                  : Array.isArray(svcData) ? svcData : [];
    const reverseCouriers = svcList.filter(c => {
      const rev = c.reverse === true || c.reverse_serviceable === true
               || c.reverse === 1 || c.reverse_serviceable === 1
               || String(c.type || '').toLowerCase() === 'reverse';
      const svc = c.is_serviceable !== false; // default true unless explicitly false
      return rev && svc;
    });
    // Build an ordered candidate list: reverse-flagged couriers first, then any
    // remaining serviceable couriers (deduped). We try them one-by-one at create
    // time — a courier can pass serviceability yet still reject the actual pickup
    // ("Delhivery(218): Pickup pincode not available"), so we fall through to the
    // next candidate instead of failing on the first bounce.
    const seenCourierIds = new Set();
    const candidates = [];
    for (const c of [...reverseCouriers, ...svcList]) {
      const id = c?.courier_id ?? c?.id ?? null;
      if (id == null || seenCourierIds.has(String(id))) continue;
      seenCourierIds.add(String(id));
      candidates.push({ id, name: c.courier_name || c.name || `courier ${id}` });
    }

    if (!svcOk || !candidates.length) {
      throw new Error(
        `No courier services reverse pickup from pincode ${pincode}. `
        + `Please create this return manually in the NimbusPost seller panel. `
        + `(NP response: ${JSON.stringify(svcData).slice(0, 300)})`
      );
    }
    console.log(`[process-return] pincode=${pincode} → ${candidates.length} candidate courier(s): ${candidates.map(c => `${c.name}(${c.id})`).join(', ')}`);

    const basePayload = {
      order_number: orderNumber,
      payment_type: 'reverse',
      order_amount: orderAmountRs,
      package_weight: 300, package_length: 20, package_height: 3, package_breadth: 15,
      request_auto_pickup: 'yes',
      consignee: { name: ret.customer_name || 'Customer', address: addr1, address_2: '', city, state, pincode, phone },
      pickup: {
        warehouse_name: process.env.NIMBUSPOST_WAREHOUSE_NAME || 'Office',
        name: RETURN_ADDRESS.name, address: RETURN_ADDRESS.address, address_2: '',
        city: RETURN_ADDRESS.city, state: RETURN_ADDRESS.state, pincode: RETURN_ADDRESS.pincode,
        phone: process.env.RETURN_PHONE || process.env.BUSINESS_PHONE || RETURN_ADDRESS.phone,
      },
      order_items: products,
      tags: `return, ${String(ret.reason || 'customer return').slice(0, 150)}`,
    };

    // A "pickup not available / not serviceable" error is courier-specific — retry
    // the next candidate. Any other error (bad address, weight, auth) is fatal and
    // won't be fixed by swapping couriers, so we surface it immediately.
    const isPickupUnavailable = (msg) =>
      /pickup\s*pincode.*(not\s*available|not\s*serviceable)|not\s*available|not\s*serviceable|no\s*courier|reverse.*not/i.test(String(msg || ''));

    let npData = null, courierId = null, courierName = null;
    const attemptErrors = [];
    for (const cand of candidates) {
      const payload = { ...basePayload, courier_id: cand.id };
      const { ok, data } = await npFetch('/shipments', { method: 'POST', token, body: payload });
      const failed = !ok || data.status === false;
      if (!failed) { npData = data; courierId = cand.id; courierName = cand.name; break; }

      const errMsg = data?.message || JSON.stringify(data);
      attemptErrors.push(`${cand.name}(${cand.id}): ${String(errMsg).slice(0, 120)}`);
      console.warn(`[process-return] courier ${cand.name}(${cand.id}) rejected reverse pickup: ${String(errMsg).slice(0, 200)}`);

      if (!isPickupUnavailable(errMsg)) {
        // Non-courier error (address/weight/auth) — swapping couriers won't help.
        throw new Error(`NimbusPost reverse pickup failed: ${JSON.stringify(data)}`);
      }
      // else: try the next candidate
    }

    if (!npData) {
      throw new Error(
        `No courier accepted the reverse pickup from pincode ${pincode} after trying ${candidates.length} option(s). `
        + `Please create this return manually in the NimbusPost seller panel. `
        + `Attempts — ${attemptErrors.join(' | ')}`
      );
    }

    const shipment = npData.data && typeof npData.data === 'object' ? npData.data : npData;
    const awb = shipment.awb_number || shipment.awb || shipment.tracking_number || null;
    courierName = shipment.courier_name || courierName || 'NimbusPost';

    await supabase.from('return_requests').update({
      status:       awb ? 'pickup_scheduled' : 'pushed_to_nimbus',
      awb,
      courier_name: courierName,
      processed_at: new Date().toISOString(),
    }).eq('id', return_request_id);

    if (awb) await notifyPickupScheduled(ret, awb, courierName);

    return { statusCode: 200, headers: CORS, body: JSON.stringify({
      success: true,
      awb,
      courier_name: courierName,
      courier_id: courierId,
      status: awb ? 'pickup_scheduled' : 'pushed_to_nimbus',
      message: awb
        ? `Reverse pickup scheduled with ${courierName} (services pincode ${pincode}).`
        : `Reverse shipment created with ${courierName}. AWB will be assigned shortly.`,
      notified: !!awb,
      pickup_from:  `${ret.customer_name} — ${ret.customer_address}`,
      pickup_to:    '2969, Kucha Mai Dass, Sitaram Bazar, Delhi - 110006',
    }) };

  } catch (err) {
    console.error('process-return error:', err);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
