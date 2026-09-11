'use strict';

/**
 * Telling a customer that a MANUAL UPI payout has landed.
 *
 * This is not the gateway refund flow in utils/refund-notifications.js, and it
 * must not borrow its wording. That one says the money returns to "your
 * original payment method" — true for a card or a UPI collect we captured, and
 * wrong here. These customers paid cash on delivery: there is no instrument to
 * reverse, so a person opened a banking app and pushed the money to a UPI
 * handle the customer gave us.
 *
 * Two things follow, and both are the whole point of this file:
 *
 *   1. The credit arrives under the REGISTERED BUSINESS NAME, not the shop
 *      name. A customer scanning their statement for "Ink & Chai" will not find
 *      it, will assume nothing was sent, and will write in. So the message says
 *      the name the bank will actually print.
 *   2. It is sent only AFTER a human confirms the transfer is done. Nothing in
 *      here moves money or can be triggered by a webhook — see
 *      mark-refund-upi-paid.js, which requires an explicit admin action.
 */

const { sendEmail } = require('./email');
const { sendWhatsApp, sendText } = require('./whatsapp');

// The name the customer's bank statement will show. Overridable so a change of
// registered entity is a config edit, not a code change.
const SENDER_NAME = () => String(process.env.REFUND_SENDER_NAME || 'Malka Enterprises').trim();

