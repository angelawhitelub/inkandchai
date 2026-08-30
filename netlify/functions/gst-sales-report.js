const { createClient } = require('@supabase/supabase-js');
const { requireAdmin } = require('./utils/admin-auth');
const { buildGstSalesReport, periodBounds } = require('./utils/gst-sales-report');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key, X-Admin-Token',
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
};

async function paged(queryFactory, size = 1000) {
  const rows = [];
  for (let from = 0; ; from += size) {
    const { data, error } = await queryFactory().range(from, from + size - 1);
    if (error) throw error;
    rows.push(...(data || []));
    if (!data || data.length < size) break;
  }
  return rows;
}

exports.handler = async event => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'GET') return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  const blocked = requireAdmin(event, CORS); if (blocked) return blocked;

  try {
    const legacyMonth = String(event.queryStringParameters?.month || '');
    const fromMonth = String(event.queryStringParameters?.from_month || legacyMonth);
    const toMonth = String(event.queryStringParameters?.to_month || fromMonth);
    const supplierState = String(event.queryStringParameters?.supplier_state || 'Delhi').trim() || 'Delhi';
    const supplierStateCode = String(event.queryStringParameters?.supplier_state_code || '07').trim() || '07';
    const { start, end } = periodBounds(fromMonth, toMonth);
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

    const saleOrders = await paged(() => supabase.from('orders').select('*')
      .or('source.is.null,source.neq.paperbound')
      .gte('created_at', start.toISOString()).lt('created_at', end.toISOString())
      .order('created_at', { ascending: true }));

    const refundOrders = await paged(() => supabase.from('orders').select('*')
      .or('source.is.null,source.neq.paperbound')
      .gte('refund_updated_at', start.toISOString()).lt('refund_updated_at', end.toISOString())
      .order('refund_updated_at', { ascending: true }));

    let completedReturns = [];
    try {
      completedReturns = await paged(() => supabase.from('return_requests').select('*')
        .gte('refunded_at', start.toISOString()).lt('refunded_at', end.toISOString())
        .order('refunded_at', { ascending: true }));
    } catch (error) {
      console.warn('[gst-sales-report] return_requests unavailable:', error.message);
    }

    const merged = new Map([...saleOrders, ...refundOrders].map(order => [String(order.id), order]));
    const missingOrderIds = [...new Set(completedReturns.map(r => r.order_id).filter(id => id && !merged.has(String(id))))];
    for (let i = 0; i < missingOrderIds.length; i += 100) {
      const { data, error } = await supabase.from('orders').select('*').in('id', missingOrderIds.slice(i, i + 100));
      if (error) throw error;
      for (const order of data || []) merged.set(String(order.id), order);
    }

    const report = buildGstSalesReport({
      fromMonth, toMonth, orders: [...merged.values()], returns: completedReturns,
      supplierState, supplierStateCode,
    });
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ success: true, report }) };
  } catch (error) {
    console.error('[gst-sales-report]', error);
    const badRange = /(?:from_month|to_month|calendar months)/i.test(String(error.message || ''));
    return { statusCode: badRange ? 400 : 500, headers: CORS, body: JSON.stringify({ error: error.message }) };
  }
};
