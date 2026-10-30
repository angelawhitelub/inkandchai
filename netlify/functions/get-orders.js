/**
 * Netlify Function: get-orders
 * GET /.netlify/functions/get-orders
 * Admin endpoint — returns all orders. Requires X-Admin-Key header.
 */

const { createClient } = require('@supabase/supabase-js');
const { requireAdmin } = require('./utils/admin-auth');

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key',
  'Content-Type': 'application/json',
};

const CHANGE_COLUMNS = ['last_courier_status_at', 'last_nimbuspost_event_at', 'delivered_at', 'shipment_moved_at'];
const SEARCH_COLUMNS = ['razorpay_order_id', 'razorpay_payment_id', 'tracking_id', 'customer_name', 'customer_email'];

/** PostgREST `or` terms for a search box value, or null for an empty one. */
function searchFilter(raw) {
  const q = String(raw || '').replace(/[^A-Za-z0-9@.+_ -]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
  if (q.length < 2) return null;
  const terms = SEARCH_COLUMNS.map((c) => `${c}.ilike.*${q}*`);
  // Phones are stored with and without +91 / 91 / spaces: match the last ten digits.
  const digits = q.replace(/\D/g, '');
  if (/^[+\d\s-]+$/.test(q) && digits.length >= 6) terms.push(`customer_phone.ilike.*${digits.slice(-10)}*`);
  return terms.join(',');
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  const _adminBlock = requireAdmin(event, CORS); if (_adminBlock) return _adminBlock;
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'SUPABASE_URL and SUPABASE_SERVICE_KEY environment variables are not set in Netlify.' }) };
  }

  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

    const page  = parseInt(event.queryStringParameters?.page  || '1', 10);
    const limit = parseInt(event.queryStringParameters?.limit || '50', 10);
    const from  = (page - 1) * limit;

    const status = event.queryStringParameters?.status;
    // `statuses` (comma-separated) fetches several statuses at once. The admin's
    // Cancelled tab needs this: cancelling a PREPAID order immediately flips it to
    // refund_pending → refunded/refund_failed (see utils/order-cancelled-notification),
    // so a plain status=cancelled query returns COD orders only and silently hides
    // every prepaid cancellation.
    const statusesRaw = event.queryStringParameters?.statuses;
    const statuses = statusesRaw
      ? statusesRaw.split(',').map(s => s.trim()).filter(Boolean).slice(0, 12)
      : null;

    // `changed_since` (ISO time): orders a courier update touched since then,
    // whatever their age. The admin's 90-second poll reads only page 1 (the
    // newest orders), so an order from last week delivered tonight kept showing
    // "Out for Delivery" in an open tab until a full refresh -- IC-20261001-XOYAW
    // on 8 Oct. These are the columns the webhooks and sync jobs stamp.
    const changedRaw = event.queryStringParameters?.changed_since;
    let changedSince = null;
    if (changedRaw) {
      const t = new Date(changedRaw);
      if (Number.isNaN(t.getTime())) {
        return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'changed_since must be an ISO date' }) };
      }
      changedSince = t.toISOString();
    }
    const changed = changedSince
      ? CHANGE_COLUMNS.map((c) => `${c}.gte.${changedSince}`).join(',')
      : null;

    // `q`: find orders by order id, payment id, AWB, customer name, phone or
    // email on the server. The desktop admin loads every order and searches in
    // the browser; the mobile admin (public/admin/m/) cannot page 20,000 orders
    // over a phone connection. Characters that mean something inside a
    // PostgREST `or` (commas, parentheses, quotes, *, %) are dropped, not
    // escaped; dots are safe there, since only the first two split the term.
    const search = searchFilter(event.queryStringParameters?.q);
    const narrow = changed || search;

    let query = supabase
      .from('orders')
      .select('*', { count: 'exact' });
    // Exclude the paperbound store's orders. One `or` filter, so the
    // changed_since / q branch nests inside it rather than relying on how two
    // separate `or` parameters combine.
    query = narrow
      ? query.or(`and(source.is.null,or(${narrow})),and(source.neq.paperbound,or(${narrow}))`)
      : query.or('source.is.null,source.neq.paperbound');
    query = query
      .order('created_at', { ascending: false })
      .range(from, from + limit - 1);

    if (statuses && statuses.length) query = query.in('status', statuses);
    else if (status) query = query.eq('status', status);

    const { data, error, count } = await query;
    if (error) throw error;

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ orders: data, total: count, page, limit }),
    };
  } catch (err) {
    console.error('get-orders error:', err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};

module.exports.searchFilter = searchFilter;
