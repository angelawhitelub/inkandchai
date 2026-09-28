/**
 * Prepaid cancellation after the 30-minute window, up to out-for-delivery.
 *
 * THE RULE (owner's decision, 28 Sep 2026)
 * ----------------------------------------
 *   no AWB yet          -> cancelled, FULL refund
 *   AWB booked          -> cancelled, refund minus shipping: Rs 74 per 0.5 kg
 *                          slab, slab from the number of books
 *                            1 book = 0.5 kg  Rs 74     5-6 = 3 kg  Rs 444
 *                            2      = 1 kg    Rs 148    7-8 = 4 kg  Rs 592
 *                            3-4    = 2 kg    Rs 296    9+  = 5 kg  Rs 740
 *   out for delivery,   -> not cancellable ("Cancellation expired")
 *   delivered, RTO
 *
 * WHEN THE MONEY MOVES
 * --------------------
 * Only once the courier has accepted that the parcel is not going to the
 * customer. Refunding first and hoping the parcel comes back is how a customer
 * ends up with the books AND the money.
 *
 *   XpressBees, not picked up  -> /shipments2/cancel, then refund at once
 *   NimbusPost-booked, Delhivery direct
 *                              -> their cancel API (an in-transit cancel is an
 *                                 RTO at the courier), refund once it accepts
 *   anything the API refuses   -> order left as it is, marked awaiting_return,
 *   (XpressBees has no RTO API)   the owner is emailed to raise the RTO, and
 *                                 sweepAwaitingReturn() refunds the moment the
 *                                 courier shows the parcel coming back
 *
 * The 30-minute full-refund cancel and the COD cancel in cancel-order.js are
 * NOT changed by any of this -- this only covers what they refuse.
 *
 * Columns: refund_amount_paise and cancellation_fee_paise already exist on
 * orders; late_cancel_at / late_cancel_state come from
 * sql/orders_late_cancel.sql. Every write fails closed without them.
 */

'use strict';

const { parcelTier } = require('./parcel-tier');
const { interpret } = require('./xpressbees-status');

const SLAB_PAISE = 7400;
const MAX_SLABS = 10;                     // 5 kg
const INSTANT_WINDOW_MS = 30 * 60 * 1000; // cancel-order.js owns the first 30 minutes
// Orders this may cancel. 'shipped' only means an AWB exists; how far the
// parcel has got is read from the courier fields, not from this.
const OPEN_STATUSES = ['paid', 'confirmed', 'processing', 'shipped'];
const MIGRATION = 'sql/orders_late_cancel.sql';

