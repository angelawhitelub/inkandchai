/**
 * Netlify Function: admin-relink-replacement   (owner only)
 * POST { replacement: "IC-R-…", original: "IC-…", dry_run = true }
 *
 * Puts back a replacement order's link to the order it replaces, for
 * replacements that lost cart_items[0]._replacement. Editing the books in "Edit
 * order details" used to rebuild the cart without it (fixed in
 * utils/order-books-rebuild.js), and the same edit priced the free replacement
 * from the catalogue, so it read as a ₹294 order with no original.
 *
 * Checks before writing: the row is a replacement (source or IC-R- id) with no
 * link; the original exists, is not itself a replacement, has the same phone
 * and was placed before it. The write restores the link and sets the total
 * back to ₹0 (nothing was ever collected on a replacement: no payment id).
 * Sends nothing to anyone.
 */

const { createClient } = require('@supabase/supabase-js');
const { requireAdmin } = require('./utils/admin-auth');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key, X-Admin-Token',
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
};
const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });
const last10 = (p) => String(p || '').replace(/\D/g, '').slice(-10);
const isReplacement = (o) => o.source === 'replacement' || /^IC-R-/i.test(String(o.razorpay_order_id || ''));

/** What the original's own markers say the replacement was for. */
function reasonFor(original) {
  const items = Array.isArray(original.cart_items) ? original.cart_items : [];
  if (items.some((i) => i && i._missing)) return { reason: 'missing_item', reason_label: 'Item missing from package' };
  if (items.some((i) => i && (i._damaged || i._damage))) return { reason: 'damaged', reason_label: 'Damaged item' };
  return { reason: 'other', reason_label: 'Replacement' };
}

/** → { error } or { patch, summary } — pure, for tests. */
function planRelink(repl, original, now = new Date()) {
  if (!repl) return { error: 'Replacement order not found.' };
  if (!original) return { error: 'Original order not found.' };
  if (!isReplacement(repl)) return { error: `${repl.razorpay_order_id} is not a replacement order.` };
  const items = Array.isArray(repl.cart_items) ? repl.cart_items : [];
  const linked = items.find((i) => i && i._replacement);
  if (linked) return { error: `${repl.razorpay_order_id} is already linked to ${linked._replacement.original_order_id || '(no id)'}.` };
  if (!items.length) return { error: `${repl.razorpay_order_id} has no books.` };
  if (isReplacement(original)) return { error: `${original.razorpay_order_id} is itself a replacement.` };
  if (last10(repl.customer_phone) !== last10(original.customer_phone)) return { error: 'The two orders have different phone numbers.' };
  if (String(original.created_at) >= String(repl.created_at)) return { error: 'The original must be placed before the replacement.' };
  if (repl.razorpay_payment_id) return { error: `${repl.razorpay_order_id} has a payment id; check it by hand.` };

  const cart = items.map((i) => ({ ...i }));
  cart[0]._replacement = {
    original_order_id: original.razorpay_order_id,
    ...reasonFor(original),
    note: 'Link restored by the owner: it was lost when the books were edited.',
    relinked_at: now.toISOString(),
  };
  return {
    patch: { cart_items: cart, amount_paise: 0 },
    summary: {
      replacement: repl.razorpay_order_id,
      original: original.razorpay_order_id,
      reason: cart[0]._replacement.reason_label,
      total: `₹${(Number(repl.amount_paise || 0) / 100).toLocaleString('en-IN')} → ₹0`,
    },
  };
}

async function handle(event, deps = {}) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'POST only' });
  if (!deps.skipAuth) { const block = requireAdmin(event, CORS); if (block) return block; }
  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }
  const replRef = String(body.replacement || '').trim();
  const origRef = String(body.original || '').trim();
  if (!replRef || !origRef) return json(400, { error: 'Send replacement (IC-R-…) and original (IC-…).' });
  const dryRun = body.dry_run !== false;
  const supabase = deps.db || createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  try {
    const cols = 'id, razorpay_order_id, razorpay_payment_id, source, status, amount_paise, customer_phone, created_at, cart_items';
    const [a, b] = await Promise.all([
      supabase.from('orders').select(cols).eq('razorpay_order_id', replRef).maybeSingle(),
      supabase.from('orders').select(cols).eq('razorpay_order_id', origRef).maybeSingle(),
    ]);
    if (a.error) throw a.error;
    if (b.error) throw b.error;
    const plan = planRelink(a.data, b.data);
    if (plan.error) return json(400, { error: plan.error });
    if (dryRun) return json(200, { dry_run: true, ...plan.summary });
    const { data: saved, error } = await supabase.from('orders').update(plan.patch)
      .eq('id', a.data.id).is('razorpay_payment_id', null).select('id').maybeSingle();
    if (error) throw error;
    if (!saved) return json(409, { error: 'The order changed; refresh and try again.' });
    console.log('[admin-relink-replacement]', JSON.stringify(plan.summary));
    return json(200, { dry_run: false, ok: true, ...plan.summary });
  } catch (e) {
    console.error('[admin-relink-replacement]', e.message);
    return json(500, { error: e.message });
  }
}

exports.handler = (event) => handle(event);
exports._test = { planRelink, reasonFor, handle };
