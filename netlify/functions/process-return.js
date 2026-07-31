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
  const result = { email: null, whatsapp: null };
  // Email and WhatsApp are attempted independently — a failure in one must not
  // suppress the other, and the outcome of each is returned so the caller can
  // surface it (instead of the previous silent try/catch that hid Meta errors).
  if (ret.customer_email) {
    try {
      await sendEmail({
        to: ret.customer_email,
        subject: `Return pickup scheduled (${oid})`,
        html: pickupEmailHtml(ret, awb, courier),
      });
      result.email = { ok: true, to: ret.customer_email };
    } catch (e) {
      console.error('notifyPickupScheduled email failed:', e.message);
      result.email = { ok: false, error: e.message };
    }
  } else {
    result.email = { ok: false, skipped: 'no email on record' };
  }

  if (ret.customer_phone) {
    const wa = await sendWhatsApp({
      to: ret.customer_phone,
      template: 'return_pickup_scheduled',
      params: [
        firstName(ret.customer_name),
        String(oid),
        courier || 'our courier partner',
        String(awb || ''),
      ],
    });
    result.whatsapp = wa?.ok
      ? { ok: true, to: ret.customer_phone }
      : { ok: false, to: ret.customer_phone, error: wa?.data?.error?.message || wa?.error || `status ${wa?.status || '?'}` };
  } else {
    result.whatsapp = { ok: false, skipped: 'no phone on record' };
  }

  console.log(`[process-return] notify ${oid}: email=${JSON.stringify(result.email)} whatsapp=${JSON.stringify(result.whatsapp)}`);
  return result;
}

