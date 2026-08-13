/**
 * Refund-initiated notifications — email + WhatsApp.
 *
 * Fires ONCE per order (guarded by orders.refund_notified_at) as soon as we
 * confirm the refund has been accepted by the payment gateway (state PENDING
 * or COMPLETED). Tells the customer:
 *   • refund has been initiated
 *   • amount refunded
 *   • usually reflects in 2-3 business days in their original payment method
 *
 * Matches the existing WhatsApp Business template `refund_processed` (already
 * approved in the Meta panel):
 *   Body: "Hi {{1}}, your refund for order {{2}} of Rs {{3}} has been issued
 *          to your PhonePe payment method. It will reflect in your account
 *          within 5–7 business days. Thank you, Ink & Chai."
 * Params:
 *   {{1}} customer first name
 *   {{2}} order id (IC-YYYYMMDD-XXXXX)
 *   {{3}} amount as a plain number (the template supplies "Rs " itself)
 */

const { sendEmail } = require('./email');
const { sendWhatsApp } = require('./whatsapp');

function firstName(name) {
  return String(name || 'there').trim().split(/\s+/)[0] || 'there';
}

/**
 * Normalise the refunded-items list into [{title, qty, amount}].
 *
 * The admin's refund modal sends what was ticked; hand-typed amounts send
 * nothing. Anything unusable is dropped rather than guessed at — a partial
 * refund that cannot name its books falls back to amount-only wording, which is
 * the old behaviour and always correct, just less specific.
 */
function cleanRefundItems(items) {
  if (!Array.isArray(items)) return [];
  return items
    .map(i => ({
      title: String(i?.title || '').replace(/\s+/g, ' ').trim().slice(0, 120),
      qty: Math.max(1, Math.min(99, Math.round(Number(i?.qty) || 1))),
      amount: Math.max(0, Math.round(Number(i?.amount) || 0)),
    }))
    .filter(i => i.title)
    .slice(0, 12);
}

/** "James ×1, Taiwan Travelogue ×2" — one line, for the WhatsApp body. */
function refundItemsLine(items) {
  return cleanRefundItems(items)
    .map(i => (i.qty > 1 ? `${i.title} ×${i.qty}` : i.title))
    .join(', ');
}

// Human label for the gateway state, if we have it.
function stateLabel(state) {
  const s = String(state || '').toLowerCase();
  if (s === 'processed' || s === 'completed') return 'Completed (settled)';
  if (s === 'pending')                        return 'Pending (accepted, settling in 2–7 days)';
  if (s === 'failed')                         return 'Failed';
  return state ? String(state) : 'Accepted by gateway';
}

function ownerRefundEmailHtml(order, amtPaise, { provider, refundId, state, items } = {}) {
  const amt = `₹${rupees(amtPaise)}`;
  const oid = order.razorpay_order_id || order.id || '';
  const covers = refundItemsLine(items);
  return `<div style="background:#0d0b08;color:#f0e8d8;font-family:Georgia,serif;max-width:600px;margin:0 auto;padding:32px;">
    <h1 style="color:#c9a84c;font-size:22px;font-weight:400;margin-bottom:4px;">Ink &amp; Chai</h1>
    <p style="color:#a09080;font-size:12px;letter-spacing:2px;text-transform:uppercase;margin-bottom:24px;">Admin notification</p>
    <h2 style="color:#6dbf6d;font-size:20px;font-weight:400;">💸 Refund issued</h2>
    <table style="font-size:14px;line-height:1.9;color:#f0e8d8;margin:10px 0;">
      <tr><td style="color:#a09080;padding-right:16px;">Order</td><td><strong style="color:#c9a84c;">${oid}</strong></td></tr>
      <tr><td style="color:#a09080;padding-right:16px;">Customer</td><td>${order.customer_name || '—'}</td></tr>
      <tr><td style="color:#a09080;padding-right:16px;">Amount</td><td><strong style="color:#6dbf6d;">${amt}</strong></td></tr>
      <tr><td style="color:#a09080;padding-right:16px;">Via</td><td>${provider || (String(order.razorpay_payment_id||'').startsWith('pay_') ? 'Razorpay' : 'PhonePe')}</td></tr>
      ${refundId ? `<tr><td style="color:#a09080;padding-right:16px;">Refund ref</td><td style="font-family:Menlo,Consolas,monospace;">${refundId}</td></tr>` : ''}
      ${covers ? `<tr><td style="color:#a09080;padding-right:16px;">Covers</td><td>${covers}</td></tr>` : ''}
      <tr><td style="color:#a09080;padding-right:16px;">Status</td><td>${stateLabel(state)}</td></tr>
    </table>
    <p style="color:#a09080;font-size:12px;line-height:1.7;margin-top:16px;">The customer has been notified by email + WhatsApp. Normal-speed refunds settle in 2–7 business days.</p>
    <hr style="border:none;border-top:1px solid #2a2a2a;margin:28px 0;"/>
    <p style="color:#7a6330;font-size:11px;">Sent to the store owner &middot; inkandchai.in</p>
  </div>`;
}

