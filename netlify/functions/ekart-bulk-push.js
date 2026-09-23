/**
 * Netlify Function: ekart-bulk-push
 * POST /.netlify/functions/ekart-bulk-push
 *
 * Body: { dry_run: true, order_ids: ["IC-..."] | all_unserviceable: true,
 *         limit: 25, suffix: "", check_serviceability: true }
 * Headers: X-Admin-Key / X-Admin-Token
 *
 * The second lane. Delhivery refuses some pincodes outright and those orders
 * have nowhere to go; this books them with Ekart instead.
 *
 * Ekart's create is a PUT that BOOKS and returns the waybill in the same call
 * -- there is no import-then-review step -- so every guard has to hold BEFORE
 * the request goes out, not after.
 *
 * GUARDS
 *   - tracking_id: never bypassable. An AWB means some courier is already
 *     carrying this sale, and a second booking is a second parcel.
 *   - one order per request upstream, so a partial batch is a real outcome:
 *     each result is reported and saved on its own.
 *
 * Does NOT set status to 'shipped'. Shipping notifications key off that, and
 * a waybill is not a pickup; the status sync moves it when a scan says so.
 */

const { createClient } = require('@supabase/supabase-js');
const { requireAdmin } = require('./utils/admin-auth');
const ek = require('./utils/ekart');

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key, X-Admin-Token',
  'Content-Type': 'application/json',
};
const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body, null, 2) });

const UNSHIPPED = ['paid', 'confirmed', 'cod_pending', 'partial_cod_pending', 'replacement_pending'];

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  const block = requireAdmin(event, CORS);
  if (block) return block;
  if (event.httpMethod !== 'POST') return json(405, { error: 'POST only' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: 'Invalid JSON' }); }

  const dryRun = body.dry_run !== false;
  const suffix = String(body.suffix || '');
  const limit = Math.max(1, Math.min(50, Number(body.limit) || 25));
  const checkService = body.check_serviceability !== false;

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  const ids = Array.isArray(body.order_ids) ? body.order_ids.map((s) => String(s).trim()) : [];
  if (!ids.length && !body.all_unserviceable) {
    return json(400, { error: 'pass order_ids: [...] or all_unserviceable: true' });
  }

  let q = supabase.from('orders').select('*').in('status', UNSHIPPED).limit(500);
  if (ids.length) q = q.in('razorpay_order_id', ids);
  const { data: rows, error } = await q;
  if (error) return json(500, { error: `orders query failed: ${error.message}` });

  const queued = [];
  const refused = [];
  for (const o of rows || []) {
    const id = o.razorpay_order_id || o.id;
    if (o.tracking_id) { refused.push({ order_id: id, reason: `already has AWB ${o.tracking_id} (${o.courier_name || '?'})` }); continue; }
    let payload;
    try { payload = ek.buildShipment(o, suffix); }
    catch (e) { refused.push({ order_id: id, reason: e.message }); continue; }
    queued.push({ order: o, id, payload });
  }
  queued.sort((a, b) => String(a.order.created_at).localeCompare(String(b.order.created_at)));
  const plan = queued.slice(0, limit);

  // Serviceability is read-only and answers the one question that put these
  // orders here: does anybody actually cover this pincode?
  const service = {};
  if (checkService) {
    for (const p of plan) {
      try {
        const out = await ek.serviceability({
          pickupPincode: ek.pickupLocation().pin || process.env.XPRESSBEES_PICKUP_PINCODE || '110006',
          dropPincode: p.payload.drop_location.pin,
          paymentType: p.payload.payment_mode,
          codAmount: String(p.payload.cod_amount),
          invoiceAmount: String(p.payload.total_amount),
        });
        const list = Array.isArray(out.data) ? out.data : (out.data?.data || []);
        service[p.id] = { http: out.httpStatus, partners: Array.isArray(list) ? list.length : 0,
                          detail: Array.isArray(list) ? list.slice(0, 3) : (out.data?.message || out.raw) };
      } catch (e) {
        service[p.id] = { error: e.message };
      }
    }
  }

  const summary = {
    dry_run: dryRun,
    queued: plan.length,
    refused: refused.length,
    cod: plan.filter((p) => p.payload.payment_mode === 'COD').length,
    cod_value: plan.filter((p) => p.payload.payment_mode === 'COD')
                   .reduce((s, p) => s + Number(p.payload.cod_amount || 0), 0),
  };

  if (dryRun) {
    return json(200, {
      ...summary,
      serviceability: service,
      plan: plan.map((p) => ({
        order_id: p.id, sent_as: p.payload.order_number,
        payment: p.payload.payment_mode, cod: p.payload.cod_amount, total: p.payload.total_amount,
        pin: p.payload.drop_location.pin, city: p.payload.drop_location.city,
        weight: p.payload.weight,
      })),
      refused,
      sample_payload: plan.length ? plan[0].payload : null,
    });
  }

  const results = [];
  let saved = 0;
  for (const p of plan) {
    let out;
    try { out = await ek.createShipment(p.payload); }
    catch (e) { results.push({ order_id: p.id, ok: false, error: e.message }); continue; }

    const d = out.data || {};
    const awb = d.tracking_id || (d.barcodes && d.barcodes.wbn) || null;
    const ok = out.httpStatus === 200 && d.status !== false && awb;
    if (!ok) {
      results.push({ order_id: p.id, ok: false, http: out.httpStatus,
                     error: d.remark || d.message || d.error || out.raw });
      continue;
    }

    const update = {
      tracking_id: String(awb),
      courier_name: 'Ekart',
      // Set explicitly: buildTrackingUrl maps "ekart" to the legacy NimbusPost
      // page, which is right for the old NimbusPost-booked Ekart shipments and
      // wrong for one we booked ourselves.
      tracking_url: ek.trackingUrl(awb),
      awb_assigned_at: new Date().toISOString(),
    };
    const { error: upErr } = await supabase.from('orders').update(update).eq('id', p.order.id);
    if (upErr) {
      results.push({ order_id: p.id, ok: true, awb: String(awb), saved: false, save_error: upErr.message });
      continue;
    }
    saved += 1;
    results.push({ order_id: p.id, ok: true, awb: String(awb), vendor: d.vendor || null, saved: true });
  }

  return json(200, {
    ...summary,
    pushed: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    saved_to_db: saved,
    results,
    refused,
  });
};
