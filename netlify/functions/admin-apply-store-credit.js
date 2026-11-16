/**
 * Netlify Function: admin-apply-store-credit   (admin, owner only)
 * POST /.netlify/functions/admin-apply-store-credit
 *   { order_id: "IC-…", code: "SCRATCH-…", dry_run = true }
 *
 * A customer placed a COD order without their store credit (before COD took
 * it, 16 Nov 2026: IC-20261116-FDLNA, ₹784 with a ₹578 credit unused). This
 * attaches the credit afterwards: the card is claimed for the order exactly as
 * checkout claims it, the total drops by the card's value and the first cart
 * line records { _store_credit: { code, discount } } so a cancel gives it back
 * (utils/order-cancelled-notification → releaseStoreCreditForOrder).
 *
 * Refused unless the order is unpaid COD, has no AWB and was never sent to a
 * courier panel: a courier would otherwise collect the old amount. Dry run by
 * default: it shows the new total and changes nothing.
 */

const { createClient } = require('@supabase/supabase-js');
const { requireAdmin } = require('./utils/admin-auth');
const { storeCreditCheck, claimScratchCardForOrder, releaseStoreCreditForOrder } = require('./utils/scratch-cards');
const { isSettled } = require('./utils/order-books-rebuild');

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key, X-Admin-Token',
  'Content-Type': 'application/json',
};
const UNPAID_COD = ['cod_pending', 'cod_awaiting_confirmation'];

const subtotalOf = (items) => (Array.isArray(items) ? items : [])
  .reduce((s, i) => s + (Number(i.price) || 0) * (Number(i.qty) || 1), 0);

/** Why this order cannot take the credit now, or '' when it can. */
function refusal(order) {
  if (!order) return 'Order not found.';
  if (!UNPAID_COD.includes(String(order.status || ''))) return `Only an unpaid COD order can take store credit afterwards (this one is ${order.status}).`;
  if (isSettled(order)) return 'This order has a payment on it already.';
  const awb = String(order.tracking_id || '').trim();
  if (awb) return `Already booked (AWB ${awb}); the courier would collect the old amount. Cancel that AWB first.`;
  const panel = order.nimbus_pushed_at ? 'NimbusPost' : order.xpressbees_feed_at ? 'the XpressBees panel' : order.ithink_pushed_at ? 'iThink' : '';
  if (panel) return `Already sent to ${panel} with the old amount; it would collect that. Remove it there first.`;
  const items = Array.isArray(order.cart_items) ? order.cart_items : [];
  const had = items.find((i) => i && i._store_credit && i._store_credit.code);
  if (had) return `Store credit ${had._store_credit.code} is already on this order.`;
  if (!items.length) return 'This order has no books on it.';
  return '';
}

async function applyStoreCredit(supabase, { orderId, code, dryRun = true }) {
  const id = String(orderId || '').toUpperCase().trim();
  const asked = String(code || '').toUpperCase().trim();
  if (!id || !asked.startsWith('SCRATCH-')) return { status: 400, error: 'Send order_id (IC-…) and a SCRATCH- code.' };

  const { data: order, error } = await supabase.from('orders').select('*').eq('razorpay_order_id', id).maybeSingle();
  if (error) return { status: 500, error: 'Could not read the order.' };
  const why = refusal(order);
  if (why) return { status: order ? 409 : 404, error: why };

  const subtotal = subtotalOf(order.cart_items);
  const check = await storeCreditCheck(supabase, asked, subtotal);
  if (!check.ok) return { status: 409, error: check.error || 'This code cannot be used.' };

  const credit = Math.round(Number(check.card.value_paise) / 100);
  const from = Math.round(Number(order.amount_paise || 0) / 100);
  const to = Math.max(1, from - credit);
  const preview = { order_id: id, code: asked, credit, from, to, subtotal };
  if (dryRun) return { status: 200, dry_run: true, ...preview };

  const claim = await claimScratchCardForOrder(supabase, asked, id);
  if (!claim.claimed) return { status: 409, error: `${asked} could not be claimed (${claim.reason || 'already used'}).` };

  const items = order.cart_items.map((i) => ({ ...i }));
  items[0]._store_credit = { code: asked, discount: credit };
  const { data: saved, error: saveErr } = await supabase.from('orders')
    .update({ amount_paise: to * 100, cart_items: items })
    .eq('id', order.id).eq('status', order.status)
    .select('id');
  if (saveErr || !saved || !saved.length) {
    // The order moved under us: give the card back so nothing is lost.
    await releaseStoreCreditForOrder(supabase, order);
    return { status: 409, error: 'The order changed while saving; nothing was applied and the card is unused again.' };
  }
  return { status: 200, applied: true, ...preview };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: 'Method Not Allowed' };
  const blocked = requireAdmin(event, CORS); if (blocked) return blocked;

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const { status, ...out } = await applyStoreCredit(supabase, {
      orderId: body.order_id, code: body.code, dryRun: body.dry_run !== false,
    });
    return { statusCode: status, headers: CORS, body: JSON.stringify(out) };
  } catch (err) {
    console.error('admin-apply-store-credit:', err && err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Something went wrong; nothing was applied.' }) };
  }
};

exports._test = { applyStoreCredit, refusal };
