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
 * Body: { id, ref?, undo?, notify?, cancel? }
 *   id      replacement row uuid or its IC-R-… order id
 *   ref     UTR / transaction reference, optional but strongly encouraged
 *   undo    clear the mark (paid in error)
 *   cancel  also cancel the replacement — here AND in the NimbusPost panel
 *   notify  also tell the customer the money has been sent
 *
 * `cancel` exists because the two used to be separate clicks and the second one
 * was easy to forget: the refund got recorded, the free replacement stayed live
 * in the courier panel, and the customer was both refunded and sent the book.
 * Marking our own row cancelled is not enough — NimbusPost ships from its copy,
 * so the shipment has to be cancelled there too.
 *
 * `notify` is the only thing here that speaks to a customer, and it is reached
 * only through an explicit admin action. Nothing in this file moves money; it
 * records that a person already did, in a banking app.
 */

const { createClient } = require('@supabase/supabase-js');
const { requireAdmin } = require('./utils/admin-auth');
const { replacementMeta, isMissingBookReplacement, refundSplitPaise } = require('./utils/missing-books');
const { cancelNimbusShipment, cancelNimbusOrder } = require('./utils/nimbuspost-cancel');
const { notifyRefundUpiPaid } = require('./utils/refund-upi-notification');

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
  const alsoCancel = !undo && !!body.cancel;
  const alsoNotify = !undo && !!body.notify;

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

    // Everything past this point is best-effort follow-up. The payout is
    // already recorded, so a courier API or a mail server having a bad minute
    // must never surface as "the refund failed" — each step reports itself and
    // the admin panel prints whatever did not work.
    const steps = { cancelled: null, nimbuspost: null, notified: null };

    if (alsoCancel) {
      const status = String(repl.status || '').toLowerCase();
      if (status === 'delivered') {
        // The books arrived after all. Cancelling a delivered shipment would be
        // a lie to the courier and would strand the row in a state nobody can
        // read back. Leave it and say so.
        steps.cancelled = { ok: false, skipped: true, reason: 'replacement is already delivered' };
      } else if (status === 'cancelled') {
        steps.cancelled = { ok: true, alreadyCancelled: true };
      } else {
        const { error: cErr } = await sb
          .from('orders')
          .update({ status: 'cancelled' })
          .eq('id', repl.id);
        steps.cancelled = cErr ? { ok: false, error: cErr.message } : { ok: true };
      }

      // The courier panel holds its own copy, and this runs even when the row
      // was ALREADY cancelled here: update-order-status, which is how every
      // other admin cancel goes through, never told NimbusPost anything. So a
      // replacement cancelled last week can still be sitting live in the panel,
      // and only asking again finds out. NimbusPost treats a repeat cancel as
      // success, so asking costs nothing.
      //
      // An AWB means a booked shipment (cancel by AWB); no AWB means it is
      // still an unshipped panel order (cancel by order_number). Mirrors
      // cancel-order.js.
      if (steps.cancelled && steps.cancelled.ok) {
        const displayId = repl.razorpay_order_id || repl.id;
        try {
          steps.nimbuspost = repl.tracking_id
            ? { what: `AWB ${repl.tracking_id}`, ...(await cancelNimbusShipment(repl.tracking_id)) }
            : { what: `order ${displayId}`, ...(await cancelNimbusOrder(displayId)) };
        } catch (e) {
          steps.nimbuspost = { ok: false, error: e.message };
        }
        if (!steps.nimbuspost.ok) {
          console.error('[mark-refund-upi-paid] NP cancel failed:', steps.nimbuspost.error);
        }
      }
    }

    if (alsoNotify) {
      const original = await sb
        .from('orders').select('*')
        .eq('razorpay_order_id', String(meta.original_order_id || ''))
        .maybeSingle();
      // Quote what was actually transferred by hand, not the whole value of the
      // books. On a partial-COD order the gateway sends part of it back and only
      // the remainder is pushed to UPI — telling the customer the larger number
      // would have them hunting their statement for money nobody sent.
      const { upiPaise } = refundSplitPaise(repl, original.data);
      // The replacement carries the customer's own contact details, but the
      // original is the order they know by number, so that is the id quoted.
      const person = {
        razorpay_order_id: meta.original_order_id || repl.razorpay_order_id,
        id: repl.id,
        customer_name: repl.customer_name || original.data?.customer_name || '',
        customer_email: repl.customer_email || original.data?.customer_email || '',
        customer_phone: repl.customer_phone || original.data?.customer_phone || '',
      };
      const books = (Array.isArray(repl.cart_items) ? repl.cart_items : [])
        .map(it => String((it && (it.title || it.name)) || '').trim())
        .filter(Boolean);
      steps.notified = await notifyRefundUpiPaid({
        order: person,
        amountRs: upiPaise / 100,
        upiId: meta.refund_upi_id,
        ref,
        books,
      });
    }

    return json(200, {
      ok: true,
      paid: !undo,
      steps,
      message: undo ? 'Payout mark cleared.' : `Marked paid${ref ? ` (ref ${ref})` : ''}.`,
    });
  } catch (e) {
    console.error('[mark-refund-upi-paid]', e);
    return json(500, { error: e.message || 'Could not update that right now' });
  }
};
