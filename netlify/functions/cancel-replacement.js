/**
 * Netlify Function: cancel-replacement
 * POST /.netlify/functions/cancel-replacement   (admin)
 *
 * Cancels a replacement order and, when it was replacing books that never
 * arrived, refunds what those books cost on the ORIGINAL order in the same
 * action. Cancelling one used to leave the customer paid-for-nothing until
 * somebody remembered to open the original and refund it by hand.
 *
 * Body: { id, dry_run?, confirm_stopped? }
 *   id               replacement row uuid or its IC-R-… order id
 *   dry_run          say what would happen, change nothing (the panel's confirm)
 *   confirm_stopped  the admin has cancelled it in a courier panel we cannot
 *                    check (XpressBees feed, iThink), so the refund may go ahead
 *
 * Order of work, chosen so a failure never costs a book AND the money:
 *   1. cancel the replacement (update-order-status, which also stops an
 *      XpressBees AWB) and NimbusPost's copy
 *   2. refund ONLY if the parcel is confirmed stopped; a shipment already moving
 *      is left for a person, since the customer may yet receive the book
 *   3. refund through razorpay-refund / phonepe-refund themselves, so the amount
 *      checks, failure bookkeeping, retry job and customer notification are the
 *      ones every other refund uses
 *
 * The decision of WHETHER to refund is utils/missing-books replacementRefundPlan
 * and refuses whenever a second refund is possible (see there). A claim stamp on
 * the replacement is written before the gateway is called, so a double click or
 * a retry after a timeout cannot send a second refund.
 */

