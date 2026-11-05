/**
 * Cancel a return from the admin panel.
 *
 * Customers change their mind ("I want to cancel the return for IC-…"), and the
 * only cancel we had was the customer's own, which works before a return is
 * approved. Every return is approved at once now, so that was never reachable.
 *
 * What makes this safe to press:
 *   - The courier is asked first. A pickup is voided only while the courier
 *     positively says it is still waiting. Once the parcel has moved, the return
 *     stays open: the books are coming back and the customer is owed for them.
 *   - The row is claimed BEFORE the courier call, so a row we cannot write never
 *     leaves a voided pickup behind, and put back if the courier refuses.
 *   - Status 'cancelled' stops the refund: utils/return-auto-refund.js and the
 *     tracking job both skip it, and refund_status moves off the value they look
 *     for. Nothing is cancelled once money has gone out.
 *
 * The customer is told by email and WhatsApp once the cancel has gone through
 * (notifyReturnCancelled). The claim on the row makes that once only: a second
 * press is refused before it gets that far.
 */

// The parcel is with the courier, so it is on its way to us.
const MOVED = new Set(['picked_up', 'in_transit', 'out_for_delivery', 'delivered']);
// Still at the customer's address, so the courier can void it.
const VOIDABLE = new Set(['awaiting_pickup', 'pickup_failed']);
// Nothing left at the courier to void.
const NOTHING_TO_VOID = new Set(['cancelled', 'returned_to_customer']);

const SETTLED_REFUNDS = new Set(['refunding', 'refunded', 'completed', 'wallet_issued', 'manual_refund_pending']);

// auto-return-pickup books straight after the request and writes its AWB without
// checking the status, so a cancel inside this window would be overwritten.
const BOOKING_WINDOW_MS = 3 * 60 * 1000;

function whyNotCancellable(ret, nowMs = Date.now()) {
  const status = String(ret?.status || '').toLowerCase();
  if (status === 'cancelled') return 'This return is already cancelled.';
  if (status === 'rejected') return 'This return was rejected, so there is nothing to cancel.';
  if (ret.return_delivered_at) return 'The books are already back with us, so this return cannot be cancelled.';
  if (ret.refunded_at || SETTLED_REFUNDS.has(ret.refund_status)) {
    return `The refund has already started (${ret.refund_status || 'paid'}), so this return cannot be cancelled.`;
  }
  const age = nowMs - Date.parse(ret.created_at || 0);
  if (status === 'approved' && !ret.awb && age >= 0 && age < BOOKING_WINDOW_MS) {
    return 'The courier pickup is still being booked. Try again in a few minutes.';
  }
  return '';
}

function closingFields(ret, note, nowIso) {
  const fields = { status: 'cancelled' };
  if (ret.refund_status || ret.refund_method) fields.refund_status = 'cancelled';
  if (ret.awb) {
    fields.tracking_status = 'cancelled';
    fields.tracking_last_scan = note;
    fields.tracking_checked_at = nowIso;
  }
  return fields;
}

async function casUpdate(db, id, fromStatus, fields) {
  const { data, error } = await db.from('return_requests')
    .update(fields).eq('id', id).eq('status', fromStatus).select('id');
  if (error) return { ok: false, error: error.message };
  return { ok: !!(data && data.length), error: data && data.length ? '' : 'it changed while cancelling' };
}

/**
 * @param {object} ret   the return_requests row
 * @param {object} opts  force: close on our side though the courier did not void it
 * @param {object} deps  trackReturns, cancelAtCourier, now (tests)
 * @returns {{ok, http, message, can_force?, courier_cancelled?}}
 */