const rs = (paise) => `₹${(Number(paise || 0) / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
const displayIdOf = (o) => o.razorpay_order_id || o.id;

function cartOf(order) {
  let cart = order?.cart_items;
  if (typeof cart === 'string') { try { cart = JSON.parse(cart); } catch { cart = []; } }
  return Array.isArray(cart) ? cart : [];
}

/** 0.5 kg slabs for a parcel of `books`: 1 -> 1, 2 -> 2, then whole kilos, capped at 5 kg. */
function halfKgSlabs(books) {
  const n = Math.max(1, Math.floor(Number(books) || 1));
  if (n === 1) return 1;
  if (n === 2) return 2;
  return Math.min(MAX_SLABS, 2 * Math.ceil(n / 2));
}

/** The shipping charge kept back. Books are counted the way the RTO refunds count them. */
function shippingDeduction(order) {
  const { books } = parcelTier(cartOf(order));
  const n = Math.max(1, books || 0);
  const slabs = halfKgSlabs(n);
  return { books: n, slabKg: slabs / 2, paise: slabs * SLAB_PAISE };
}

function isPartialCod(order) {
  if (String(order?.status || '').toLowerCase() === 'partial_cod_pending') return true;
  if (Number(order?.advance_paid_paise || 0) > 0) return true;
  if (String(order?.shipment_payment_type || '').toLowerCase() === 'partial_cod') return true;
  return cartOf(order).some((i) => {
    const m = i?._payment || i?.__payment || {};
    return String(m.mode || m.payment_type || '').toLowerCase() === 'partial_cod';
  });
}

function isReplacement(order) {
  return String(order?.source || '').toLowerCase() === 'replacement'
    || /^IC-R-/i.test(String(order?.razorpay_order_id || ''))
    || cartOf(order).some((i) => i && i._replacement);
}

/** Paid in full online, shipped as prepaid. Anything else stays on its own rules. */
function isPurePrepaid(order) {
  if (!(Number(order?.amount_paise) > 0)) return false;
  if (!String(order?.razorpay_payment_id || '').trim()) return false;
  if (isPartialCod(order) || isReplacement(order)) return false;
  if (String(order?.shipment_payment_type || '').toLowerCase() === 'cod') return false;
  if (order?.wrong_cod_paise) return false;   // shipped as COD by mistake: its own refund path
  return true;
}

/** What the courier last told us, from whichever courier path recorded it. */
function courierStage(order) {
  for (const raw of [order?.last_courier_status, order?.last_nimbuspost_status]) {
    const s = String(raw || '').toLowerCase();
    if (!s) continue;
    if (/cancel/.test(s) && !/rto/.test(s)) return 'cancelled';
    const v = interpret(s);
    if (v.status) return v.status;           // delivered | out_for_delivery | rto
  }
  return null;
}

/**
 * Can this order be cancelled here, and on what terms? Pure: no I/O.
 * @returns {{eligible:true, hasAwb, books, slabKg, deductionPaise, refundPaise}
 *          | {eligible:false, reason, message}}
 */
function quoteLateCancel(order, now = Date.now()) {
  const no = (reason, message) => ({ eligible: false, reason, message });
  if (!order) return no('not_found', 'Order not found.');
  if (!isPurePrepaid(order)) return no('not_prepaid', 'Only fully prepaid orders can be cancelled this way.');
  if (order.late_cancel_at) return no('already_requested', 'This order has already been cancelled.');

  const status = String(order.status || '').toLowerCase();
  if (!OPEN_STATUSES.includes(status)) {
    return no('closed', status === 'out_for_delivery' || status === 'delivered'
      ? 'Cancellation expired — the order is out for delivery.'
      : 'This order can no longer be cancelled.');
  }
  const stage = courierStage(order);
  if (stage === 'out_for_delivery' || stage === 'delivered') {
    return no('closed', 'Cancellation expired — the order is out for delivery.');
  }
  if (stage === 'rto') return no('closed', 'This parcel is already on its way back to us.');

  const hasAwb = !!String(order.tracking_id || '').trim();
  const created = order.created_at ? new Date(order.created_at).getTime() : 0;
  if (!hasAwb && created && now - created <= INSTANT_WINDOW_MS) {
    return no('instant_window', 'Use Cancel & Refund — this order is still inside its 30-minute window.');
  }

  const amount = Number(order.amount_paise);
  if (!hasAwb) {
    return { eligible: true, hasAwb, books: shippingDeduction(order).books, slabKg: 0, deductionPaise: 0, refundPaise: amount };
  }
  const d = shippingDeduction(order);
  const refund = amount - d.paise;
  if (refund <= 0) return no('nothing_to_refund', 'The shipping charge is more than this order is worth. Please contact us.');
  return { eligible: true, hasAwb, books: d.books, slabKg: d.slabKg, deductionPaise: d.paise, refundPaise: refund };
}

// ── Courier side ────────────────────────────────────────────────────────────

/** Delhivery's own cancel. From In Transit it turns the shipment into an RTO. */
async function cancelDelhiveryWaybill(awb) {
  const token = process.env.DELHIVERY_API_TOKEN;
  if (!token) return { ok: false, error: 'DELHIVERY_API_TOKEN not set' };
  const base = process.env.DELHIVERY_BASE || 'https://track.delhivery.com';
  try {
    const res = await fetch(`${base}/api/p/edit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Token ${token}` },
      body: JSON.stringify({ waybill: String(awb), cancellation: 'true' }),
    });
    const text = await res.text();
    let out; try { out = JSON.parse(text); } catch { out = { raw: text.slice(0, 200) }; }
    if (!res.ok || out.status === false || out.error) {
      return { ok: false, error: String(out.remark || out.error || out.raw || `HTTP ${res.status}`).slice(0, 200) };
    }
    return { ok: true, data: out };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * Ask the courier to stop the parcel.
 * @returns {{outcome:'accepted'|'expired'|'awaiting_return', how:string, detail:string}}
 */
async function stopShipment(order, deps) {
  const awb = String(order.tracking_id).trim();
  const courier = String(order.courier_name || '');
  const notes = [];

  if (/xpress/i.test(courier)) {
    const r = await deps.cancelCourierShipment(order);
    if (r.action === 'cancelled' || r.action === 'already_cancelled') {
      return { outcome: 'accepted', how: 'xpressbees_cancel', detail: r.message };
    }
    if (r.action === 'moving') {
      const live = interpret(r.state).status;
      if (live === 'out_for_delivery' || live === 'delivered') return { outcome: 'expired', how: 'xpressbees', detail: r.message };
      if (live === 'rto') return { outcome: 'accepted', how: 'xpressbees_rto', detail: `XpressBees already shows ${awb} as "${r.state}".` };
      // Picked up: XpressBees has no RTO API. Their support raises it.
      return { outcome: 'awaiting_return', how: 'xpressbees_rto_needed', detail: r.message };
    }
    notes.push(r.message);
    // Not in our XpressBees account: booked through NimbusPost with XpressBees
    // as the carrier. NimbusPost is the one that can cancel it.
    if (!/record not found|not found/i.test(String(r.message || ''))) {
      return { outcome: 'awaiting_return', how: 'xpressbees_error', detail: notes.join(' ') };
    }
  }

  const np = await deps.cancelNimbusShipment(awb);
  if (np.ok) return { outcome: 'accepted', how: 'nimbuspost_cancel', detail: `NimbusPost cancelled ${awb}${np.alreadyCancelled ? ' (already cancelled)' : ''}.` };
  notes.push(`NimbusPost: ${np.error}`);

  if (/delhivery/i.test(courier)) {
    const dl = await deps.cancelDelhivery(awb);
    if (dl.ok) return { outcome: 'accepted', how: 'delhivery_cancel', detail: `Delhivery accepted the cancellation of ${awb} (an in-transit parcel returns as RTO).` };
    notes.push(`Delhivery: ${dl.error}`);
  }
  return { outcome: 'awaiting_return', how: 'manual_rto', detail: notes.join(' · ') };
}

// ── Money side ──────────────────────────────────────────────────────────────

/**
 * Pay back `order.refund_amount_paise`. Never claims completion the gateway has
 * not confirmed: a PhonePe PENDING stays refund_pending, and the retry job
 * (which reads refund_amount_paise) finishes it.
 */
async function issueLateCancelRefund(supabase, order, deps) {
  const displayId = displayIdOf(order);
  const total = Number(order.amount_paise) || 0;
  const amountPaise = Number(order.refund_amount_paise) || 0;
  if (amountPaise <= 0 || amountPaise > total) return { ok: false, error: `refund amount ${amountPaise} is not valid for a ${total} order` };
  const partial = amountPaise < total;
  const done = partial ? 'partially_refunded' : 'refunded';
  const pid = String(order.razorpay_payment_id || '');
  const at = new Date().toISOString();
  const attempts = Math.max(0, Number(order.refund_attempts) || 0);

  const write = async (fields) => {
    const { error } = await supabase.from('orders').update({ refund_updated_at: at, ...fields }).eq('id', order.id);
    if (error) console.error(`[late-cancel] ${displayId} refund write failed:`, error.message);
  };

  if (pid.startsWith('pay_')) {
    let refund;
    try {
      refund = await deps.razorpayRefund(pid, amountPaise, {
        notes: { reason: 'Customer cancelled after dispatch', order_id: displayId },
        supabase,
      });
    } catch (e) {
      await write({ status: 'refund_failed', refund_state: 'FAILED', refund_attempts: attempts + 1,
                    refund_last_error: String(e.message).slice(0, 300), late_cancel_state: 'refund_failed' });
      return { ok: false, provider: 'razorpay', error: e.message };
    }
    if (String(refund.status || '').toLowerCase() === 'failed') {
      await write({ status: 'refund_failed', refund_id: refund.id || null, refund_state: 'FAILED',
                    refund_attempts: attempts + 1, refund_last_error: 'Razorpay returned status=failed', late_cancel_state: 'refund_failed' });
      return { ok: false, provider: 'razorpay', error: 'Razorpay returned status=failed' };
    }
    // 2xx and not failed: committed at Razorpay (same rule as razorpay-refund.js).
    await write({ status: done, refund_id: refund.id || null,
                  refund_state: String(refund.status || 'processed').toUpperCase(), late_cancel_state: 'refunded' });
    await deps.sendRefundInitiated({ ...order, status: done }, amountPaise, { supabase, refundRef: refund.id || null })
      .catch((e) => console.error('[late-cancel] refund notify:', e.message));
    return { ok: true, provider: 'razorpay', completed: true, status: done, refundId: refund.id };
  }

  const res = await deps.phonePeRefund({ displayId, amountPaise, attempt: attempts });
  if (!res.ok) {
    await write({ status: 'refund_failed', refund_id: res.merchantRefundId, refund_state: 'FAILED',
                  refund_attempts: attempts + 1, refund_last_error: String(res.error || '').slice(0, 300),
                  late_cancel_state: 'refund_failed' });
    return { ok: false, provider: 'phonepe', error: res.error };
  }
  const completed = String(res.state || '').toUpperCase() === 'COMPLETED';
  const fields = {
    status: completed ? done : 'refund_pending',
    refund_id: res.merchantRefundId,
    refund_state: completed ? 'COMPLETED' : 'PENDING',
    refund_attempts: attempts + 1,
    late_cancel_state: completed ? 'refunded' : 'refund_pending',
  };
  if (res.refundId) fields.phonepe_refund_id = res.refundId;
  await write(fields);
  if (completed) {
    await deps.sendRefundInitiated({ ...order, ...fields }, amountPaise, { supabase, state: 'COMPLETED', refundRef: res.refundId })
      .catch((e) => console.error('[late-cancel] refund notify:', e.message));
  }
  return { ok: true, provider: 'phonepe', completed, status: fields.status, refundId: res.refundId || res.merchantRefundId };
}

// ── Messages ────────────────────────────────────────────────────────────────

function customerEmailHtml(order, q, outcome) {
  const first = String(order.customer_name || 'there').split(' ')[0];
  const lines = q.deductionPaise
    ? `<tr><td style="padding:6px 0;color:#a09080;">You paid</td><td style="text-align:right;">${rs(order.amount_paise)}</td></tr>
       <tr><td style="padding:6px 0;color:#a09080;">Shipping charge (${q.books} book${q.books > 1 ? 's' : ''}, ${q.slabKg} kg slab)</td><td style="text-align:right;">− ${rs(q.deductionPaise)}</td></tr>
       <tr><td style="padding:8px 0;color:#f0e8d8;border-top:1px solid #2a2a2a;"><strong>Refund</strong></td><td style="text-align:right;border-top:1px solid #2a2a2a;color:#6dbf6d;"><strong>${rs(q.refundPaise)}</strong></td></tr>`
    : `<tr><td style="padding:6px 0;color:#f0e8d8;"><strong>Refund</strong></td><td style="text-align:right;color:#6dbf6d;"><strong>${rs(q.refundPaise)}</strong> (full amount)</td></tr>`;
  const when = outcome === 'awaiting_return'
    ? `Your parcel had already left us, so we have asked the courier to bring it back. <strong style="color:#f0e8d8;">Your refund is sent automatically as soon as the courier confirms it is returning</strong> — you don't need to do anything. If it reaches you before then, please refuse the delivery.`
    : `Your refund is being sent to your original payment method now. Banks usually take 3–7 working days to show it; we'll message you again once it has gone through.`;
  return `
    <div style="background:#0d0b08;color:#f0e8d8;font-family:Georgia,serif;max-width:600px;margin:0 auto;padding:32px;">
      <h1 style="color:#c9a84c;font-size:24px;font-weight:400;margin-bottom:4px;">Ink &amp; Chai</h1>
      <p style="color:#a09080;font-size:12px;letter-spacing:2px;text-transform:uppercase;margin-bottom:32px;">inkandchai.in</p>
      <h2 style="color:#f0e8d8;font-size:20px;font-weight:400;">Order cancelled</h2>
      <p style="color:#a09080;line-height:1.8;">Hi ${first}, order <strong style="color:#c9a84c;">${displayIdOf(order)}</strong> has been cancelled as you asked.</p>
      <table style="width:100%;border-collapse:collapse;font-size:14px;margin:18px 0;">${lines}</table>
      ${q.deductionPaise ? `<p style="color:#a09080;font-size:13px;line-height:1.7;">The order had already been booked with the courier, so the shipping charge is kept back: ₹74 for every 0.5 kg the parcel weighs.</p>` : ''}
      <div style="background:#1c1916;border-left:3px solid #6dbf6d;padding:14px 18px;margin:18px 0;">
        <p style="color:#f0e8d8;margin:0;font-size:14px;line-height:1.7;">${when}</p>
      </div>
      <hr style="border:none;border-top:1px solid #2a2a2a;margin:32px 0;"/>
      <p style="color:#7a6330;font-size:11px;">Questions? Reply to this email or WhatsApp us. Ink &amp; Chai &middot; support@inkandchai.in</p>
    </div>`;
}

