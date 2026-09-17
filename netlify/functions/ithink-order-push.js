/**
 * Netlify Function: ithink-order-push
 * POST /.netlify/functions/ithink-order-push
 *
 * Push website orders into the iThink Logistics panel WITHOUT assigning a
 * courier or generating an AWB, so they can be reviewed and booked by hand.
 *
 * This is the iThink twin of nimbuspost-order-push.js, and it is deliberately
 * NOT called ithink-ship: iThink has two different endpoints and only one of
 * them is safe to run in bulk.
 *
 *   api_v3/order/add.json   books immediately and returns a waybill
 *   api_v3/order/sync.json  imports the order and stops   <-- this file
 *
 * Body: { order_ids: ["IC-...", ...] }   or   { all_unshipped: true }
 *       { dry_run: true }   builds and returns the payloads without sending
 *       { force: true }     re-push orders already stamped ithink_pushed_at
 * Header: X-Admin-Key / X-Admin-Token
 *
 * Env: ITHINK_ACCESS_TOKEN, ITHINK_SECRET_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY
 */

const { createClient } = require('@supabase/supabase-js');
const { sanitizeForCourier } = require('./utils/nimbuspost-import');
const { normalizeIndianPhone, parseAddress, enrichAddress } = require('./utils/np-normalize');
const { requireAdmin } = require('./utils/admin-auth');
const { isReplacementOrder } = require('./utils/replacement-order');
const { classifyShipmentMoney, parseCartItems } = require('./utils/shipment-money');

const ITHINK_SYNC_URL    = 'https://my.ithinklogistics.com/api_v3/order/sync.json';
const ITHINK_DETAILS_URL = 'https://my.ithinklogistics.com/api_v3/order/get_details.json';

// 4901 is the Indian HSN code for printed books.
//
// This cannot be sent as an empty string. iThink's backend treats '' as falsy,
// coerces it to null, and then dies casting null to string:
// "Cannot assign null to property ...PlatformItlProductsDAO::$hsnCode of type
// string". A real code is both required and correct.
const HSN_PRINTED_BOOKS = process.env.ITHINK_HSN_CODE || '4901';

// iThink accepts at most 25 shipments per sync call.
const BATCH_SIZE = 25;

// Flat box, matching nimbuspost-ship.js. iThink reweighs at the hub regardless.
const BOX = { shipment_length: '15', shipment_width: '10', shipment_height: '5', weight: '0.4' };

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key, X-Admin-Token',
  'Content-Type': 'application/json',
};
const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body, null, 2) });

const UNSHIPPED_STATUSES = [
  'paid', 'confirmed', 'cod_pending', 'partial_cod_pending',
  'replacement_pending',
];

/**
 * iThink wants "dd-mm-yyyy HH:MM:SS" on sync.json -- NOT the ISO shape, and
 * NOT the bare dd-mm-yyyy the bulk CSV uses. A malformed date is accepted
 * silently and lands the order in the panel dated today, which quietly breaks
 * any age-based reconciliation later.
 */