async function cancelReturn(db, ret, opts = {}, deps = {}) {
  const nowMs = deps.now ? deps.now() : Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const refused = whyNotCancellable(ret, nowMs);
  if (refused) return { ok: false, http: 400, message: refused };

  const id = ret.id;
  const prev = ret.status;
  const awb = String(ret.awb || '').trim();

  const close = async (note, message, extra = {}) => {
    const out = await casUpdate(db, id, prev, closingFields(ret, note, nowIso));
    if (!out.ok) return { ok: false, http: 409, message: `Could not cancel this return: ${out.error}.` };
    return { ok: true, http: 200, status: 'cancelled', message, ...extra };
  };

  if (!awb) {
    const panel = prev === 'pushed_to_nimbus'
      ? ` A reverse order may still sit in the NimbusPost panel under R-RET-${String(ret.order_display_id || '').replace(/^IC-/, '')}. It has no AWB, so no courier is coming; just do not ship it.`
      : '';
    const post = /india post/i.test(String(ret.courier_name || ''))
      ? ' The customer was asked to send this by India Post, so check they have not posted it already.'
      : '';
    return close('', `Return cancelled. No pickup was booked, and no refund or store credit will be issued.${panel}${post}`);
  }

  const track = deps.trackReturns || require('./return-tracking').trackReturns;
  let view = null;
  try { view = (await track([awb])).get(awb) || null; } catch (e) { view = { stage: 'unknown', error: e.message }; }
  const stage = view?.stage || 'unknown';
  const said = view?.status || view?.last_scan || '';

  if (MOVED.has(stage)) {
    return {
      ok: false, http: 409,
      message: `Not cancelled: AWB ${awb} has already left the customer (${said || stage}). The books are on their way back to us and the customer is still owed for them.`,
    };
  }

  if (NOTHING_TO_VOID.has(stage)) {
    return close(`Return cancelled from admin (courier: ${said || stage})`,
      `Return cancelled. AWB ${awb} needed no courier call (${said || stage}), and no refund or store credit will be issued.`);
  }

  if (opts.force) {
    return close('Return cancelled from admin; courier not cancelled',
      `Closed on our side only. AWB ${awb} was NOT cancelled with the courier, so a courier may still come and the customer should refuse the pickup. If the parcel does come back, no refund runs for it automatically.`,
      { courier_cancelled: false });
  }

  if (!VOIDABLE.has(stage) || !view?.source) {
    return {
      ok: false, http: 409, can_force: true,
      message: `Not cancelled: no courier could confirm AWB ${awb} is still waiting for pickup${view?.error ? ` (${String(view.error).slice(0, 160)})` : said ? ` (${said})` : ''}.`,
    };
  }

  // Claim first: a row we cannot write must not leave a voided pickup behind.
  const claim = await casUpdate(db, id, prev, closingFields(ret, `Return cancelled from admin (${view.source})`, nowIso));
  if (!claim.ok) return { ok: false, http: 409, message: `Could not cancel this return: ${claim.error}. The courier was not contacted.` };

  const cancelAtCourier = deps.cancelAtCourier || require('./pickup-live').cancelAtCourier;
  // courier_name here must be the channel that answered, not the row's label:
  // reverse pickups booked through NimbusPost can carry an XpressBees name.
  const outcome = await cancelAtCourier(
    { tracking_id: awb, courier_name: view.source === 'xpressbees' ? 'XpressBees' : ret.courier_name },
    { channel: view.source },
    deps,
  );

  if (!outcome.ok) {
    const back = await casUpdate(db, id, 'cancelled', {
      status: prev,
      refund_status: ret.refund_status ?? null,
      ...(ret.awb ? {
        tracking_status: ret.tracking_status ?? null,
        tracking_last_scan: ret.tracking_last_scan ?? null,
        tracking_checked_at: ret.tracking_checked_at ?? null,
      } : {}),
    });
    return {
      ok: false, http: 409, can_force: !!back.ok,
      message: `Not cancelled: ${outcome.message}${back.ok ? '' : ` This return could not be put back to "${prev}" (${back.error}), so it shows cancelled although the courier did not void the pickup.`}`,
    };
  }

  // A courier saying yes is not proof: XpressBees' panel Cancel reports success
  // and sends nothing. Read it back and say what it shows.
  let after = '';
  try {
    const v = (await track([awb])).get(awb);
    if (v && v.stage !== 'cancelled') after = ` Its tracking still shows "${v.status || v.last_scan || v.stage}", which can lag; if a courier still comes, the customer should refuse the pickup.`;
  } catch (_) { /* the cancel itself succeeded */ }

  return {
    ok: true, http: 200, status: 'cancelled', courier_cancelled: true,
    message: `Return cancelled. ${outcome.message} No refund or store credit will be issued.${after}`,
  };
}

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const firstNameOf = (name) => String(name || '').trim().split(/\s+/)[0] || 'there';

