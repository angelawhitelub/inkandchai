/**
 * Book covers on order confirmations (owner, 4 Nov 2026).
 *
 * Cart lines carry the cover the shopper saw as `img`. Email shows it as is.
 * WhatsApp takes only JPEG or PNG in a template header and most covers are WebP,
 * so that copy goes through wsrv.nl, a public image CDN. Only the public cover
 * URL is sent there, never anything about the customer.
 *
 * The image template needs Meta's approval, so nothing changes on WhatsApp until
 * WHATSAPP_ORDER_CONFIRMED_IMAGE_TEMPLATE names it. Meta fetches a header image
 * after accepting the send and a bad one loses the whole message, so the JPEG is
 * checked first. Any doubt falls back to the plain order_confirmed template:
 * the confirmation matters more than the picture.
 */
const { sendWhatsApp } = require('./whatsapp');

const SITE = 'https://inkandchai.in';
const CHECK_MS = 3000;

const escHtml = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** A public https URL for a cart line's cover, or ''. */
function coverUrl(item) {
  const raw = String((item && (item.img || item.image || item.image_url)) || '').trim();
  if (!raw || raw.startsWith('data:')) return '';
  if (/^https?:\/\//i.test(raw)) return raw.replace(/^http:/i, 'https:');
  return SITE + (raw.startsWith('/') ? raw : `/${raw}`);
}

const coverImg = (item) => {
  const url = coverUrl(item);
  return url
    ? `<img src="${escHtml(url)}" width="48" alt="" style="display:block;width:48px;height:auto;max-height:72px;border:0;border-radius:3px;">`
    : '';
};

/** The Book cell of a confirmation email's table: cover beside the title. */
function coverAndTitleHtml(item) {
  // Colour is explicit: some mail apps do not carry it into a nested table.
  const title = `<span style="color:#f0e8d8;">${escHtml((item && (item.title || item.name)) || '')}</span>`;
  const img = coverImg(item);
  if (!img) return title;
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;"><tr>`
    + `<td width="48" style="padding:0 12px 0 0;vertical-align:top;">${img}</td>`
    + `<td style="padding:0;vertical-align:middle;">${title}</td></tr></table>`;
}

/** A plain list of the order's books, for confirmation emails with no table. */
function orderCoversHtml(cart) {
  const items = (Array.isArray(cart) ? cart : []).filter((i) => i && (i.title || i.name));
  if (!items.length) return '';
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:0 0 16px;font-size:14px;color:#f0e8d8;">`
    + items.map((i) => `<tr><td style="padding:6px 0;">${coverAndTitleHtml({ ...i, title: `${i.title || i.name} × ${Number(i.qty) || 1}` })}</td></tr>`).join('')
    + '</table>';
}

/**
 * The first book's cover as a JPEG URL WhatsApp can fetch, or ''. WhatsApp shows a
 * template's image as a 1.91:1 banner and crops anything taller, which cuts the
 * title off a book cover. So the whole cover is fitted inside a banner of that
 * shape, on a plain background.
 */
function whatsappCoverUrl(cart) {
  const url = (Array.isArray(cart) ? cart : []).map(coverUrl).find(Boolean);
  if (!url) return '';
  return `https://wsrv.nl/?url=${encodeURIComponent(url)}&w=800&h=418&fit=contain&cbg=1a1613&output=jpg&q=80`;
}

async function isJpeg(url, fetchImpl = fetch) {
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(CHECK_MS) });
    if (!res.ok) return false;
    const head = new Uint8Array((await res.arrayBuffer()).slice(0, 3));
    return head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
  } catch { return false; }
}

/** The order_confirmed WhatsApp, with the book's cover once the template exists. */
async function sendOrderConfirmed({ to, params, cart }, deps = {}) {
  const send = deps.sendWhatsApp || sendWhatsApp;
  const template = process.env.WHATSAPP_ORDER_CONFIRMED_IMAGE_TEMPLATE;
  const image = template ? whatsappCoverUrl(cart) : '';
  if (image && await isJpeg(image, deps.fetch)) {
    // Meta's refusal comes back as a result, not an exception. A wrong template
    // name or language would otherwise cost every customer their confirmation.
    try {
      const res = await send({ to, template, params, headerImageUrl: image });
      if (res?.ok) return res;
      console.warn('[order-cover] image confirmation refused, sending plain:', JSON.stringify(res?.data?.error?.message || res?.error || res?.status || 'no detail'));
    } catch (e) {
      console.warn('[order-cover] image confirmation failed, sending plain:', e.message);
    }
  }
  return send({ to, template: 'order_confirmed', params });
}

module.exports = { coverUrl, coverAndTitleHtml, orderCoversHtml, whatsappCoverUrl, isJpeg, sendOrderConfirmed };