function ownerEmail(order, q, stop, refund) {
  const id = displayIdOf(order);
  const needsRto = stop && stop.outcome === 'awaiting_return';
  const refundFailed = refund && !refund.ok;
  const subject = needsRto
    ? `🔁 RTO needed — ${id} cancelled by customer (AWB ${order.tracking_id}, ${order.courier_name || 'courier'})`
    : refundFailed
      ? `⚠ Refund failed — ${id} cancelled by customer, ${rs(q.refundPaise)} owed`
      : `❌ Customer cancelled ${id} — refund ${rs(q.refundPaise)}${q.deductionPaise ? ` (${rs(q.deductionPaise)} shipping kept)` : ''}`;
  const todo = needsRto
    ? `<p><strong>Action:</strong> ask ${order.courier_name || 'the courier'} to RTO AWB <strong>${order.tracking_id}</strong> (their API could not). The refund of ${rs(q.refundPaise)} goes out automatically once tracking shows the parcel returning.</p>`
    : refundFailed
      ? `<p><strong>Action:</strong> the gateway refused the refund (${refund.error}). Refund <strong>${rs(q.refundPaise)}</strong> — not the full amount — from the admin panel or the gateway dashboard.</p>`
      : '';
  const html = `<div style="font-family:Arial,sans-serif;max-width:600px;padding:20px;color:#222;">
    <h2 style="margin:0 0 10px;">${subject}</h2>
    ${todo}
    <table style="font-size:14px;border-collapse:collapse;">
      <tr><td style="padding:3px 12px 3px 0;color:#666;">Order</td><td>${id} · ${order.status}</td></tr>
      <tr><td style="padding:3px 12px 3px 0;color:#666;">Customer</td><td>${order.customer_name || ''} · ${order.customer_phone || ''} · ${order.customer_email || ''}</td></tr>
      <tr><td style="padding:3px 12px 3px 0;color:#666;">Paid</td><td>${rs(order.amount_paise)} (${order.razorpay_payment_id || '—'})</td></tr>
      <tr><td style="padding:3px 12px 3px 0;color:#666;">Kept</td><td>${rs(q.deductionPaise)}${q.deductionPaise ? ` — ${q.books} book(s), ${q.slabKg} kg` : ' (no AWB, full refund)'}</td></tr>
      <tr><td style="padding:3px 12px 3px 0;color:#666;">Refund</td><td>${rs(q.refundPaise)}${refund ? ` — ${refund.ok ? (refund.completed ? 'completed' : 'accepted, pending at gateway') : 'FAILED'}` : ' — waiting for the return'}</td></tr>
      <tr><td style="padding:3px 12px 3px 0;color:#666;">Courier</td><td>${stop ? `${stop.how}: ${stop.detail}` : 'no AWB — nothing booked'}</td></tr>
    </table>
    ${!order.tracking_id ? '<p style="color:#666;font-size:13px;">If this order is sitting in the XpressBees panel queue, cancel that row so it is not booked.</p>' : ''}
  </div>`;
  return { subject, html };
}