/**
 * Email the store owner that a refund was successfully issued. Best-effort,
 * never throws. No-ops if STORE_OWNER_EMAIL is unset.
 */
async function notifyOwnerRefund(order, amountPaise, meta = {}) {
  const ownerEmail = process.env.STORE_OWNER_EMAIL;
  if (!ownerEmail || !order || amountPaise <= 0) return { sent: false };
  const oid = order.razorpay_order_id || order.id || '';
  const amt = `₹${rupees(amountPaise)}`;
  try {
    const r = await sendEmail({
      to: ownerEmail,
      subject: `💸 Refund issued ${oid} — ${amt}`,
      html: ownerRefundEmailHtml(order, amountPaise, meta),
    });
    return { sent: !!r?.ok };
  } catch (e) {
    console.error('owner refund email:', e.message);
    return { sent: false };
  }
}

/** "View your order" button — the same destination as the WhatsApp button. */
function orderButtonHtml(oid) {
  if (!oid) return '';
  return `<p style="margin:20px 0;">
      <a href="https://inkandchai.in/track/?id=${encodeURIComponent(oid)}"
         style="display:inline-block;background:#8a6a1f;color:#faf7f2;text-decoration:none;padding:11px 22px;font-size:14px;border-radius:2px;">View your order →</a>
    </p>`;
}

function refundInitiatedEmailHtml(order, amtPaise, refundRef) {
  const amt = `₹${rupees(amtPaise)}`;
  const oid = order.razorpay_order_id || order.id || '';
  // Payment-gateway reference for the refund. Customers whose bank is slow can
  // quote this to their bank to trace the credit, so surface it when we have it.
  const ref = resolveRefundRef(order, refundRef);
  return `<div style="font-family:Georgia,serif;color:#3a2f25;max-width:520px;margin:0 auto;padding:24px;background:#faf7f2;">
    <h2 style="font-family:Georgia,serif;font-weight:400;color:#8a6a1f;margin:0 0 12px;">Your refund is on its way 💚</h2>
    <p>Hi ${firstName(order.customer_name)},</p>
    <p>We've initiated a refund of <strong>${amt}</strong> for your order <strong>${oid}</strong>.</p>
    ${ref ? `<p style="background:#f2ece1;padding:10px 14px;border-left:3px solid #8a6a1f;">
      <strong>Refund reference:</strong> <span style="font-family:Menlo,Consolas,monospace;">${ref}</span><br>
      <span style="font-size:12px;color:#6f6255;">Quote this to your bank if you need to trace the credit.</span>
    </p>` : ''}
    ${orderButtonHtml(oid)}
    <p><strong>Timeline:</strong> the amount will reflect in your original payment method within <strong>2–3 business days</strong>. Some banks may take a little longer — up to 5–7 business days in rare cases.</p>
    <p>You don't need to do anything from your side. Once the money reaches your bank, you'll see it as a credit against the original transaction.</p>
    <p style="color:#6f6255;font-size:13px;margin-top:24px;">If you don't see the refund after 7 business days, just reply to this email or WhatsApp us at +91 76784 00508 with your Order ID and we'll chase it with our payment provider right away.</p>
    <p style="color:#6f6255;font-size:13px;">Thank you for shopping with us,<br>Ink &amp; Chai</p>
  </div>`;
}