// ── Handler ────────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'POST only' }) };

  const _adminBlock = requireAdmin(event, CORS); if (_adminBlock) return _adminBlock;
  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  let { return_request_id } = body;
  const { order_display_id, action } = body;
  if (!return_request_id && !order_display_id) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'return_request_id or order_display_id required' }) };
  }

  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

    let ret;
    if (return_request_id) {
      // Customer-initiated flow: fetch the existing return request by id.
      const { data, error: retErr } = await supabase
        .from('return_requests').select('*').eq('id', return_request_id).maybeSingle();
      if (retErr) throw retErr;
      ret = data;
    } else {
      // ── Admin-initiated return for a specific order ─────────────────────────
      // No customer request needed. Look the order up, reuse an existing return
      // request if one exists, otherwise synthesize one (pre-approved) from the
      // order so the reverse-pickup logic below runs unchanged. displayId is
      // sanitized to [A-Za-z0-9-] before it goes into the PostgREST .or() filter.
      const displayId = String(order_display_id).trim().replace(/[^A-Za-z0-9-]/g, '').slice(0, 64);
      if (!displayId) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid order id' }) };
      const { data: order, error: ordErr } = await supabase
        .from('orders').select('*')
        .or(`razorpay_order_id.eq.${displayId},id.eq.${displayId}`)
        .maybeSingle();
      if (ordErr) throw ordErr;
      if (!order) return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: `Order not found: ${displayId}` }) };

      const { data: existing } = await supabase
        .from('return_requests').select('*').eq('order_id', order.id).maybeSingle();
      if (existing) {
        ret = existing;
      } else {
        const { data: created, error: cErr } = await supabase.from('return_requests').insert({
          order_id:         order.id,
          order_display_id: order.razorpay_order_id || order.id,
          customer_name:    order.customer_name    || '',
          customer_email:   order.customer_email   || '',
          customer_phone:   order.customer_phone   || '',
          customer_address: order.customer_address || '',
          items:            order.cart_items       || [],
          amount_paise:     order.amount_paise      || 0,
          reason:           'Admin-initiated return',
          status:           'approved',   // admin-initiated = pre-approved
        }).select('*').single();
        if (cErr) throw cErr;
        ret = created;
      }
      return_request_id = ret.id;
      // Pre-approve so the reverse-pickup guard passes (unless already pushed).
      const alreadyPushed = ret.awb || ret.status === 'pushed_to_nimbus' || ret.status === 'pickup_scheduled';
      if (!alreadyPushed && ret.status !== 'approved') {
        await supabase.from('return_requests').update({ status: 'approved' }).eq('id', ret.id);
        ret.status = 'approved';
      }
    }

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

    // Owner marks a MANUAL refund (COD-UPI payout, or a PhonePe/other refund done
    // by hand) as paid — closes out the return. Only valid for a manual state.
    if (action === 'mark_refunded') {
      const manualStates = ['manual_payout_pending', 'manual_refund_pending'];
      if (!manualStates.includes(ret.refund_status)) {
        return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: `Refund is "${ret.refund_status || 'not set'}", not a manual payout — nothing to mark.` }) };
      }
      await supabase.from('return_requests').update({
        refund_status: 'refunded',
        refunded_at:   new Date().toISOString(),
      }).eq('id', return_request_id);
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ success: true, refund_status: 'refunded' }) };
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

    // ── Create the reverse order (lands as "New", no AWB) ─────────────────────
    // Why the "pickup pincode not available" errors kept happening:
    //   /v1/shipments ALWAYS validates courier serviceability at create time,
    //   even with request_auto_pickup:'no'. With NO courier_id, NimbusPost
    //   auto-picks its default *forward* couriers (Delhivery 218/370, Amazon
    //   387, Xpressbees 14) — none of which do reverse pickup — so every one
    //   reports "Pickup pincode not available" (the customer's pincode).
    //
    // Fix: query serviceability with payment_type:'reverse' (origin = customer,
    //   destination = warehouse) to get a REVERSE-CAPABLE courier (the "Delhivery
    //   Reverse QC" style service the panel's Ship modal offers), and pass its
    //   courier_id. Keep request_auto_pickup:'no' so it lands as "New" without
    //   scheduling a pickup (which is what auto-cancelled orders before). Single
    //   create — no retry loop (the loop only spawned duplicates because
    //   auto-pickup made NP create-then-cancel each attempt).
    const orderAmountRs = ret.amount_paise ? Math.round(ret.amount_paise / 100) : 0;

    const svcBody = {
      origin: pincode,                       // customer's pincode (reverse pickup point)
      destination: RETURN_ADDRESS.pincode,   // our warehouse (reverse delivery point)
      payment_type: 'reverse',
      order_amount: orderAmountRs,
      weight: 400,                           // grams, integer
    };
    const { ok: svcOk, data: svcData } = await npFetch('/courier/serviceability', {
      method: 'POST', token, body: svcBody,
    });
    const svcList = Array.isArray(svcData?.data) ? svcData.data
                  : Array.isArray(svcData) ? svcData : [];
    // Prefer couriers explicitly flagged reverse-capable; otherwise trust the
    // list (the serviceability query already asked for payment_type:reverse).
    const reverseCouriers = svcList.filter(c => {
      const rev = c.reverse === true || c.reverse_serviceable === true
               || c.reverse === 1 || c.reverse_serviceable === 1
               || /reverse/i.test(String(c.courier_name || c.name || c.type || ''));
      return rev && c.is_serviceable !== false;
    });
    const chosen = reverseCouriers[0] || svcList[0] || null;
    const reverseCourierId = chosen ? (chosen.courier_id ?? chosen.id ?? null) : null;

    if (!svcOk || !reverseCourierId) {
      throw new Error(
        `No reverse-capable courier services pickup from pincode ${pincode}. `
        + `NimbusPost only offers forward couriers here, which decline reverse pickup. `
        + `Create this return manually in the NimbusPost panel (clone the original order as reverse). `
        + `(NP serviceability: ${JSON.stringify(svcData).slice(0, 300)})`
      );
    }
    console.log(`[process-return] pincode=${pincode} → reverse courier ${chosen.courier_name || chosen.name} (id=${reverseCourierId})`);

    const payload = {
      order_number: orderNumber,
      payment_type: 'reverse',
      order_amount: orderAmountRs,
      package_weight: 300, package_length: 20, package_height: 3, package_breadth: 15,
      request_auto_pickup: 'no',      // ← land as "New"; ship (assign AWB) later
      courier_id: reverseCourierId,   // ← reverse-capable courier (not a forward default)
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

    const { ok, data: npData } = await npFetch('/shipments', { method: 'POST', token, body: payload });
    if (!ok || npData.status === false) {
      throw new Error(`NimbusPost reverse order create failed: ${JSON.stringify(npData)}`);
    }

    const shipment = npData.data && typeof npData.data === 'object' ? npData.data : npData;
    const awb = shipment.awb_number || shipment.awb || shipment.tracking_number || null;
    const courierId = shipment.courier_id || reverseCourierId || null;
    let courierName = shipment.courier_name || chosen.courier_name || chosen.name || 'NimbusPost';

    await supabase.from('return_requests').update({
      status:       awb ? 'pickup_scheduled' : 'pushed_to_nimbus',
      awb,
      courier_name: courierName,
      processed_at: new Date().toISOString(),
    }).eq('id', return_request_id);

    const notify = awb ? await notifyPickupScheduled(ret, awb, courierName) : null;

    return { statusCode: 200, headers: CORS, body: JSON.stringify({
      success: true,
      awb,
      courier_name: courierName,
      courier_id: courierId,
      status: awb ? 'pickup_scheduled' : 'pushed_to_nimbus',
      message: awb
        ? `Reverse pickup scheduled with ${courierName} (services pincode ${pincode}).`
        : `Reverse order created in NimbusPost as "New" (order ${orderNumber}). Open it in the panel and hit Ship to assign the reverse courier & AWB.`,
      notified: !!(notify && (notify.email?.ok || notify.whatsapp?.ok)),
      notify_detail: notify,
      pickup_from:  `${ret.customer_name} — ${ret.customer_address}`,
      pickup_to:    '2969, Kucha Mai Dass, Sitaram Bazar, Delhi - 110006',
    }) };

  } catch (err) {
    console.error('process-return error:', err);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