async function notifyCustomer(order, q, outcome, deps) {
  if (order.customer_email) {
    await deps.sendEmail({
      to: order.customer_email,
      subject: `Order cancelled — ${displayIdOf(order)} · refund ${rs(q.refundPaise)}`,
      html: customerEmailHtml(order, q, outcome),
    }).catch((e) => console.error('[late-cancel] customer email:', e.message));
  }
  if (order.customer_phone) {
    // The approved order_cancelled body takes [first name, order id]; the
    // amounts are in the email and in the refund message that follows.
    await deps.sendWhatsApp({
      to: order.customer_phone,
      template: process.env.WHATSAPP_ORDER_CANCELLED_TEMPLATE || 'order_cancelled',
      params: [String(order.customer_name || 'there').split(' ')[0], displayIdOf(order)],
    }).catch((e) => console.error('[late-cancel] whatsapp:', e.message));
  }
}

async function notifyOwner(order, q, stop, refund, deps) {
  const to = process.env.STORE_OWNER_EMAIL;
  if (!to) return;
  const { subject, html } = ownerEmail(order, q, stop, refund);
  await deps.sendEmail({ to, subject, html }).catch((e) => console.error('[late-cancel] owner email:', e.message));
}

function defaultDeps() {
  const { sendEmail } = require('./email');
  const { sendWhatsApp } = require('./whatsapp');
  const { cancelCourierShipment, recordCourierCancel } = require('./courier-shipment-cancel');
  const { cancelNimbusShipment, cancelNimbusOrder } = require('./nimbuspost-cancel');
  const { issueRazorpayRefund } = require('./razorpay-refund');
  const { issuePhonePeRefund } = require('./phonepe-refund-core');
  const { sendRefundInitiated } = require('./refund-notifications');
  return {
    sendEmail, sendWhatsApp, cancelCourierShipment, recordCourierCancel, cancelNimbusShipment,
    cancelNimbusOrder, cancelDelhivery: cancelDelhiveryWaybill, razorpayRefund: issueRazorpayRefund,
    phonePeRefund: issuePhonePeRefund, sendRefundInitiated,
  };
}