/**
 * The gateway's own reference for this refund — what the customer quotes to
 * their bank, and the only id that means anything to PhonePe/Razorpay support.
 *
 * Preference order matters: `refundRef` is what the caller just got back from
 * the gateway, `phonepe_refund_id` is PhonePe's, and `refund_id` holds
 * Razorpay's rfnd_… Returns null rather than '' — Meta rejects an empty
 * template parameter outright, so callers must be able to test for absence.
 */
function resolveRefundRef(order, refundRef) {
  // Preference order is "what can the customer's bank actually act on":
  //   1. the UTR — the bank rail reference, traceable by their bank
  //   2. the gateway's own refund id — traceable by PhonePe/Razorpay support
  //   3. our merchantRefundId (REFUND-IC-…-A0) — a last resort, meaningless
  //      outside this codebase, and for a while it was what customers were
  //      told to quote to their bank.
  const ref = refundRef || order?.refund_utr || order?.phonepe_refund_id || order?.refund_id || '';
  return String(ref).replace(/\s+/g, '').trim().slice(0, 64) || null;
}

/**
 * WhatsApp for a refund.
 *
 * Templates are tried in order of how much they tell the customer, and the
 * first one Meta accepts wins. That fallthrough is the point: a template that
 * has not been approved yet is rejected at send time, so this ships working
 * code today and gets better on its own the moment each template goes live —
 * no redeploy, no flag to remember to flip.
 *
 *   1. refund_partial       partial, itemised, with reference   (5 vars + button)
 *   2. refund_processed_ref full/unitemised, with reference     (4 vars + button)
 *   3. refund_processed     the long-approved fallback          (3 vars, no button)
 *
 * TWO NEW TEMPLATES REQUIRED in Meta Business Manager. Both must be category
 * UTILITY (a Marketing-category template is suppressed for anyone who opted out
 * of marketing, and a refund notice must always reach them), a SINGLE paragraph
 * with no blank lines, and variables in ascending order — the three things the
 * panel rejects. Each needs a URL button of type "Visit website" → "Dynamic":
 *
 *   https://inkandchai.in/track/?id={{1}}
 *
 * refund_partial — body:
 *   Hi {{1}}, a partial refund of Rs {{3}} for your order {{2}} has been issued.
 *   This covers: {{4}}. Reference: {{5}}. It will reflect in your original
 *   payment method within 2-3 business days. The rest of your order is
 *   unaffected. Thank you, Ink & Chai.
 *
 * refund_processed_ref — body:
 *   Hi {{1}}, your refund of Rs {{3}} for order {{2}} has been issued.
 *   Reference: {{4}}. It will reflect in your original payment method within
 *   2-3 business days. Thank you, Ink & Chai.
 *
 * A partial refund with no gateway reference falls through to a full-refund
 * template and loses the book names on WhatsApp. That combination is rare (it
 * means an admin marked the order refunded by hand rather than calling a
 * gateway), and the EMAIL still carries the full per-book breakdown, which
 * needs nobody's approval.
 */
async function sendRefundWhatsApp({ order, oid, amtPlain, isPartial, itemsLine, refundRef }) {
  const name = firstName(order.customer_name);
  const id = String(oid || '');
  // Deep link for the template's URL button: /track/?id={{1}}. Only the order
  // id goes in the URL — never the customer's phone or email, which would then
  // sit in server logs and would open the order for anyone the message is
  // forwarded to. The track page still verifies ownership before showing it.
  const button = id;

  const candidates = [];
  if (isPartial && itemsLine && refundRef) {
    candidates.push({ template: 'refund_partial', params: [name, id, amtPlain, itemsLine, refundRef], button });
  }
  if (refundRef) {
    candidates.push({ template: 'refund_processed_ref', params: [name, id, amtPlain, refundRef], button });
  }
  candidates.push({ template: 'refund_processed', params: [name, id, amtPlain] });

  let last = null;
  for (const c of candidates) {
    const res = await sendWhatsApp({
      to: order.customer_phone,
      template: c.template,
      params: c.params,
      ...(c.button ? { urlButtonParam: c.button } : {}),
    });
    if (res?.ok) return res;
    // A missing token or an unusable phone number fails every template equally —
    // walking the rest of the list would just repeat the same error three times.
    if (res?.skipped) return res;
    last = res;
    console.warn(`[refund] template ${c.template} rejected (${JSON.stringify(res?.data?.error || res?.error || '').slice(0, 200)}) — trying the next one. Create/approve "${c.template}" in Meta Business Manager to use it.`);
  }
  return last;
}

