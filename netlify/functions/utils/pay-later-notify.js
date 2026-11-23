'use strict';

/**
 * Pay Later emails (utils/pay-later). Email only: a WhatsApp message outside
 * the 24-hour window needs an approved template, and none exists yet. The
 * payment link itself also goes out by SMS from Razorpay.
 */
const { sendEmail } = require('./email');
const { sendText } = require('./whatsapp');
const PL = require('./pay-later');

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const rupees = (paise) => `₹${Math.round((Number(paise) || 0) / 100).toLocaleString('en-IN')}`;
const firstName = (n) => esc(String(n || '').trim().split(/\s+/)[0] || 'there');
const dateIST = (iso) => new Date(Date.parse(iso) + 5.5 * 3600000).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

function emailBase(content) {
  return `
    <div style="background:#0d0b08;color:#f0e8d8;font-family:Georgia,serif;max-width:600px;margin:0 auto;padding:32px;">
      <h1 style="color:#c9a84c;font-size:24px;font-weight:400;margin-bottom:4px;">Ink &amp; Chai</h1>
      <p style="color:#a09080;font-size:12px;letter-spacing:2px;text-transform:uppercase;margin-bottom:32px;">inkandchai.in</p>
      ${content}
      <hr style="border:none;border-top:1px solid #2a2a2a;margin:32px 0;"/>
      <p style="color:#7a6330;font-size:11px;">Ink &amp; Chai · inkandchai.in · For support, reply to this email.</p>
    </div>`;
}

function booksHtml(order) {
  const lines = PL.cartItems(order).filter((i) => i && (i.title || i.name))
    .map((i) => `<li>${esc(i.title || i.name)}${Number(i.qty) > 1 ? ` × ${Number(i.qty)}` : ''}</li>`).join('');
  return lines ? `<ul style="color:#f0e8d8;font-size:14px;line-height:1.8;padding-left:18px;">${lines}</ul>` : '';
}

const idOf = (order) => esc(order.razorpay_order_id || order.id);
const p = (t) => `<p style="color:#a09080;font-size:14px;line-height:1.7;">${t}</p>`;
// Every Pay Later email carries it (owner, 23 Nov 2026).
const NO_OTP = p('<strong style="color:#f0e8d8;">No OTP is needed.</strong> Our employees will never call or message you asking for an OTP, PIN, password or card details. If anyone does, it is not us: please do not share it.');

async function send(order, subject, body) {
  if (!order || !order.customer_email) return { sent: false, reason: 'no email' };
  try { await sendEmail({ to: order.customer_email, subject, html: emailBase(body) }); return { sent: true }; }
  catch (e) { console.warn('[pay-later] email failed', order.razorpay_order_id, e.message); return { sent: false, reason: e.message }; }
}

function requestReceived(order) {
  return send(order, `We received your Pay Later request ${order.razorpay_order_id}`, `
    <h2 style="color:#f0e8d8;font-size:20px;font-weight:400;">Hi ${firstName(order.customer_name)}, we have your Pay Later request</h2>
    ${p(`Order <strong style="color:#c9a84c;">${idOf(order)}</strong> · ${rupees(order.amount_paise)} to pay after delivery`)}
    ${booksHtml(order)}
    ${p('Nothing has been charged. We are checking your credit score using the PAN and bank details you gave us, and we will email you as soon as your order is confirmed or declined, usually within 24 hours.')}
    ${p('If it is confirmed, we ship it like any other order. When it is delivered we send you a secure Razorpay payment link, to be paid within 7 days of delivery.')}
    ${NO_OTP}`);
}

function approved(order) {
  return send(order, `Your Pay Later order ${order.razorpay_order_id} is confirmed`, `
    <h2 style="color:#f0e8d8;font-size:20px;font-weight:400;">Good news, ${firstName(order.customer_name)}: your Pay Later order is confirmed</h2>
    ${p(`Order <strong style="color:#c9a84c;">${idOf(order)}</strong> · ${rupees(order.amount_paise)} to pay after delivery`)}
    ${booksHtml(order)}
    ${p('We will ship it soon and send you the tracking details. Nothing is collected at your door.')}
    ${p(`When it is delivered we send you a secure Razorpay payment link by SMS and email. Please pay it within ${PL.DUE_DAYS} days of delivery.`)}
    ${NO_OTP}`);
}

function rejected(order, reason) {
  return send(order, `About your Pay Later request ${order.razorpay_order_id}`, `
    <h2 style="color:#f0e8d8;font-size:20px;font-weight:400;">Hi ${firstName(order.customer_name)}, we could not approve Pay Later this time</h2>
    ${p(`Order <strong style="color:#c9a84c;">${idOf(order)}</strong> has been cancelled and nothing has been charged.`)}
    ${reason ? p(`Reason: ${esc(reason)}`) : ''}
    ${p('You can still order the same books on <a href="https://inkandchai.in" style="color:#c9a84c;">inkandchai.in</a> and pay online or with Cash on Delivery.')}`);
}

function paymentLink(order, url, dueAt) {
  return send(order, `Payment due for your Pay Later order ${order.razorpay_order_id}`, `
    <h2 style="color:#f0e8d8;font-size:20px;font-weight:400;">Hi ${firstName(order.customer_name)}, your books were delivered</h2>
    ${p(`Order <strong style="color:#c9a84c;">${idOf(order)}</strong> · amount due <strong style="color:#c9a84c;">${rupees(order.amount_paise)}</strong> by <strong>${esc(dateIST(dueAt))}</strong>.`)}
    ${booksHtml(order)}
    <p style="margin:24px 0;"><a href="${esc(url)}" style="background:#c9a84c;color:#0d0b08;padding:12px 22px;border-radius:6px;text-decoration:none;font-family:Arial,sans-serif;font-weight:700;">Pay ${rupees(order.amount_paise)} now</a></p>
    ${p(`Or open this link: <a href="${esc(url)}" style="color:#c9a84c;">${esc(url)}</a>. It is a secure Razorpay page (UPI, cards, net banking). `)}
    ${NO_OTP}`);
}

async function ownerAlert(text) {
  const phone = process.env.STORE_OWNER_PHONE;
  if (phone) { try { await sendText(phone, text); } catch (_) { /* best effort */ } }
}

module.exports = { requestReceived, approved, rejected, paymentLink, ownerAlert, emailBase };