// ── The customer's click ────────────────────────────────────────────────────

/**
 * Cancel `order` for its customer. Ownership is the caller's job.
 * @returns {{ok:boolean, status:number, outcome?, message, refund_paise?, deduction_paise?}}
 */
async function executeLateCancel(supabase, order, opts = {}, overrides = {}) {
  const deps = { ...defaultDeps(), ...overrides };
  const now = opts.now || Date.now();
  const q = quoteLateCancel(order, now);
  if (!q.eligible) return { ok: false, status: 422, reason: q.reason, message: q.message };

  const at = new Date(now).toISOString();
  // Claim first, atomically: a double click or a second tab must never become
  // a second refund, and a booking that lands mid-request must not be refunded
  // in full as though there were no parcel.
  const claim = {
    late_cancel_at: at,
    late_cancel_state: 'processing',
    cancellation_fee_paise: q.deductionPaise,
    refund_amount_paise: q.refundPaise,
    cancellation_source: 'customer_late',
    cancellation_reason: q.hasAwb ? 'Customer cancelled after dispatch (shipping deducted)' : 'Customer cancelled before dispatch',
  };
  if (!q.hasAwb) Object.assign(claim, { status: 'cancelled', cancelled_at: at });
  let query = supabase.from('orders').update(claim)
    .eq('id', order.id).is('late_cancel_at', null).in('status', OPEN_STATUSES);
  query = q.hasAwb ? query.eq('tracking_id', order.tracking_id) : query.is('tracking_id', null);
  const { data: claimed, error } = await query.select('id').maybeSingle();
  if (error) {
    console.error('[late-cancel] claim failed:', error.message);
    return { ok: false, status: 503, message: /late_cancel/.test(error.message || '')
      ? `Cancellation is not available yet (${MIGRATION} has not been run).`
      : 'Could not cancel this order. Please try again.' };
  }
  if (!claimed) return { ok: false, status: 409, message: 'This order changed while cancelling. Refresh your orders to see its latest status.' };

  let row = { ...order, ...claim };

  // No AWB: nothing is with a courier. Clear the panel row and pay it all back.
  if (!q.hasAwb) {
    const np = await deps.cancelNimbusOrder(displayIdOf(order)).catch((e) => ({ ok: false, error: e.message }));
    if (!np.ok) console.warn(`[late-cancel] ${displayIdOf(order)} NimbusPost panel order not cancelled: ${np.error}`);
    await notifyCustomer(row, q, 'refund', deps);
    const refund = await issueLateCancelRefund(supabase, row, deps);
    await notifyOwner(row, q, null, refund, deps);
    return { ok: true, status: 200, outcome: 'refund', refund, refund_paise: q.refundPaise, deduction_paise: 0,
             message: `Order cancelled. Your full refund of ${rs(q.refundPaise)} is on its way.` };
  }

  const stop = await stopShipment(row, deps);

  if (stop.outcome === 'expired') {
    // It went out for delivery while they were deciding. Undo the claim.
    await supabase.from('orders').update({
      late_cancel_at: null, late_cancel_state: null, cancellation_fee_paise: null,
      refund_amount_paise: null, cancellation_source: null, cancellation_reason: null,
    }).eq('id', order.id);
    return { ok: false, status: 422, reason: 'closed', message: 'Cancellation expired — the order is already out for delivery.' };
  }

  if (stop.outcome === 'awaiting_return') {
    await supabase.from('orders').update({ late_cancel_state: 'awaiting_return' }).eq('id', order.id);
    row = { ...row, late_cancel_state: 'awaiting_return' };
    await notifyCustomer(row, q, 'awaiting_return', deps);
    await notifyOwner(row, q, stop, null, deps);
    return { ok: true, status: 200, outcome: 'awaiting_return', refund_paise: q.refundPaise, deduction_paise: q.deductionPaise,
             message: `Order cancelled. Your parcel is already on its way, so we've asked the courier to return it — your refund of ${rs(q.refundPaise)} (after ${rs(q.deductionPaise)} shipping) is sent automatically once it's coming back.` };
  }

  // The courier accepted: the parcel is not going to the customer.
  if (stop.how === 'xpressbees_cancel') await deps.recordCourierCancel(supabase, order.id, { action: 'cancelled' });
  await supabase.from('orders').update({ status: 'cancelled', cancelled_at: at }).eq('id', order.id);
  row = { ...row, status: 'cancelled', cancelled_at: at };
  await notifyCustomer(row, q, 'refund', deps);
  const refund = await issueLateCancelRefund(supabase, row, deps);
  await notifyOwner(row, q, stop, refund, deps);
  return { ok: true, status: 200, outcome: 'refund', refund, refund_paise: q.refundPaise, deduction_paise: q.deductionPaise,
           message: `Order cancelled. Your refund of ${rs(q.refundPaise)} (after ${rs(q.deductionPaise)} shipping) is on its way.` };
}

