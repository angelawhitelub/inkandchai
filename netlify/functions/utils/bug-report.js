'use strict';

/**
 * "Report a problem" -- what a customer sends, cleaned before it is stored.
 *
 * Everything arrives from an anonymous browser, so every field is capped and
 * typed here and nothing is trusted: the admin panel escapes it again on
 * display. The page, device, cart and recent script errors are attached by
 * public/js/site-feedback.js so a report like "the cart doesn't work" can be
 * reproduced without asking the customer what phone they were on.
 */

const STATUSES = ['new', 'looking', 'fixed', 'closed'];
const MIN_MESSAGE = 5;
const MAX_MESSAGE = 2000;

const line = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

function cleanCart(cart) {
  if (!Array.isArray(cart)) return null;
  const out = cart.slice(0, 20).map((i) => ({
    title: line(i && i.title, 160),
    qty: Math.max(0, Math.min(99, Math.round(Number(i && i.qty)) || 0)),
    price: Math.max(0, Math.min(100000, Number(i && i.price) || 0)),
  })).filter((i) => i.title);
  return out.length ? out : null;
}

function cleanErrors(errors) {
  if (!Array.isArray(errors)) return null;
  const out = errors.slice(-8).map((e) => ({
    msg: line(e && e.msg, 300),
    src: line(e && e.src, 160),
    line: Math.max(0, Math.round(Number(e && e.line)) || 0),
    at: line(e && e.at, 40),
  })).filter((e) => e.msg);
  return out.length ? out : null;
}

/** Only the path and query of our own pages -- never someone else's URL. */
function cleanPage(v) {
  const s = line(v, 300);
  return s.startsWith('/') && !s.startsWith('//') ? s : null;
}

/** @returns {{ row?: object, error?: string }} */
function parseBugReport(body) {
  const b = body && typeof body === 'object' ? body : {};
  const message = String(b.message == null ? '' : b.message).replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, MAX_MESSAGE);
  if (message.length < MIN_MESSAGE) return { error: 'Tell us a little about what went wrong.' };
  const device = ['mobile', 'desktop'].includes(b.device) ? b.device : null;
  return {
    row: {
      message,
      contact: line(b.contact, 120) || null,
      page_url: cleanPage(b.page_url),
      device,
      viewport: /^\d{2,5}x\d{2,5}$/.test(String(b.viewport || '')) ? String(b.viewport) : null,
      user_agent: line(b.user_agent, 300) || null,
      cart: cleanCart(b.cart),
      errors: cleanErrors(b.errors),
      visitor_id: line(b.visitor_id, 40) || null,
    },
  };
}

const refFor = (id) => `BUG-${id}`;

module.exports = { parseBugReport, refFor, STATUSES, MAX_MESSAGE, MIN_MESSAGE };