/**
 * PARTIAL refund email. Deliberately a separate template from the full-refund
 * one above: the two say different things. A customer who gets ₹239 back on a
 * ₹592 order needs to know which book that was for and that the rest of the
 * order is unaffected — the full-refund wording implies the whole order is
 * being unwound, which would be wrong and would generate a support reply.
 */
function refundPartialEmailHtml(order, amtPaise, refundRef, items) {
  const amt = `₹${rupees(amtPaise)}`;
  const oid = order.razorpay_order_id || order.id || '';
  const total = Number(order.amount_paise) || 0;
  const rest = total > amtPaise ? `₹${rupees(total - amtPaise)}` : null;
  const ref = resolveRefundRef(order, refundRef);
  const list = cleanRefundItems(items);

  const itemsBlock = list.length ? `
    <p style="margin-bottom:6px;"><strong>What this refund covers:</strong></p>
    <table style="width:100%;border-collapse:collapse;font-size:14px;margin:0 0 16px;">
      ${list.map(i => `<tr>
        <td style="padding:7px 10px;border-bottom:1px solid #e6ddcd;">${i.title}${i.qty > 1 ? ` <span style="color:#6f6255;">×${i.qty}</span>` : ''}</td>
        <td style="padding:7px 10px;border-bottom:1px solid #e6ddcd;text-align:right;white-space:nowrap;"><strong>₹${rupees(Math.round((Number(i.amount) || 0) * 100))}</strong></td>
      </tr>`).join('')}
    </table>`
    : '';

  return `<div style="font-family:Georgia,serif;color:#3a2f25;max-width:520px;margin:0 auto;padding:24px;background:#faf7f2;">
    <h2 style="font-family:Georgia,serif;font-weight:400;color:#8a6a1f;margin:0 0 12px;">A partial refund is on its way 💚</h2>
    <p>Hi ${firstName(order.customer_name)},</p>
    <p>We've initiated a refund of <strong>${amt}</strong> on your order <strong>${oid}</strong>.</p>
    ${itemsBlock}
    ${rest ? `<p style="background:#f2ece1;padding:10px 14px;border-left:3px solid #8a6a1f;">
      This is a <strong>partial</strong> refund. The rest of your order (${rest}) is unaffected — anything still to be delivered is on its way as normal.
    </p>` : ''}
    ${ref ? `<p style="background:#f2ece1;padding:10px 14px;border-left:3px solid #8a6a1f;">
      <strong>Refund reference:</strong> <span style="font-family:Menlo,Consolas,monospace;">${ref}</span><br>
      <span style="font-size:12px;color:#6f6255;">Quote this to your bank if you need to trace the credit.</span>
    </p>` : ''}
    ${orderButtonHtml(oid)}
    <p><strong>Timeline:</strong> the amount will reflect in your original payment method within <strong>2–3 business days</strong>. Some banks may take a little longer — up to 5–7 business days in rare cases.</p>
    <p style="color:#6f6255;font-size:13px;margin-top:24px;">If you don't see it after 7 business days, reply to this email or WhatsApp us at +91 76784 00508 with your Order ID and we'll chase it with our payment provider.</p>
    <p style="color:#6f6255;font-size:13px;">Thank you for shopping with us,<br>Ink &amp; Chai</p>
  </div>`;
}

/**
 * Send refund-initiated notifications to the customer.
 *
 * @param {object} order       Full orders row (needs customer_email, customer_phone, customer_name, razorpay_order_id/id)
 * @param {number} amountPaise Amount refunded, in paise
 * @param {object} [opts]
 * @param {object} [opts.supabase]  Supabase client — if provided, stamps refund_notified_at + skips if already stamped
 * @param {string} [opts.state]     Confirmed gateway refund state. When provided and NOT 'COMPLETED',
 *                                  the notification is suppressed. This is the money-safety backstop:
 *                                  a PhonePe refund can return PENDING and then fail asynchronously
 *                                  (merchant-balance policy), so we must never promise a refund that
 *                                  hasn't actually completed. Razorpay callers omit state (their
 *                                  refunds settle reliably once created) and keep the old behaviour.
 * @returns {Promise<{sent: boolean, skipped?: string}>}
 */