// ── The return, seen later ──────────────────────────────────────────────────

/**
 * Refund every awaiting_return order whose parcel the courier now shows coming
 * back (RTO, or the AWB cancelled). Delivered anyway: no refund, owner told.
 * Called from the XpressBees status sync, which runs every 15 minutes; the
 * NimbusPost webhook moves those orders to 'rto' on its own.
 */
async function sweepAwaitingReturn(supabase, opts = {}, overrides = {}) {
  const deps = { ...defaultDeps(), ...overrides };
  const out = { refunded: [], delivered: [], waiting: 0, errors: [] };
  const { data, error } = await supabase.from('orders').select('*')
    .eq('late_cancel_state', 'awaiting_return').limit(opts.limit || 25);
  if (error) {
    // Before the migration there is nothing to sweep.
    if (!/late_cancel/.test(error.message || '')) out.errors.push(error.message);
    return out;
  }
  for (const o of data || []) {
    const id = displayIdOf(o);
    const status = String(o.status || '').toLowerCase();
    const stage = courierStage(o);
    const returning = ['rto', 'rto_delivered'].includes(status) || stage === 'rto' || stage === 'cancelled';

    if (status === 'delivered' || (!returning && stage === 'delivered')) {
      if (opts.dryRun) { out.delivered.push(id); continue; }
      await supabase.from('orders').update({ late_cancel_state: 'delivered_anyway' })
        .eq('id', o.id).eq('late_cancel_state', 'awaiting_return');
      const to = process.env.STORE_OWNER_EMAIL;
      if (to) {
        await deps.sendEmail({
          to, subject: `⚠ ${id} was delivered after the customer cancelled — no refund sent`,
          html: `<p>${id} (AWB ${o.tracking_id}, ${o.courier_name || ''}) was cancelled by the customer on ${o.late_cancel_at}, `
              + `but the courier delivered it. The ${rs(o.refund_amount_paise)} refund was NOT sent. Decide with the customer.</p>`,
        }).catch(() => {});
      }
      out.delivered.push(id);
      continue;
    }
    if (!returning) { out.waiting += 1; continue; }
    if (opts.dryRun) { out.refunded.push({ order: id, would_refund_rs: o.refund_amount_paise / 100 }); continue; }

    // One refund per order, however many sweeps see it.
    const { data: mine } = await supabase.from('orders').update({ late_cancel_state: 'refunding' })
      .eq('id', o.id).eq('late_cancel_state', 'awaiting_return').select('id').maybeSingle();
    if (!mine) continue;
    try {
      const refund = await issueLateCancelRefund(supabase, { ...o, late_cancel_state: 'refunding' }, deps);
      out.refunded.push({ order: id, rs: o.refund_amount_paise / 100, ok: refund.ok, completed: !!refund.completed, error: refund.error });
      if (!refund.ok) {
        const q = { deductionPaise: Number(o.cancellation_fee_paise) || 0, refundPaise: Number(o.refund_amount_paise) || 0, books: '?', slabKg: '?' };
        await notifyOwner(o, q, null, refund, deps);
      }
    } catch (e) {
      out.errors.push(`${id}: ${e.message}`);
    }
  }
  return out;
}

module.exports = {
  quoteLateCancel, executeLateCancel, sweepAwaitingReturn, issueLateCancelRefund,
  shippingDeduction, halfKgSlabs, isPurePrepaid, courierStage, cancelDelhiveryWaybill,
  SLAB_PAISE, OPEN_STATUSES,
};