function ithinkDateTime(iso) {
  const d = iso ? new Date(iso) : new Date();
  if (Number.isNaN(d.getTime())) return ithinkDateTime(null);
  const p2 = (v) => String(v).padStart(2, '0');
  return `${p2(d.getDate())}-${p2(d.getMonth() + 1)}-${d.getFullYear()} `
       + `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
}

/**
 * One order -> one shipment object. The products array lives INSIDE the
 * shipment, so a five-book order is one shipment with five products: the
 * duplicate-order-number problem that the bulk CSV could not resolve does not
 * exist on this endpoint.
 */
async function buildShipment(order) {
  const orderId = order.razorpay_order_id || order.id;

  // np-normalize returns { address, city, state, pincode } -- NOT addr1/addr2
  // -- and enrichAddress is ASYNC (it fills city/state from the pincode). Both
  // were got wrong here first time round, which silently produced shipments
  // with an empty address line.
  const a = await enrichAddress(parseAddress(order.customer_address || ''));
  if (!/^\d{6}$/.test(String(a.pincode || ''))) {
    throw new Error(`Cannot determine a 6-digit pincode for ${orderId}`);
  }
  const phone = normalizeIndianPhone(order.customer_phone || '');
  if (!phone || String(phone).replace(/\D/g, '').length < 10) {
    throw new Error(`Cannot determine a 10-digit phone for ${orderId}`);
  }

  const isReplacement = isReplacementOrder(order);
  const money = classifyShipmentMoney(order, isReplacement);

  // Per-line prices must sum to the declared value: that sum is what iThink
  // bills against and what the courier collects. The cart carries real per-item
  // prices, so unlike the CSV mapping there is nothing to estimate -- but a
  // cart whose prices do not reconcile is scaled rather than silently shipped
  // with a wrong declared value.
  const items = parseCartItems(order.cart_items).filter(i => i && (i.title || i.name));
  let products;
  let productsResidualPaise = 0;
  if (items.length) {
    const raw = items.map(i => ({
      name: sanitizeForCourier(i.title || i.name || 'Book').slice(0, 100),
      sku: String(i.sku || ''),
      qty: Math.max(1, Number(i.qty || i.quantity || 1)),
      price: Number(i.price || 0),
    }));
    const sum = raw.reduce((t, i) => t + i.price * i.qty, 0);
    const factor = sum > 0 ? money.orderValueRs / sum : 0;

    // Work in integer paise. Per-unit prices carry two decimals, so a line with
    // qty > 1 cannot always absorb an arbitrary remainder: at qty 2 a one-paisa
    // unit change moves the line by two paise. Give the remainder to a qty-1
    // line, which can absorb any amount exactly. Carts almost always have one;
    // when none does, the last line takes it and the residue is at most a few
    // paise, which is reported rather than hidden.
    const targetPaise = Math.round(money.orderValueRs * 100);
    const unitsPaise = raw.map(i => (factor ? Math.round(i.price * factor * 100) : 0));
    const linesPaise = () => unitsPaise.reduce((t, u, k) => t + u * raw[k].qty, 0);

    let residual = targetPaise - linesPaise();
    if (residual !== 0) {
      const absorber = raw.findIndex(i => i.qty === 1);
      if (absorber >= 0) {
        unitsPaise[absorber] += residual;
      } else {
        const last = raw.length - 1;
        unitsPaise[last] += Math.round(residual / raw[last].qty);
      }
      residual = targetPaise - linesPaise();
    }

    products = raw.map((i, idx) => ({
      product_name: i.name,
      product_sku: i.sku,
      product_quantity: String(i.qty),
      product_price: String(Math.max(0, unitsPaise[idx]) / 100),
      // Omitting these crashes iThink's backend outright -- it casts them to
      // float and dies: "Cannot assign null to property ...$totalTax of type
      // float". Books are zero-rated, so 0 is also the correct answer.
      product_tax_rate: '0',
      product_hsn_code: HSN_PRINTED_BOOKS,
      product_discount: '0',
    }));
    productsResidualPaise = residual;
  } else {
    products = [{
      product_name: 'Books', product_sku: '', product_quantity: '1',
      product_price: String(money.orderValueRs),
      product_tax_rate: '0', product_hsn_code: HSN_PRINTED_BOOKS, product_discount: '0',
    }];
  }

  const name = sanitizeForCourier(order.customer_name || '') || 'Customer';
  const email = order.customer_email || '';
  // "Maharashtra -" comes back when the pincode was appended with a dash.
  const tidy = (v) => String(v || '').replace(/[\s\-\u2013,]+$/, '').trim();
  const tel = String(phone).replace(/\D/g, '').slice(-10);

  // iThink refuses an address under 10 characters ("Total address length for
  // shipment #1 must be at least 10 characters"). A short line is usually a
  // terse address whose locality got parsed off into city/state, so put those
  // back rather than padding with filler -- it is both longer AND more
  // deliverable. If it is still too short the address is genuinely unusable
  // and the order is reported instead of being sent to crash on their side.
  let line1 = sanitizeForCourier(tidy(a.address) || '');
  if (line1.length < 10) {
    line1 = sanitizeForCourier([tidy(a.address), tidy(a.city), tidy(a.state)]
      .filter(Boolean).join(', '));
  }
  if (line1.length < 10) {
    throw new Error(`Address for ${orderId} is only ${line1.length} characters `
      + `("${line1}") -- iThink requires at least 10. Fix the delivery address on the order.`);
  }

  return {
    _meta: {
      order_id: orderId, db_id: order.id,
      payment_type: money.shipmentPaymentType,
      declared: money.orderValueRs,
      collect: money.collectableAmount,
      advance: money.advanceRs,
      lines: products.length,
      products_sum: products.reduce((t, p) => t + Number(p.product_price) * Number(p.product_quantity), 0),
      residual_paise: productsResidualPaise,
    },
    shipment: {
      order: String(orderId),
      sub_order: '',
      order_date: ithinkDateTime(order.created_at),
      total_amount: String(money.orderValueRs),
      name,
      add:  line1,
      add2: '',
      pin:  String(a.pincode),
      city: tidy(a.city),
      state: tidy(a.state),
      country: 'India',
      phone: tel,
      // iThink's validator requires alt_phone to be PRESENT even though the
      // docs mark it optional -- an omitted one is rejected with "alt phone
      // field must be present", and a whole batch containing one comes back as
      // a bare null with no message at all. We have only the one number for a
      // customer, so it doubles as the alternate: it is the same person and
      // the courier would call it anyway.
      alt_phone: tel,
      email,
      company_name: '',
      add3: '',
      is_billing_same_as_shipping: 'yes',
      billing_name: name,
      billing_company_name: '',
      billing_add: line1,
      billing_add2: '',
      billing_add3: '',
      billing_pin: String(a.pincode),
      billing_city: tidy(a.city),
      billing_state: tidy(a.state),
      billing_country: 'India',
      billing_phone: tel,
      billing_alt_phone: tel,
      billing_email: email,
      products,
      ...BOX,
      shipping_charges: '0',
      giftwrap_charges: '0',
      transaction_charges: '0',
      total_discount: '0',
      first_attemp_discount: '0',
      cod_charges: '0',
      // Explicit money, rather than the CSV's discount trick.
      advance_amount: String(money.advanceRs),
      cod_amount: String(money.collectableAmount),
      payment_mode: money.isCOD ? 'COD' : 'Prepaid',
      reseller_name: '',
      eway_bill_number: '',
      gst_number: '',
    },
  };
}

async function syncBatch(shipments) {
  const res = await fetch(ITHINK_SYNC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: {
      shipments,
      access_token: process.env.ITHINK_ACCESS_TOKEN,
      secret_key: process.env.ITHINK_SECRET_KEY,
    } }),
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* fall through */ }
  if (data === null || data === undefined) {
    // iThink answers a batch it refuses outright with the JSON literal `null`
    // and no message. It has always been a missing mandatory field on one of
    // the shipments -- the batch is rejected whole, so every order in it fails.
    throw new Error('iThink rejected the whole batch with an empty response '
      + '(usually one shipment is missing a mandatory field; retry the batch one order at a time to find it)');
  }
  if (typeof data !== 'object') throw new Error(`iThink sync returned non-JSON (${res.status}): ${text.slice(0, 300)}`);
  // iThink sends status_code 200 on failure too; only `status` decides.
  if (String(data.status || '').toLowerCase() === 'error') {
    throw new Error(data.html_message || 'iThink rejected the batch');
  }
  return data;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST')    return json(405, { error: 'Method not allowed' });

  const block = requireAdmin(event, CORS);
  if (block) return block;

  if (!process.env.ITHINK_ACCESS_TOKEN || !process.env.ITHINK_SECRET_KEY) {
    return json(503, { error: 'ITHINK_ACCESS_TOKEN / ITHINK_SECRET_KEY are not configured on the Worker.' });
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  // paperbound is a separate storefront with its own fulfilment; never push it.
  let query = supabase.from('orders').select('*').or('source.is.null,source.neq.paperbound');
  if (body.all_unshipped) {
    query = query.in('status', UNSHIPPED_STATUSES).order('created_at', { ascending: false }).limit(500);
  } else if (Array.isArray(body.order_ids) && body.order_ids.length) {
    query = query.in('razorpay_order_id', body.order_ids);
  } else {
    return json(400, { error: 'Provide order_ids or all_unshipped:true' });
  }

  const { data: orders, error } = await query;
  if (error) return json(500, { error: error.message });
  if (!orders?.length) return json(404, { error: 'No orders matched' });

  const built = [], skipped = [], failed = [];
  for (const order of orders) {
    const orderId = order.razorpay_order_id || order.id;
    if (order.tracking_id) { skipped.push({ order_id: orderId, reason: `already has AWB ${order.tracking_id}` }); continue; }
    if (order.ithink_pushed_at && !body.force) { skipped.push({ order_id: orderId, reason: 'already pushed to iThink' }); continue; }
    try { built.push(await buildShipment(order)); }
    catch (err) { failed.push({ order_id: orderId, error: String(err.message || err) }); }
  }

  const totals = {
    queued: built.length,
    cod_orders: built.filter(b => b._meta.payment_type !== 'prepaid').length,
    cod_collectable: built.reduce((t, b) => t + b._meta.collect, 0),
    prepaid_orders: built.filter(b => b._meta.payment_type === 'prepaid').length,
    prepaid_declared: built.filter(b => b._meta.payment_type === 'prepaid').reduce((t, b) => t + b._meta.declared, 0),
    multi_item: built.filter(b => b._meta.lines > 1).length,
  };

  // Verify mode: read back what iThink actually holds for these orders. A run
  // that crashed mid-write can leave a record that answers "Duplicate order
  // found" on retry while holding no products and no collectable amount, so
  // "it is in the panel" is not the same as "it is in the panel correctly".
  if (body.verify) {
    const checked = [];
    for (const b of built.slice(0, Number(body.verify_limit) || 10)) {
      try {
        const res = await fetch(ITHINK_DETAILS_URL, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ data: {
            order_no: b._meta.order_id,
            access_token: process.env.ITHINK_ACCESS_TOKEN,
            secret_key: process.env.ITHINK_SECRET_KEY,
          } }),
        });
        const data = await res.json().catch(() => null);
        const rec = data?.data && typeof data.data === 'object' ? Object.values(data.data)[0] : null;
        checked.push({
          order_id: b._meta.order_id,
          found: !!rec,
          ithink_products: Array.isArray(rec?.products) ? rec.products.length : 0,
          our_products: b._meta.lines,
          ithink_awb: rec?.awb_no || null,
          ithink_status: rec?.latest_courier_status || null,
          ithink_pincode: rec?.customer_pincode || null,
          our_pincode: b.shipment.pin,
          our_collect: b._meta.collect,
          raw: rec || (data?.html_message ?? null),
        });
      } catch (e) {
        checked.push({ order_id: b._meta.order_id, error: String(e.message || e) });
      }
    }
    return json(200, { verify: true, checked });
  }

  if (body.dry_run) {
    return json(200, {
      dry_run: true, endpoint: ITHINK_SYNC_URL, totals,
      skipped, failed,
      orders: built.map(b => b._meta),
      sample_payload: built[0]?.shipment || null,
    });
  }

  // ── Push, in batches of 25 ───────────────────────────────────────────────
  const pushed = [];
  for (let i = 0; i < built.length; i += BATCH_SIZE) {
    const chunk = built.slice(i, i + BATCH_SIZE);
    try {
      const data = await syncBatch(chunk.map(c => c.shipment));
      // Results come back keyed "1","2",... in the order sent.
      const results = data?.data && typeof data.data === 'object' ? Object.values(data.data) : [];
      for (let k = 0; k < chunk.length; k++) {
        const r = results[k] || {};
        const ok = /success/i.test(String(r.status || ''));
        const orderId = chunk[k]._meta.order_id;
        if (ok) {
          pushed.push({ order_id: orderId, remark: r.remark || '' });
          try {
            await supabase.from('orders')
              .update({ ithink_pushed_at: new Date().toISOString() })
              .eq('id', chunk[k]._meta.db_id);
          } catch (e) {
            console.warn('[ithink-order-push] stamp ithink_pushed_at (run the migration):', e.message);
          }
        } else if (/already|duplicate|exists/i.test(String(r.remark || ''))) {
          skipped.push({ order_id: orderId, reason: r.remark });
        } else {
          failed.push({ order_id: orderId, error: r.remark || 'iThink did not report success' });
        }
      }
    } catch (err) {
      // iThink rejects a batch WHOLE: one shipment missing a mandatory field
      // fails the other 24 with it. Retry the chunk one order at a time so the
      // good ones still land and the report names the actual offender, instead
      // of 25 identical errors that say nothing about which order is wrong.
      if (chunk.length === 1) {
        failed.push({ order_id: chunk[0]._meta.order_id, error: String(err.message || err) });
        continue;
      }
      console.warn(`[ithink-order-push] batch of ${chunk.length} rejected, retrying individually:`, err.message);
      for (const c of chunk) {
        try {
          const one = await syncBatch([c.shipment]);
          const r = (one?.data && typeof one.data === 'object' ? Object.values(one.data)[0] : null) || {};
          if (/success/i.test(String(r.status || ''))) {
            pushed.push({ order_id: c._meta.order_id, remark: r.remark || '' });
            try {
              await supabase.from('orders')
                .update({ ithink_pushed_at: new Date().toISOString() })
                .eq('id', c._meta.db_id);
            } catch (e) {
              console.warn('[ithink-order-push] stamp ithink_pushed_at (run the migration):', e.message);
            }
          } else if (/already|duplicate|exists/i.test(String(r.remark || ''))) {
            skipped.push({ order_id: c._meta.order_id, reason: r.remark });
          } else {
            failed.push({ order_id: c._meta.order_id, error: r.remark || 'iThink did not report success' });
          }
        } catch (e2) {
          failed.push({ order_id: c._meta.order_id, error: String(e2.message || e2) });
        }
      }
    }
  }

  return json(200, { endpoint: ITHINK_SYNC_URL, totals, pushed, skipped, failed });
};

module.exports.buildShipment   = buildShipment;
module.exports.ithinkDateTime  = ithinkDateTime;