async function sendRefundInitiated(order, amountPaise, { supabase, state, refundRef, items } = {}) {
  if (!order || amountPaise <= 0) return { sent: false, skipped: 'no_amount' };

  // Money-safety gate: if a gateway state was supplied, only notify on COMPLETED.
  // A PENDING/FAILED refund must NOT trigger a "refund issued" message.
  const st = String(state || '').toUpperCase();
  if (st && st !== 'COMPLETED') return { sent: false, skipped: 'not_completed' };

  // Dedup: if we already notified, skip. Cheap protection against retry loops
  // notifying multiple times as refund state flips between PENDING/COMPLETED.
  if (order.refund_notified_at) return { sent: false, skipped: 'already_notified' };

  const oid = order.razorpay_order_id || order.id || '';
  // Template body prepends "Rs " itself — pass a plain, comma-formatted number.
  const amtPlain = rupees(amountPaise);

  // Partial = we kept some of the customer's money. Decided from the amounts,
  // not from a caller's flag, so the async paths (phonepe-webhook, the retry
  // job) classify it the same way as the admin's own click.
  const total = Number(order.amount_paise) || 0;
  const isPartial = total > 0 && amountPaise < total;
  // Fall back to whatever the refund was persisted with, so a partial that
  // completes hours later via the retry job can still name its books.
  const lineItems = cleanRefundItems(items && items.length ? items : order.refund_items);
  const itemsLine = refundItemsLine(lineItems);

  const emailPromise = order.customer_email
    ? sendEmail({
        to: order.customer_email,
        subject: isPartial ? `Partial refund initiated — ${oid}` : `Refund initiated — ${oid}`,
        html: isPartial
          ? refundPartialEmailHtml(order, amountPaise, refundRef, lineItems)
          : refundInitiatedEmailHtml(order, amountPaise, refundRef),
      }).catch(e => console.error('refund email:', e.message))
    : Promise.resolve();

  // Same reference the email and the owner notification quote, so a customer
  // reading both sees one number rather than two that look unrelated.
  const ref = resolveRefundRef(order, refundRef);

  const waPromise = order.customer_phone
    ? sendRefundWhatsApp({ order, oid, amtPlain, isPartial, itemsLine, refundRef: ref })
        .catch(e => console.error('refund whatsapp:', e.message))
    : Promise.resolve();

  // Notify the store owner too — same success+dedup gate as the customer, so the
  // owner is emailed exactly once, only when a refund has actually been issued.
  const ownerProvider = String(order.razorpay_payment_id || '').startsWith('pay_') ? 'Razorpay' : 'PhonePe';
  const ownerPromise = notifyOwnerRefund(order, amountPaise, {
    provider: ownerProvider,
    // Prefer the gateway's own reference (PhonePe refundId / Razorpay rfnd_…)
    // over our internal merchantRefundId — that's the one support can trace.
    refundId: ref,
    state: order.refund_state || 'processed',
    items: lineItems,
  }).catch(e => console.error('owner refund notify:', e.message));

  await Promise.all([emailPromise, waPromise, ownerPromise]);

  // Stamp so we don't renotify. Best-effort: if the column doesn't exist yet
  // (SQL migration not run), swallow the error rather than blocking refunds.
  if (supabase && order.id) {
    try {
      await supabase.from('orders')
        .update({ refund_notified_at: new Date().toISOString() })
        .eq('id', order.id);
    } catch (e) { console.error('refund_notified_at stamp:', e.message); }
  }

  return { sent: true };
}

// Paise → "1,234.50". Always two decimals: a bare toLocaleString turned a
// ₹230.10 refund into "₹230.1", which reads to a customer like we kept the
// paise. Rupee amounts the customer is told must match the gateway exactly.
function rupees(paise) {
  const n = Number(paise);
  return ((Number.isFinite(n) ? n : 0) / 100)
    .toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

module.exports = {
  sendRefundInitiated,
  refundInitiatedEmailHtml,
  refundPartialEmailHtml,
  notifyOwnerRefund,
  cleanRefundItems,
  refundItemsLine,
  resolveRefundRef,
  sendRefundWhatsApp,
  rupees,
};
