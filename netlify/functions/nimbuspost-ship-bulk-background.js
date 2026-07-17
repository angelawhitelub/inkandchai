/**
 * Netlify Function: nimbuspost-ship-bulk-background
 * POST /.netlify/functions/nimbuspost-ship-bulk-background   { order_ids: [...] }
 *
 * Background (15-min limit) bulk AWB creation. The synchronous nimbuspost-ship
 * endpoint dies at Netlify's 10s gateway limit whenever NimbusPost's API is
 * slow — even three orders can overrun it. This runs the SAME per-order
 * pipeline (priority-ladder courier selection → create shipment → write AWB +
 * notify) without that ceiling. Netlify replies 202 immediately; each order's
 * result is persisted as it completes, and the owner gets a WhatsApp summary
 * at the end.
 *
 * Headers: X-Admin-Token / X-Admin-Key.
 */

const { createClient } = require('@supabase/supabase-js');
const { requireAdmin } = require('./utils/admin-auth');
const { sendText } = require('./utils/whatsapp');
const { shipOrder, npAuthenticate, resolveWarehouseId } = require('./nimbuspost-ship');

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Admin-Token, X-Admin-Key',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST')    return { statusCode: 405, headers: CORS, body: 'Method Not Allowed' };

  const _adminBlock = requireAdmin(event, CORS); if (_adminBlock) return _adminBlock;

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch { /* defaults */ }
  const ids = (Array.isArray(body.order_ids) ? body.order_ids : []).map(String).filter(Boolean).slice(0, 500);
  if (!ids.length) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Provide order_ids' }) };

  const started = Date.now();
  const summary = { requested: ids.length, shipped: 0, skipped: 0, failed: 0, failures: [] };

  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const { data: orders, error } = await supabase
      .from('orders').select('*').in('razorpay_order_id', ids);
    if (error) throw error;
    if (!orders?.length) throw new Error('No orders found for the given ids');

    const token       = await npAuthenticate();
    const warehouseId = await resolveWarehouseId(token);

    for (const order of orders) {
      const oid = order.razorpay_order_id || order.id;
      if (order.tracking_id) { summary.skipped++; continue; }
      try {
        await shipOrder(supabase, token, warehouseId, order, null);
        summary.shipped++;
      } catch (err) {
        summary.failed++;
        summary.failures.push(`${oid}: ${String(err.message || err).slice(0, 140)}`);
        console.error(`[ship-bulk-bg] ${oid} failed:`, err.message);
      }
    }
  } catch (err) {
    summary.fatal = err.message;
    console.error('[ship-bulk-bg] fatal:', err.message);
  }

  const mins = ((Date.now() - started) / 60000).toFixed(1);
  console.log('[ship-bulk-bg] done', JSON.stringify(summary));

  // WhatsApp the owner a completion summary — there's no synchronous response
  // to show in the admin, so this is how they learn the run finished.
  if (process.env.STORE_OWNER_PHONE) {
    const failLines = summary.failures.slice(0, 6).join('\n');
    await sendText(
      process.env.STORE_OWNER_PHONE,
      `🚀 Bulk AWB creation finished (${mins} min)\n` +
      `✅ Shipped: ${summary.shipped}\n⏭ Skipped (had AWB): ${summary.skipped}\n❌ Failed: ${summary.failed}` +
      (failLines ? `\n\nFailures:\n${failLines}${summary.failures.length > 6 ? `\n… +${summary.failures.length - 6} more` : ''}` : '') +
      (summary.fatal ? `\n\n⚠️ Run aborted early: ${summary.fatal}` : '') +
      `\n\nRefresh the admin Orders tab to see the AWBs.`
    ).catch(() => {});
  }

  return { statusCode: 200, headers: CORS, body: JSON.stringify({ success: !summary.fatal, summary }) };
};
