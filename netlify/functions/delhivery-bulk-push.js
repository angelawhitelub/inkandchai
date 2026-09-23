/**
 * Netlify Function: delhivery-bulk-push
 * POST /.netlify/functions/delhivery-bulk-push
 *
 * Body: { all_unshipped: true } or { order_ids: ["IC-...", ...] }
 *       { dry_run: true }   build every payload, contact Delhivery for nothing
 *       { limit: n }        cap how many go in one run
 *       { force: true }     also send orders still holding a shiprocket_order_id
 *       { suffix: "-r1" }   appended to the reference SENT TO DELHIVERY only.
 *                           Needed to re-book an order whose earlier shipment
 *                           was cancelled: Delhivery keeps the reference and
 *                           answers "Duplicate order id". The AWB comes back
 *                           in the same response, so nothing has to be matched
 *                           back by reference afterwards.
 *
 * force exists for the migration off Shiprocket. Cancelling a Shiprocket
 * booking leaves shiprocket_order_id on the row on purpose -- it is what stops
 * shiprocket-bulk-push re-booking a cancelled order -- but that same field then
 * reads as "already shipping" to every other courier, and the orders are in
 * fact free. force ignores THAT field only. It never ignores tracking_id: an
 * AWB means a courier is physically holding the parcel, and no flag should be
 * able to talk this endpoint into booking a second one.
 * Headers: X-Admin-Key / X-Admin-Token
 *
 * THIS BOOKS PARCELS. Delhivery's create.json assigns a waybill immediately --
 * there is no import-then-review step like iThink's order/sync.json. A mistake
 * here is a real shipment that has to be cancelled one at a time, so the
 * dry run is not decoration: run it, read the COD column, then push.
 *
 * The waybill comes back in the same response, so unlike Shiprocket and iThink
 * this path can record tracking_id itself. It writes ONLY columns that exist
 * -- tracking_id, courier_name, tracking_url, awb_assigned_at. The Shiprocket
 * write-back named one column that did not exist and silently discarded the
 * id alongside it, so 3,800 orders carried nothing.
 *
 * It deliberately does NOT set status to 'shipped'. That is what sends the
 * customer their tracking email, and it belongs to the normal flow, not to a
 * bulk booking run.
 */

const { createClient } = require('@supabase/supabase-js');
const { requireAdmin } = require('./utils/admin-auth');
const { classifyShipmentMoney } = require('./utils/shipment-money');
const { isReplacementOrder } = require('./utils/replacement-order');
const { buildShipment, createShipments } = require('./utils/delhivery');
const { buildTrackingUrl } = require('./utils/tracking-url');

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key',
  'Content-Type': 'application/json',
};

// pending_phonepe and pending_partial_phonepe are absent on purpose: PhonePe
// has not confirmed those payments, and a courier must never be handed an
// order nobody has paid for.
const UNSHIPPED_STATUSES = [
  'paid', 'confirmed', 'cod_pending', 'partial_cod_pending',
  'replacement_pending',
];

