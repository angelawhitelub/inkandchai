/**
 * Netlify Function: mark-refund-upi-paid
 * POST /.netlify/functions/mark-refund-upi-paid   (admin only)
 *
 * Closes out a manual UPI payout for a cancelled missing-book replacement.
 *
 * The transfer itself happens in a banking app -- no API here sends money, and
 * this endpoint deliberately cannot. It only records that a person did it, so
 * the Missing Books tab is a worklist that empties rather than a report that
 * grows. Without this the same rows would be re-read every week with no way to
 * tell settled from outstanding.
 *
 * Body: { id, ref?, undo? }
 *   id    replacement row uuid or its IC-R-… order id
 *   ref   UTR / transaction reference, optional but strongly encouraged
 *   undo  clear the mark (paid in error)
 */

const { createClient } = require('@supabase/supabase-js');
const { requireAdmin } = require('./utils/admin-auth');
const { replacementMeta, isMissingBookReplacement } = require('./utils/missing-books');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key, X-Admin-Token',
  'Content-Type': 'application/json',
};

const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

  const blocked = requireAdmin(event, CORS);
  if (blocked) return blocked;

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: 'Invalid JSON' }); }

  const id = String(body.id || '').trim();
  if (!id) return json(400, { error: 'Missing replacement id' });
  const ref = String(body.ref || '').trim().slice(0, 120);
  const undo = !!body.undo;

  try {
    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
    const { data: repl, error } = await sb
      .from('orders').select('*')
      .eq(isUuid ? 'id' : 'razorpay_order_id', id)
      .maybeSingle();
    if (error) throw error;
    if (!repl) return json(404, { error: 'Replacement order not found' });
    if (!isMissingBookReplacement(repl)) {
      return json(400, { error: 'That order is not a missing-book replacement.' });
    }

    const meta = replacementMeta(repl) || {};
    if (!undo && !meta.refund_upi_id) {
      return json(400, { error: 'No UPI ID recorded on this one yet — there is nothing to have paid it to.' });
    }

    const cart = JSON.parse(JSON.stringify(Array.isArray(repl.cart_items) ? repl.cart_items : []));
    const idx = cart.findIndex(it => it && it._replacement);
    if (idx < 0) return json(500, { error: 'This order is missing its replacement details.' });

    if (undo) {
      const { refund_paid_at, refund_paid_ref, ...rest } = cart[idx]._replacement;
      cart[idx]._replacement = rest;
    } else {
      cart[idx]._replacement = {
        ...cart[idx]._replacement,
        refund_paid_at: new Date().toISOString(),
        ...(ref ? { refund_paid_ref: ref } : {}),
      };
    }

    const { error: upErr } = await sb.from('orders').update({ cart_items: cart }).eq('id', repl.id);
    if (upErr) throw upErr;

    return json(200, {
      ok: true,
      paid: !undo,
      message: undo ? 'Payout mark cleared.' : `Marked paid${ref ? ` (ref ${ref})` : ''}.`,
    });
  } catch (e) {
    console.error('[mark-refund-upi-paid]', e);
    return json(500, { error: e.message || 'Could not update that right now' });
  }
};