const esc = (v) => String(v == null ? '' : v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const firstName = (name) => String(name || 'there').trim().split(/\s+/)[0] || 'there';

function rupees(amount) {
  const n = Number(amount) || 0;
  return n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function emailHtml({ order, amountRs, upiId, ref, books }) {
  const oid = order.razorpay_order_id || order.id || '';
  const sender = SENDER_NAME();
  const bookList = (books || []).length
    ? `<ul style="margin:8px 0 0;padding-left:18px;color:#f0e8d8;">${
        books.map(b => `<li style="margin:3px 0;">${esc(b)}</li>`).join('')}</ul>`
    : '';
  return `
    <div style="background:#0d0b08;color:#f0e8d8;font-family:Georgia,serif;max-width:600px;margin:0 auto;padding:32px;">
      <h1 style="color:#c9a84c;font-size:22px;font-weight:400;margin:0 0 4px;">Ink &amp; Chai</h1>
      <p style="color:#a09080;font-size:12px;letter-spacing:2px;text-transform:uppercase;margin:0 0 24px;">Refund sent</p>

      <p style="font-size:16px;line-height:1.8;margin:0 0 14px;">Hi ${esc(firstName(order.customer_name))},</p>
      <p style="color:#a09080;font-size:15px;line-height:1.8;margin:0 0 18px;">
        We've sent your refund of <strong style="color:#c9a84c;">₹${rupees(amountRs)}</strong>
        for order <strong style="color:#c9a84c;">${esc(oid)}</strong> to your UPI ID.
      </p>

      <table style="font-size:15px;line-height:1.9;color:#f0e8d8;margin:0 0 18px;">
        <tr><td style="color:#a09080;padding-right:18px;">Sent to</td><td><strong>${esc(upiId)}</strong></td></tr>
        <tr><td style="color:#a09080;padding-right:18px;">Amount</td><td><strong>₹${rupees(amountRs)}</strong></td></tr>
        ${ref ? `<tr><td style="color:#a09080;padding-right:18px;">Reference / UTR</td><td><strong>${esc(ref)}</strong></td></tr>` : ''}
      </table>

      <!-- The single line this email exists for. Without it the customer looks
           for "Ink & Chai", does not find it, and writes in to ask. -->
      <div style="margin:18px 0;padding:16px;background:#152315;border-left:3px solid #6dbf6d;">
        <p style="color:#f0e8d8;margin:0 0 6px;font-size:15px;line-height:1.7;">
          In your statement it will appear from the account holder name
          <strong style="color:#c9a84c;">${esc(sender)}</strong> — not "Ink &amp; Chai".
        </p>
        <p style="color:#a09080;margin:0;font-size:14px;line-height:1.7;">
          Please check your PhonePe or bank statement for it. It usually shows within a few minutes,
          and can take up to 24 hours to appear.
        </p>
      </div>

      ${bookList ? `<p style="color:#a09080;font-size:14px;margin:18px 0 0;">This covers the ${books.length > 1 ? 'books' : 'book'} that never reached you:</p>${bookList}` : ''}

      <p style="color:#a09080;font-size:14px;line-height:1.8;margin:22px 0 0;">
        We're sorry the ${books && books.length > 1 ? 'books' : 'book'} didn't arrive. If you can't find the credit after 24 hours,
        just reply to this email with the reference above and we'll chase it.
      </p>
      <p style="color:#a09080;font-size:14px;margin:18px 0 0;">— Team Ink &amp; Chai</p>
    </div>`;
}

/**
 * The plain-text version, used for the WhatsApp fallback.
 *
 * Kept beside the email on purpose: the two must say the same thing about where
 * the money came from, and they drift the moment they live apart.
 */
function plainMessage({ order, amountRs, upiId, ref }) {
  const oid = order.razorpay_order_id || order.id || '';
  return `Hi ${firstName(order.customer_name)}, your refund of Rs ${rupees(amountRs)} for order ${oid} `
    + `has been sent to your UPI ID ${upiId}.`
    + (ref ? ` Reference: ${ref}.` : '')
    + ` It will show in your statement from the account holder name "${SENDER_NAME()}", not "Ink & Chai" — `
    + `please check your PhonePe or bank statement. Sorry again that the book did not reach you. — Ink & Chai`;
}

/**
 * WhatsApp, template first then free-form.
 *
 * `refund_upi_paid` has to be created and approved in Meta Business Manager
 * (category UTILITY, one paragraph, variables in ascending order):
 *
 *   Hi {{1}}, your refund of Rs {{2}} for order {{3}} has been sent to your UPI
 *   ID {{4}}. It will appear in your statement from the account holder name
 *   {{5}}, not Ink & Chai - please check your PhonePe or bank statement. Thank
 *   you, Ink & Chai.
 *
 * Until it is approved the free-form text below carries the same words, but
 * only reaches customers inside the 24-hour service window. The EMAIL always
 * goes, and needs nobody's approval — which is why the caller reports each
 * channel separately instead of one "notified" flag.
 */
async function sendRefundUpiWhatsApp({ order, amountRs, upiId, ref }) {
  if (!order.customer_phone) return { ok: false, skipped: true, reason: 'no phone' };

  const tpl = await sendWhatsApp({
    to: order.customer_phone,
    template: process.env.WHATSAPP_REFUND_UPI_TEMPLATE || 'refund_upi_paid',
    params: [
      firstName(order.customer_name),
      rupees(amountRs),
      String(order.razorpay_order_id || order.id || ''),
      String(upiId || ''),
      SENDER_NAME(),
    ],
  });
  if (tpl?.ok) return { ok: true, via: 'template' };
  if (tpl?.skipped) return { ok: false, skipped: true, reason: 'whatsapp not configured' };

  const txt = await sendText(order.customer_phone, plainMessage({ order, amountRs, upiId, ref }));
  return txt?.ok
    ? { ok: true, via: 'text' }
    : { ok: false, error: txt?.error || 'template rejected and free-form text failed' };
}

/**
 * Tell the customer the manual payout is done. Never throws: the transfer has
 * already happened and the payout record is already written, so a mail server
 * having a bad minute must not make the admin think the money did not go.
 */
async function notifyRefundUpiPaid({ order, amountRs, upiId, ref, books }) {
  const out = { email: false, whatsapp: false, whatsappVia: null, errors: [] };

  if (order.customer_email) {
    try {
      const em = await sendEmail({
        to: order.customer_email,
        subject: `Refund sent — ₹${rupees(amountRs)} for order ${order.razorpay_order_id || order.id}`,
        html: emailHtml({ order, amountRs, upiId, ref, books }),
      });
      out.email = !!em?.ok;
      if (!em?.ok) out.errors.push(`email: ${em?.error || 'not sent'}`);
    } catch (e) {
      out.errors.push(`email: ${e.message}`);
    }
  }

  try {
    const wa = await sendRefundUpiWhatsApp({ order, amountRs, upiId, ref });
    out.whatsapp = !!wa.ok;
    out.whatsappVia = wa.via || null;
    if (!wa.ok && !wa.skipped) out.errors.push(`whatsapp: ${wa.error}`);
  } catch (e) {
    out.errors.push(`whatsapp: ${e.message}`);
  }

  return out;
}

module.exports = { notifyRefundUpiPaid, plainMessage, emailHtml, SENDER_NAME };
