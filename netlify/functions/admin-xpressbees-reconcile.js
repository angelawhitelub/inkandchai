/**
 * Netlify Function: admin-xpressbees-reconcile
 * POST /.netlify/functions/admin-xpressbees-reconcile   { "pages": 3, "raw": false }
 *
 * Read-only. Compares what the COURIER thinks each shipment is against what
 * OUR BOOKS say it is, and reports every disagreement.
 *
 * WHY THIS EXISTS
 * ---------------
 * On 17 September 133 orders imported through the WooCommerce channel and all
 * 133 came out COD -- 66 of them already paid in full or free replacements,
 * Rs 25,042 the courier was going to ask for at doorsteps. Every check that
 * ran that day passed: the feed served the right payment_method, the booking
 * API returned success, the tracking API said "pending pickup". None of them
 * compared the two sides. The mistake was invisible for two days because
 * nothing in this repo ever read a shipment back.
 *
 * So this reads the panel's own order list -- the one place payment mode is
 * visible -- classifies the same order with classifyShipmentMoney, and flags
 * any row where the courier would collect money our books say is already in
 * the bank. Run it after any bulk push; it is the check that was missing.
 *
 * Nothing here books, cancels or modifies anything.
 */

const { createClient } = require('@supabase/supabase-js');
const { requireAdmin } = require('./utils/admin-auth');
const xb = require('./utils/xpressbees');
const { classifyShipmentMoney } = require('./utils/shipment-money');
const { isReplacementOrder } = require('./utils/replacement-order');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key, X-Admin-Token',
  'Content-Type': 'application/json',
};
const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body, null, 2) });

const MAX_PAGES = 10;

/**
 * The panel's order number back to ours.
 *
 * Re-booked orders carry a suffix -- XpressBees keeps an order number RESERVED
 * after a cancel, so the twelve re-bookings on 19 Sep went out as `-p` -- and
 * the iThink batches used `-c` and `-d`. The panel also truncates at 20
 * characters, so the base may be short of the real id; callers match on this
 * prefix rather than on equality.
 */
function baseOrderNumber(n) {
  return String(n || '').trim().toUpperCase().replace(/-[A-Z0-9]{1,2}$/i, (m) => (/^-(P|C|D)$/i.test(m) ? '' : m));
}

/** What the panel says about money, normalised. Field names vary by endpoint. */
function panelPayment(row) {
  const mode = String(row.payment_type ?? row.payment_mode ?? row.payment_method ?? '').toLowerCase();
  const collectable = Number(
    row.collectable_amount ?? row.cod_amount ?? row.collectable ?? row.cod_charges ?? 0,
  ) || 0;
  const isCOD = /cod|cash/.test(mode) || (!/prepaid|ppd/.test(mode) && collectable > 0);
  return { mode: mode || null, collectable, isCOD };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  const block = requireAdmin(event, CORS);
  if (block) return block;
  if (event.httpMethod !== 'POST') return json(405, { error: 'POST only' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: 'Invalid JSON' }); }

  const pages = Math.min(MAX_PAGES, Math.max(1, Number(body.pages) || 3));

  // The panel side. One shared bearer token, so serial.
  const panel = [];
  let meta = null;
  try {
    for (let p = 1; p <= pages; p += 1) {
      const out = await xb.panelOrders({ page: p, perPage: 100 });
      meta = out.meta || meta;
      if (!out.rows.length) break;
      panel.push(...out.rows);
      if (out.rows.length < 100) break;
    }
  } catch (e) {
    return json(502, { error: `could not read the XpressBees order list: ${e.message}` });
  }

  if (body.raw) {
    return json(200, { fetched: panel.length, meta, sample: panel.slice(0, Number(body.raw) || 2) });
  }

  // Our side.
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const { data: rows, error } = await supabase
    .from('orders')
    .select('id, razorpay_order_id, status, created_at, customer_name, source, '
          + 'amount_paise, advance_paid_paise, razorpay_payment_id, cart_items, tracking_id')
    .or('source.is.null,source.neq.paperbound')
    .order('created_at', { ascending: false })
    .limit(1000);
  if (error) return json(500, { error: `orders query failed: ${error.message}` });

  const byNumber = new Map();
  for (const o of rows || []) byNumber.set(String(o.razorpay_order_id || '').toUpperCase(), o);

  const disagree = [];
  const agree = [];
  const unmatched = [];

  for (const row of panel) {
    const panelNumber = row.order_number ?? row.order_id ?? row.orderNumber ?? '';
    const base = baseOrderNumber(panelNumber);
    let ours = byNumber.get(base);
    if (!ours) {
      // The panel truncates at 20 characters: match on prefix.
      for (const [num, o] of byNumber) {
        if (base && num.startsWith(base)) { ours = o; break; }
      }
    }
    if (!ours) { unmatched.push({ panel_order: panelNumber, awb: row.awb_number || null }); continue; }

    const pay = panelPayment(row);
    let books;
    try {
      const m = classifyShipmentMoney(ours, isReplacementOrder(ours));
      books = { isCOD: m.isCOD, collectable: m.collectableAmount, type: m.shipmentPaymentType };
    } catch (e) {
      unmatched.push({ panel_order: panelNumber, order: ours.razorpay_order_id, error: e.message });
      continue;
    }

    const entry = {
      order: ours.razorpay_order_id,
      panel_order: panelNumber,
      awb: row.awb_number || null,
      status: row.status || null,
      customer: ours.customer_name || null,
      panel: { mode: pay.mode, collectable: pay.collectable },
      books: { mode: books.type, collectable: books.collectable },
    };

    // The only failure that costs money: the courier collects where we say
    // nothing is owed, or collects more than the balance.
    if (pay.isCOD && !books.isCOD) {
      disagree.push({ ...entry, problem: 'panel will COLLECT on an order our books say is already paid' });
    } else if (pay.isCOD && books.isCOD && pay.collectable > books.collectable + 1) {
      disagree.push({ ...entry, problem: `panel will collect Rs ${pay.collectable} against a balance of Rs ${books.collectable}` });
    } else if (!pay.isCOD && books.isCOD) {
      disagree.push({ ...entry, problem: 'panel will NOT collect on a COD order -- the money will never arrive' });
    } else {
      agree.push(entry);
    }
  }

  const exposure = disagree.reduce((t, d) => t + (Number(d.panel.collectable) || 0), 0);

  return json(200, {
    checked: panel.length,
    agree: agree.length,
    disagree: disagree.length,
    unmatched: unmatched.length,
    wrongly_collectable_rs: Math.round(exposure),
    disagreements: disagree,
    unmatched_rows: unmatched.slice(0, 50),
  });
};

exports.__test = { baseOrderNumber, panelPayment };
