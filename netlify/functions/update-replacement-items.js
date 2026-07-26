/**
 * Admin-only editor for the books in an unshipped replacement order.
 *
 * Replacement orders are free (amount_paise=0), but cart_items retain each
 * book's original price and the first item carries `_replacement` metadata.
 * This endpoint edits by original item index so neither value nor metadata is
 * lost. Once the order has been pushed to NimbusPost or assigned an AWB, the
 * parcel contents are locked to avoid the website disagreeing with the label.
 */

const { createClient } = require('@supabase/supabase-js');
const { requireAdmin } = require('./utils/admin-auth');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key, X-Admin-Token',
  'Content-Type': 'application/json',
};

function json(statusCode, body) {
  return { statusCode, headers: CORS, body: JSON.stringify(body) };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

  const blocked = requireAdmin(event, CORS);
  if (blocked) return blocked;

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: 'Invalid JSON' }); }

  const orderId = String(body.id || '').trim();
  const selected = Array.isArray(body.items) ? body.items : [];
  if (!orderId) return json(400, { error: 'Missing replacement order id' });
  if (!selected.length) return json(400, { error: 'Keep at least one book in the replacement' });
  if (selected.length > 50) return json(400, { error: 'Too many replacement lines' });

  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const { data: order, error: fetchError } = await supabase
      .from('orders').select('*').eq('id', orderId).maybeSingle();
    if (fetchError) throw fetchError;
    if (!order) return json(404, { error: 'Replacement order not found' });

    const current = Array.isArray(order.cart_items) ? order.cart_items : [];
    const replacementMeta = current.find(item => item?._replacement)?._replacement;
    if (order.source !== 'replacement' && !replacementMeta) {
      return json(400, { error: 'This is not a replacement order' });
    }
    if (order.status !== 'replacement_pending' || order.tracking_id || order.nimbus_pushed_at) {
      return json(409, { error: 'Books can only be edited before the replacement is pushed for shipping' });
    }

    const seen = new Set();
    const nextItems = [];
    for (const choice of selected) {
      const index = Number(choice?.index);
      const qty = Number(choice?.qty);
      if (!Number.isInteger(index) || index < 0 || index >= current.length || seen.has(index)) {
        return json(400, { error: 'Invalid or duplicate replacement item' });
      }
      const originalQty = Math.max(1, Math.floor(Number(current[index]?.qty) || 1));
      if (!Number.isInteger(qty) || qty < 1 || qty > originalQty) {
        return json(400, { error: `Quantity for ${current[index]?.title || 'book'} must be between 1 and ${originalQty}` });
      }
      seen.add(index);
      const clean = { ...current[index], qty };
      delete clean._replacement;
      nextItems.push(clean);
    }

    // The original request link/photos/reason must stay on item zero because
    // all existing admin and customer readers intentionally look there.
    if (replacementMeta) {
      nextItems[0]._replacement = {
        ...replacementMeta,
        admin_edited_at: new Date().toISOString(),
        original_item_count: replacementMeta.original_item_count || current.length,
      };
    }

    const { data: saved, error: updateError } = await supabase
      .from('orders')
      .update({ cart_items: nextItems })
      .eq('id', order.id)
      .eq('status', 'replacement_pending')
      .is('tracking_id', null)
      .select('id, razorpay_order_id, cart_items')
      .maybeSingle();
    if (updateError) throw updateError;
    if (!saved) return json(409, { error: 'Replacement changed or started shipping; refresh and try again' });

    console.log(`[update-replacement-items] ${order.razorpay_order_id || order.id}: ${current.length} → ${nextItems.length} line(s)`);
    return json(200, {
      success: true,
      order_id: saved.razorpay_order_id || order.razorpay_order_id || order.id,
      cart_items: saved.cart_items,
    });
  } catch (error) {
    console.error('[update-replacement-items]', error.message);
    return json(500, { error: error.message });
  }
};
