'use strict';

/**
 * Pay Later money (utils/pay-later): the Razorpay link sent on delivery, and
 * marking an order paid. Shared by pay-later-scheduled, admin-pay-later and
 * the Razorpay webhook so there is one rule for "this order is paid".
 */
const PL = require('./pay-later');
const notify = require('./pay-later-notify');
const { createRazorpayPaymentLink, fetchPaymentLinkStatus } = require('./razorpay-payment-link');

const idOf = (order) => String(order.razorpay_order_id || order.id);
const refId = (order) => `PL-${idOf(order)}`.slice(0, 40);

/** Writes the new _payment meta, only while the row still has no payment id. */
async function saveMeta(supabase, order, fn, extra = {}) {
  const cart = PL.withMeta(order, fn);
  const { data, error } = await supabase.from('orders')
    .update({ cart_items: cart, ...extra })
    .eq('id', order.id)
    .is('razorpay_payment_id', null)
    .select('id');
  if (error) throw new Error(error.message);
  return Array.isArray(data) && data.length > 0 ? { ...order, cart_items: cart, ...extra } : null;
}

/**
 * Creates (once) and sends the payment link for a delivered Pay Later order.
 * deps lets tests replace Razorpay and the email.
 */
async function sendPayLaterLink(supabase, order, deps = {}) {
  const create = deps.createLink || createRazorpayPaymentLink;
  const email = deps.paymentLinkEmail || notify.paymentLink;
  const meta = PL.payLaterMeta(order);
  if (!meta) return { ok: false, error: 'Not a Pay Later order' };
  if (!PL.isUnpaidPayLater(order)) return { ok: false, error: 'Already paid' };
  if (!(Number(order.amount_paise) >= 100)) return { ok: false, error: 'No amount due' };

  let url = meta.link_url;
  let id = meta.link_id;
  // Due DUE_DAYS after the link goes out, which is when we learn of the delivery.
  const dueAt = meta.due_at || PL.dueDate(new Date().toISOString());
  if (!url) {
    const link = await create({
      amountPaise: Number(order.amount_paise),
      description: `Ink & Chai Pay Later: order ${idOf(order)}`,
      customerName: order.customer_name,
      customerPhone: order.customer_phone,
      referenceId: refId(order),
      notes: { kind: 'pay_later', order_id: idOf(order) },
    });
    url = link.short_url; id = link.id;
  }
  const now = new Date().toISOString();
  const saved = await saveMeta(supabase, order, (m) => ({
    ...m, state: m.state === 'overdue' ? 'overdue' : 'link_sent', link_id: id, link_url: url,
    link_sent_at: now, due_at: dueAt,
  }));
  if (!saved) return { ok: false, error: 'Order changed (already paid?)' };
  const sent = await email(saved, url, dueAt);
  return { ok: true, url, link_id: id, due_at: dueAt, emailed: !!(sent && sent.sent) };
}

/** Marks a Pay Later order paid. paymentId (pay_…) makes it a prepaid order everywhere. */
async function markPayLaterPaid(supabase, order, { paymentId = '', how = 'link', note = '' } = {}, deps = {}) {
  const alert = deps.ownerAlert || notify.ownerAlert;
  if (!PL.isPayLater(order)) return { ok: false, error: 'Not a Pay Later order' };
  if (!PL.isUnpaidPayLater(order)) return { ok: true, already: true };
  const now = new Date().toISOString();
  const saved = await saveMeta(supabase, order,
    (m) => ({ ...m, state: paymentId ? 'paid' : 'paid_manual', paid_at: now, paid_how: how, ...(note ? { paid_note: String(note).slice(0, 300) } : {}) }),
    paymentId ? { razorpay_payment_id: paymentId } : {});
  if (!saved) return { ok: true, already: true };
  await alert(`✅ Pay Later paid: ${idOf(order)} · ₹${Math.round(Number(order.amount_paise) / 100).toLocaleString('en-IN')}${paymentId ? ` (${paymentId})` : ' (marked paid by hand)'}`);
  return { ok: true };
}

/** Asks Razorpay about an outstanding link; marks the order paid if it is. */
async function syncLink(supabase, order, deps = {}) {
  const fetchStatus = deps.fetchLinkStatus || fetchPaymentLinkStatus;
  const meta = PL.payLaterMeta(order);
  if (!meta || !meta.link_id || !PL.isUnpaidPayLater(order)) return { ok: true, skipped: true };
  const st = await fetchStatus(meta.link_id);
  if (st.status === 'paid' && st.paymentId) return markPayLaterPaid(supabase, order, { paymentId: st.paymentId, how: 'link' }, deps);
  return { ok: true, status: st.status };
}

module.exports = { sendPayLaterLink, markPayLaterPaid, syncLink, refId, saveMeta };
