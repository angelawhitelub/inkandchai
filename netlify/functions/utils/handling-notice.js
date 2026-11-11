'use strict';

/**
 * Tells the customer when a book with extra handling time will be handed to
 * the courier (owner, 11 Nov 2026: "customer shall also be notified").
 *
 * Same date rule as the product page's "Ships by" and the courier hold in
 * utils/preorder-hold: delivery-eta shipByDate from when the order was placed,
 * plus the book's handling days. Reads `_handling_days`, which utils/pricing
 * stamps on each line from product_settings, so it needs no database call.
 */
const { shipByDate, isoDay } = require('./delivery-eta');

function lines(cart) {
  return (Array.isArray(cart) ? cart : []).filter((i) => i && typeof i === 'object' && !i._payment);
}

/** { iso, label, days, titles } for the latest handover in the cart, or null. */
function handlingNotice(cart, placedAt = Date.now()) {
  let days = 0;
  const titles = [];
  for (const i of lines(cart)) {
    const d = Math.min(30, Math.round(Number(i._handling_days) || 0));
    if (d > 0) {
      days = Math.max(days, d);
      titles.push(String(i.title || i.name || 'a book'));
    }
  }
  if (!days) return null;
  const t = typeof placedAt === 'number' ? placedAt : Date.parse(placedAt);
  const d = shipByDate(Number.isFinite(t) ? t : Date.now(), days);
  const iso = isoDay(d);
  const label = d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  return { iso, label, days, titles: [...new Set(titles)] };
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** One paragraph for the confirmation email, or ''. */
function handlingNoticeHtml(cart, placedAt) {
  const n = handlingNotice(cart, placedAt);
  if (!n) return '';
  const what = n.titles.length === 1 ? `<strong style="color:#f0e8d8;">${esc(n.titles[0])}</strong> needs` : 'Some books in your order need';
  return `<p style="margin:14px 0;background:#1c1916;padding:12px 14px;color:#c9a84c;font-size:13px;line-height:1.7;">⏳ ${what} a little extra time to prepare, so your order will be handed to the courier on <strong>${esc(n.label)}</strong>. All your books ship together, and we will message you the tracking link as soon as it is dispatched.</p>`;
}

/** Short text for a WhatsApp template parameter (one line, no newlines). */
function handlingNoticeText(cart, placedAt) {
  const n = handlingNotice(cart, placedAt);
  return n ? `(ships together on ${n.label}: extra preparation time)` : '';
}

module.exports = { handlingNotice, handlingNoticeHtml, handlingNoticeText };