function cancelledCopy(ret) {
  const oid = String(ret.order_display_id || ret.order_id || '');
  return {
    oid,
    first: firstNameOf(ret.customer_name),
    main: `your return for order ${oid} has been cancelled. You keep the books, and no refund or store credit will be issued for this return.`,
    // Tracking can lag, and a forced close leaves the pickup live.
    courier: ret.awb ? "If a courier comes for the pickup, you don't need to hand anything over." : '',
  };
}

/**
 * Tell the customer, after the cancel has gone through. Each channel is tried on
 * its own and reported back; this never throws, because the return is already
 * cancelled and a failed message must not read as a failed cancel.
 *
 * WhatsApp uses WHATSAPP_RETURN_CANCELLED_TEMPLATE ({{1}} first name, {{2}} order id)
 * once that is set. Until then it is plain text, which Meta only delivers inside
 * the 24 hours after the customer last messaged us, and it answers 200 either way.
 */
async function notifyReturnCancelled(ret, deps = {}) {
  const sendEmail = deps.sendEmail || require('./email').sendEmail;
  const { sendWhatsApp, sendText } = deps.whatsapp || require('./whatsapp');
  const template = deps.template !== undefined ? deps.template : process.env.WHATSAPP_RETURN_CANCELLED_TEMPLATE;
  const c = cancelledCopy(ret);
  const result = { email: null, whatsapp: null };

  if (ret.customer_email) {
    try {
      await sendEmail({
        to: ret.customer_email,
        subject: `Your return has been cancelled (${c.oid})`,
        html: `<div style="font-family:Georgia,serif;color:#3a2f25;max-width:520px;margin:0 auto;">
    <h2 style="color:#8a6a1f;">Return cancelled</h2>
    <p>Hi ${esc(c.first)},</p>
    <p>${esc(c.main)}</p>
    ${c.courier ? `<p>${esc(c.courier)}</p>` : ''}
    <p>If this isn't what you wanted, message us on WhatsApp and we'll help.</p>
    <p style="color:#6f6255;font-size:13px;">Thank you,<br>Ink &amp; Chai</p>
  </div>`,
      });
      result.email = { ok: true, to: ret.customer_email };
    } catch (e) {
      result.email = { ok: false, error: e.message };
    }
  } else {
    result.email = { ok: false, skipped: 'no email on record' };
  }

  if (ret.customer_phone) {
    try {
      const wa = template
        ? await sendWhatsApp({ to: ret.customer_phone, template, params: [c.first, c.oid] })
        : await sendText(ret.customer_phone, `Hi ${c.first}, ${c.main}${c.courier ? ` ${c.courier}` : ''} If this isn't what you wanted, reply here and we'll help.`);
      result.whatsapp = wa?.ok
        ? { ok: true, to: ret.customer_phone, ...(template ? {} : { note: 'plain text: arrives only if they messaged us in the last 24 hours' }) }
        : { ok: false, to: ret.customer_phone, error: wa?.data?.error?.message || wa?.error || (wa?.skipped ? 'not sent' : `status ${wa?.status || '?'}`) };
    } catch (e) {
      result.whatsapp = { ok: false, to: ret.customer_phone, error: e.message };
    }
  } else {
    result.whatsapp = { ok: false, skipped: 'no phone on record' };
  }

  console.log(`[return-cancel] notify ${c.oid}: email=${result.email.ok ? 'sent' : 'not sent'} whatsapp=${result.whatsapp.ok ? (template ? 'template' : 'text') : 'not sent'}`);
  return result;
}

module.exports = { cancelReturn, whyNotCancellable, notifyReturnCancelled };