// Delhivery takes an array, so a batch is one request. Kept small so a bad run
// books twenty parcels rather than five hundred.
const BATCH_SIZE = 20;

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: 'Method Not Allowed' };

  const _adminBlock = requireAdmin(event, CORS); if (_adminBlock) return _adminBlock;

  const body = JSON.parse(event.body || '{}');
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  let orders = [];
  if (body.all_unshipped) {
    const { data, error } = await supabase
      .from('orders')
      .select('*')
      .or('source.is.null,source.neq.paperbound')
      .in('status', UNSHIPPED_STATUSES)
      .order('created_at', { ascending: false })
      .limit(500);
    if (error) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: error.message }) };
    orders = data || [];
  } else if (Array.isArray(body.order_ids) && body.order_ids.length) {
    const { data, error } = await supabase
      .from('orders').select('*').in('razorpay_order_id', body.order_ids);
    if (error) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: error.message }) };
    orders = data || [];
  } else {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Provide order_ids or all_unshipped:true' }) };
  }

  const pickup = process.env.DELHIVERY_PICKUP_NAME || '';
  const suffix = typeof body.suffix === 'string' ? body.suffix.trim() : '';
  if (suffix && !/^[A-Za-z0-9_-]{1,8}$/.test(suffix)) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'suffix must match [A-Za-z0-9_-]{1,8}' }) };
  }
  const ready = [], refused = [];
  const preview = { queued: 0, cod_orders: 0, cod_collectable: 0, prepaid_orders: 0, prepaid_declared: 0 };
  const rows = [];

  for (const order of orders) {
    const id = order.razorpay_order_id || order.id;
    // An AWB means some courier is already carrying this sale.
    if (order.tracking_id) { refused.push({ order_id: id, reason: `already has AWB ${order.tracking_id}` }); continue; }
    if (order.shiprocket_order_id && !body.force) { refused.push({ order_id: id, reason: `already in Shiprocket as ${order.shiprocket_order_id} — cancel it there, then re-run with force:true` }); continue; }
    let money, shipment;
    try {
      money = classifyShipmentMoney(order, isReplacementOrder(order));
      shipment = buildShipment(order, pickup || 'UNSET', suffix);
    } catch (e) {
      refused.push({ order_id: id, reason: String(e.message || e) });
      continue;
    }
    preview.queued++;
    if (money.isCOD) { preview.cod_orders++; preview.cod_collectable += money.collectableAmount; }
    else { preview.prepaid_orders++; preview.prepaid_declared += money.orderValueRs; }
    rows.push({ order_id: id, status: order.status, mode: money.shipmentPaymentType,
                collect: shipment.cod_amount, declared: shipment.total_amount,
                pin: shipment.pin, weight_g: shipment.weight });
    ready.push(order);
  }

  const cap = Number.isFinite(body.limit) ? Math.max(1, body.limit) : ready.length;
  const toSend = ready.slice(0, cap);

  if (body.dry_run) {
    return { statusCode: 200, headers: CORS, body: JSON.stringify({
      dry_run: true,
      books_immediately: true,
      force: body.force === true,
      pickup_location: pickup || '(DELHIVERY_PICKUP_NAME not set — every push will fail)',
      totals: preview, would_send: toSend.length, orders: rows, refused,
      suffix: suffix || null,
      sample_payload: toSend.length ? buildShipment(toSend[0], pickup || 'UNSET', suffix) : null,
    }, null, 2) };
  }

  if (!pickup) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({
      error: 'DELHIVERY_PICKUP_NAME is not set. It must match the warehouse name in the Delhivery panel exactly — it is case and space sensitive.' }) };
  }

  const summary = { pushed: 0, failed: 0, refused: refused.length, results: [], errors: [] };

  for (let i = 0; i < toSend.length; i += BATCH_SIZE) {
    const chunk = toSend.slice(i, i + BATCH_SIZE);
    let data;
    try {
      data = await createShipments(chunk, suffix);
    } catch (e) {
      summary.failed += chunk.length;
      summary.errors.push(String(e.message || e).slice(0, 300));
      continue;
    }

    const packages = Array.isArray(data.packages) ? data.packages : [];
    for (const order of chunk) {
      const id  = order.razorpay_order_id || order.id;
      const sentAs = suffix ? `${id}${suffix}` : String(id);
      const pkg = packages.find(p => String(p.refnum || '') === sentAs);
      const ok  = pkg && String(pkg.status || '').toLowerCase() === 'success' && pkg.waybill;

      if (!ok) {
        summary.failed++;
        const why = pkg ? (Array.isArray(pkg.remarks) ? pkg.remarks.join('; ') : String(pkg.remarks || 'rejected'))
                        : 'no package returned for this order';
        summary.errors.push(`${id}: ${why}`.slice(0, 300));
        summary.results.push({ order_id: id, ok: false, error: why });
        continue;
      }

      const awb = String(pkg.waybill);
      const update = {
        tracking_id:  awb,
        courier_name: 'Delhivery',
        tracking_url: buildTrackingUrl({ courier: 'Delhivery', awb, orderNumber: id }),
      };
      // awb_assigned_at exists on this table; nothing else Delhivery-specific
      // does, and naming a column that does not exist discards the whole write.
      update.awb_assigned_at = new Date().toISOString();

      const { error: upErr } = await supabase.from('orders').update(update).eq('id', order.id);
      if (upErr) {
        summary.errors.push(`${id}: booked as ${awb} but DB write failed: ${upErr.message}`.slice(0, 300));
        summary.results.push({ order_id: id, ok: true, awb, saved: false });
      } else {
        summary.results.push({ order_id: id, ok: true, awb, saved: true, cod: pkg.cod_amount });
      }
      summary.pushed++;
    }
  }

  return { statusCode: 200, headers: CORS, body: JSON.stringify({ summary, refused }, null, 2) };
};