const { createClient } = require('@supabase/supabase-js');
const { requireAdmin } = require('./utils/admin-auth');
const { replacementMeta, isReplacementOrder, replacementRefundPlan, shipmentStopState } = require('./utils/missing-books');
const { cancelCourierShipment } = require('./utils/courier-shipment-cancel');
const { cancelNimbusShipment, cancelNimbusOrder } = require('./utils/nimbuspost-cancel');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key, X-Admin-Token',
  'Content-Type': 'application/json',
};
const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });
const rupees = (paise) => (Number(paise || 0) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Static requires, not require(`./${name}`): the Worker bundler cannot follow a
// computed path and would try to pull in every file in the directory.
// Looked up at call time so tests can stub them.
const FUNCTIONS = {
  'update-order-status': () => require('./update-order-status'),
  'razorpay-refund': () => require('./razorpay-refund'),
  'phonepe-refund': () => require('./phonepe-refund'),
};

/** Run another admin function in-process, as the same admin, with its own staff permission check. */
async function callFunction(event, name, body) {
  const mod = FUNCTIONS[name]();
  const res = await mod.handler({
    ...event,
    httpMethod: 'POST',
    path: `/.netlify/functions/${name}`,
    body: JSON.stringify(body),
  });
  let data = {};
  try { data = JSON.parse(res.body || '{}'); } catch { data = { error: String(res.body || '').slice(0, 200) }; }
  return { statusCode: res.statusCode, data };
}

/** Merge into the replacement's `_replacement` blob, re-reading the cart first. */
async function stampMeta(sb, replId, patch, drop = []) {
  const { data: row, error } = await sb.from('orders').select('cart_items').eq('id', replId).maybeSingle();
  if (error || !row) throw new Error(error ? error.message : 'Replacement vanished');
  const cart = JSON.parse(JSON.stringify(Array.isArray(row.cart_items) ? row.cart_items : []));
  const idx = cart.findIndex(it => it && it._replacement);
  if (idx < 0) throw new Error('Replacement details missing');
  const next = { ...cart[idx]._replacement, ...patch };
  for (const key of drop) delete next[key];
  cart[idx]._replacement = next;
  const { error: upErr } = await sb.from('orders').update({ cart_items: cart }).eq('id', replId);
  if (upErr) throw new Error(upErr.message);
  return next;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });
  const blocked = requireAdmin(event, CORS);
  if (blocked) return blocked;

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }
  const id = String(body.id || '').trim();
  if (!id) return json(400, { error: 'Missing replacement id' });

  try {
    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const { data: repl, error } = await sb.from('orders').select('*')
      .eq(UUID.test(id) ? 'id' : 'razorpay_order_id', id).maybeSingle();
    if (error) throw error;
    if (!repl) return json(404, { error: 'Replacement not found' });
    if (!isReplacementOrder(repl)) return json(400, { error: 'That is not a replacement order.' });

    const status = String(repl.status || '').toLowerCase();
    if (status === 'delivered') {
      return json(400, { error: 'This replacement was delivered — the customer has the books, so there is nothing to cancel or refund.' });
    }

    const meta = replacementMeta(repl) || {};
    const originalId = String(meta.original_order_id || '').trim();
    const { data: original } = originalId
      ? await sb.from('orders').select('*').eq('razorpay_order_id', originalId).maybeSingle()
      : { data: null };
    const plan = replacementRefundPlan(repl, original);
    const displayId = repl.razorpay_order_id || repl.id;
    const publicPlan = {
      action: plan.action, reason: plan.reason || null, gateway: plan.gateway || null,
      amount_paise: plan.amountPaise || 0, items: plan.items || [], original_id: originalId || null,
    };

    if (body.dry_run) {
      return json(200, { ok: true, dry_run: true, replacement_id: displayId, status, plan: publicPlan });
    }

    // ── 1. Cancel ──────────────────────────────────────────────────────────
    let courier = null;
    let cancelled = { ok: true, already: status === 'cancelled' };
    if (status !== 'cancelled') {
      const r = await callFunction(event, 'update-order-status', { id: repl.id, status: 'cancelled', tracking_id: '', courier_name: '' });
      if (r.statusCode !== 200) {
        return json(r.statusCode >= 400 && r.statusCode < 500 ? r.statusCode : 502,
          { error: `Could not cancel the replacement: ${r.data.error || 'HTTP ' + r.statusCode}. Nothing was refunded.` });
      }
      courier = r.data.courier || null;
    } else if (repl.tracking_id) {
      // Cancelled earlier (perhaps before this existed): ask the courier again
      // rather than assume. A repeat cancel is harmless.
      courier = await cancelCourierShipment(repl);
    }

    // NimbusPost ships from its own copy, which update-order-status never tells.
    let nimbus = null;
    const courierOk = courier && ['cancelled', 'already_cancelled'].includes(courier.action);
    if (repl.tracking_id && !courierOk && (repl.nimbus_pushed_at || /nimbus/i.test(String(repl.courier_name || '')))) {
      nimbus = await cancelNimbusShipment(repl.tracking_id).catch(e => ({ ok: false, error: e.message }));
    } else if (!repl.tracking_id && repl.nimbus_pushed_at) {
      nimbus = await cancelNimbusOrder(displayId).catch(e => ({ ok: false, error: e.message }));
    }
    const stop = shipmentStopState(repl, { courier, nimbus });
    const result = { ok: true, replacement_id: displayId, cancelled, courier, nimbus, plan: publicPlan };

    // ── 2. Money ───────────────────────────────────────────────────────────
    if (plan.action !== 'gateway') {
      result.refund = { status: plan.action === 'none' ? 'not_owed' : plan.action, message: plan.reason, amount_paise: plan.amountPaise || 0 };
      return json(200, result);
    }
    if (stop.stopped === false) {
      result.refund = { status: 'withheld', amount_paise: plan.amountPaise,
        message: `Not refunded: ${stop.reason} If the customer never gets it, refund ₹${rupees(plan.amountPaise)} on ${originalId} once it is back.` };
      return json(200, result);
    }
    if (stop.stopped === 'unknown' && !body.confirm_stopped) {
      result.refund = { status: 'needs_confirm', amount_paise: plan.amountPaise, message: `${stop.reason} Cancel it there, then confirm to refund ₹${rupees(plan.amountPaise)}.` };
      return json(200, result);
    }

    // Claim before the gateway call: whatever happens next, a second click
    // finds this and stops (replacementRefundPlan → manual).
    await stampMeta(sb, repl.id, { refund_claimed_at: new Date().toISOString(), refund_amount_paise: plan.amountPaise, refund_gateway: plan.gateway });

    const endpoint = plan.gateway === 'razorpay' ? 'razorpay-refund' : 'phonepe-refund';
    const r = await callFunction(event, endpoint, { order_id: originalId, amount_paise: plan.amountPaise, refund_items: plan.items });

    if (r.statusCode === 200 && r.data.success) {
      const ref = r.data.refund_utr || r.data.phonepe_refund_id || r.data.refund_id || null;
      await stampMeta(sb, repl.id, {
        refund_issued_at: new Date().toISOString(),
        refund_state: String(r.data.state || '').toUpperCase() || null,
        ...(ref ? { refund_ref: ref } : {}),
      }, ['refund_claimed_at']).catch(e => console.error('[cancel-replacement] stamp after refund:', e.message));
      result.refund = { status: 'issued', gateway: plan.gateway, amount_paise: plan.amountPaise, state: r.data.state || null, ref, message: r.data.message };
      return json(200, result);
    }

    // Every 400 from the refund functions is a check that failed BEFORE any
    // money moved, so the claim can go. Anything else may have reached the
    // gateway; the claim stays and a person checks before retrying.
    const nothingSent = r.statusCode === 400;
    if (nothingSent) {
      await stampMeta(sb, repl.id, { refund_last_error: String(r.data.error || '').slice(0, 300) }, ['refund_claimed_at'])
        .catch(e => console.error('[cancel-replacement] clear claim:', e.message));
    }
    result.refund = {
      status: 'failed', gateway: plan.gateway, amount_paise: plan.amountPaise,
      message: `Refund of ₹${rupees(plan.amountPaise)} on ${originalId} failed: ${r.data.error || 'HTTP ' + r.statusCode}.`
        + (nothingSent ? ' Nothing was sent.' : ` Check the ${plan.gateway === 'razorpay' ? 'Razorpay' : 'PhonePe'} dashboard before refunding by hand.`),
    };
    return json(200, result);
  } catch (e) {
    console.error('[cancel-replacement]', e);
    return json(500, { error: e.message || 'Could not cancel that replacement' });
  }
};
