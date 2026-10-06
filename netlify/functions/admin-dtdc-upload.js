/**
 * Owner endpoint: admin-dtdc-upload
 * GET /.netlify/functions/admin-dtdc-upload[?days=30]
 *
 * The unshipped orders as rows for the DTDC customer portal's Bulk Upload
 * (utils/dtdc-upload.js has the template and the per-column rules). The admin
 * turns the JSON into the .xlsx with SheetJS, so this stays a plain read.
 *
 * Unshipped = the admin's Unshipped list: an open status, no AWB from any
 * courier, not a Paperbound order, payment not stuck pending, placed in the
 * last `days` days. Each order goes through woo-channel's toWooOrder, so an
 * address with no pincode or phone is reported in `skipped` instead of being
 * uploaded undeliverable.
 *
 * READ-ONLY: nothing is booked at DTDC and no order is changed. Booking an
 * order that is also sitting unbooked in the XpressBees panel is still
 * possible -- the sheet cannot see that panel -- so the admin says so.
 */

const { createClient } = require('@supabase/supabase-js');
const { requireAdmin } = require('./utils/admin-auth');
const woo = require('./woo-channel');
const { COLUMNS, QUESTION_COLUMNS, toDtdcRow } = require('./utils/dtdc-upload');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key, X-Admin-Token',
};
const json = (statusCode, body) => ({
  statusCode, headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store, private' }, body: JSON.stringify(body),
});

async function unshippedOrders(supabase, { days }) {
  const since = new Date(Date.now() - days * 86400e3).toISOString();
  const { data, error } = await supabase
    .from('orders')
    .select('*')
    .or('source.is.null,source.neq.paperbound')
    .in('status', woo.UNSHIPPED_STATUSES)
    .is('tracking_id', null)
    .gte('created_at', since)
    .order('created_at', { ascending: true })
    .limit(1000);
  if (error) throw new Error(`orders query failed: ${error.message}`);
  return (data || []).filter((o) => !woo.isPaymentPending(o.status));
}

async function build({ days = 30 } = {}, deps = {}) {
  const supabase = deps.supabase || createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const toWooOrder = deps.toWooOrder || woo.toWooOrder;
  const orders = await unshippedOrders(supabase, { days });
  const rows = [];
  const included = [];
  const skipped = [];
  for (const o of orders) {
    const number = o.razorpay_order_id || o.id;
    try {
      const { row, cod, collect, orderValue } = toDtdcRow(await toWooOrder(o));
      rows.push(row);
      included.push({ order: number, cod, collect_rs: collect, value_rs: orderValue });
    } catch (e) {
      skipped.push({ order: number, error: e.message });
    }
  }
  return {
    columns: COLUMNS, question_columns: QUESTION_COLUMNS, rows, orders: included, skipped, days,
    cod: included.filter((r) => r.cod).length, prepaid: included.filter((r) => !r.cod).length,
    cod_total_rs: included.reduce((t, r) => t + (r.cod ? r.collect_rs : 0), 0),
  };
}

exports.handler = async (event = {}) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  const block = requireAdmin(event, CORS);
  if (block) return block;
  if (event.httpMethod !== 'GET') return json(405, { error: 'GET only' });
  const days = Math.min(90, Math.max(1, parseInt((event.queryStringParameters || {}).days, 10) || 30));
  try {
    return json(200, { success: true, ...(await build({ days })) });
  } catch (e) {
    console.error('[dtdc-upload]', e);
    return json(500, { error: e.message });
  }
};

exports._test = { build, unshippedOrders };
