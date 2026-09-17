/**
 * The "your order has shipped" notification: WhatsApp + email.
 *
 * WHY THE PARAMETER COUNT IS NEGOTIATED
 * -------------------------------------
 * Five places send the `order_shipped` template and they disagree about how
 * many body variables it has:
 *
 *   nimbuspost-awb-sync-background.js  4   "the approved Meta template
 *   bulk-update-orders.js             4    currently has four body variables"
 *   update-order-status.js            4
 *   nimbuspost-webhook.js             5
 *   order-tracking.js                 5   "Book: {{2}} ... Track here: {{5}}"
 *
 * Meta rejects the ENTIRE send when the count does not match the approved
 * template (error 132000), and sendWhatsApp RETURNS that failure rather than
 * throwing -- while every caller only .catch()es exceptions. So one of those
 * two groups has been silently sending nothing, for a long time, invisibly.
 *
 * The template definition could not be read to settle it: the WhatsApp token
 * is an unrestricted SYSTEM_USER token that cannot resolve its own WABA
 * (see whatsapp-template-diagnose), so there is nothing to list templates on.
 *
 * Rather than guess and be silently wrong, this tries the five-variable shape
 * and falls back to four ONLY on a parameter-count error. A rejected attempt
 * delivers nothing, so the fallback costs an API call and never a duplicate
 * message. Which shape won is logged, so one real send settles the question
 * and the loser can then be deleted.
 *
 * NOTE: the tracking link is a plain BODY parameter here, not a URL button --
 * no order_shipped caller passes urlButtonParam. So the link that reaches the
 * customer is exactly the one passed in, with no base URL fixed at approval
 * time. (The in-transit/delivered templates DO use a URL button, and it points
 * at inkandchai.in/track/, not at any courier.)
 */

const { sendWhatsApp } = require('./whatsapp');
const { sendEmail } = require('./email');

/** Meta's "number of parameters does not match" rejection. */
function isParamCountError(res) {
  const err = (res && res.data && res.data.error) || {};
  if (Number(err.code) === 132000) return true;
  const text = `${err.message || ''} ${err.error_user_title || ''} ${(err.error_data && err.error_data.details) || ''}`;
  return /number of parameter|parameter count|does not match/i.test(text);
}

function shippedEmailHtml({ name, orderNumber, courier, awb, trackUrl, items }) {
  const rows = (items || []).map((i) => `
    <tr>
      <td style="padding:8px 12px;border-bottom:1px solid #2a2a2a;">${i.title || 'Book'}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #2a2a2a;text-align:center;">${i.qty || 1}</td>
    </tr>`).join('');
  return `
    <div style="background:#0d0b08;color:#f0e8d8;font-family:Georgia,serif;max-width:600px;margin:0 auto;padding:32px;">
      <h1 style="color:#c9a84c;font-size:24px;font-weight:400;margin-bottom:4px;">Ink &amp; Chai</h1>
      <p style="color:#a09080;font-size:12px;letter-spacing:2px;text-transform:uppercase;margin-bottom:32px;">inkandchai.in</p>
      <p style="font-size:16px;">Hi ${name},</p>
      <p style="font-size:15px;line-height:1.7;">Your order <strong>${orderNumber}</strong> is on its way.</p>
      ${rows ? `<table style="width:100%;border-collapse:collapse;margin:20px 0;font-size:14px;">${rows}</table>` : ''}
      <div style="margin:24px 0;padding:18px;background:#1c1916;border-left:3px solid #c9a84c;">
        <p style="margin:0 0 6px;font-size:13px;color:#a09080;">Courier: <strong style="color:#f0e8d8;">${courier}</strong></p>
        <p style="margin:0 0 14px;font-size:13px;color:#a09080;">Tracking number: <strong style="color:#f0e8d8;">${awb}</strong></p>
        ${trackUrl ? `<a href="${trackUrl}" style="display:inline-block;background:#c9a84c;color:#0d0b08;padding:10px 24px;text-decoration:none;font-size:12px;letter-spacing:2px;text-transform:uppercase;font-weight:600;">Track your parcel &rarr;</a>` : ''}
      </div>
      <hr style="border:none;border-top:1px solid #2a2a2a;margin:32px 0;"/>
      <p style="color:#7a6330;font-size:11px;">Ink &amp; Chai &middot; inkandchai.in &middot; For support, reply to this email.</p>
    </div>`;
}

/**
 * Never throws: a notification failure must not roll back a shipment that has
 * already happened.
 * @returns {Promise<{whatsapp: object, email: object}>}
 */
async function sendShippedNotification(order, { awb, courier, trackingUrl }) {
  const orderNumber = order.razorpay_order_id || order.id;
  const firstName = String(order.customer_name || 'there').split(' ')[0];
  const items = Array.isArray(order.cart_items) ? order.cart_items : [];
  const bookTitle = (items[0] && items[0].title) || 'your books';
  const courierName = courier || 'Courier';
  const awbText = awb || '—';

  const out = { whatsapp: { skipped: true }, email: { skipped: true } };

  if (order.customer_phone) {
    const five = [firstName, bookTitle, courierName, awbText, trackingUrl];
    const four = [firstName, courierName, awbText, trackingUrl];
    let res;
    try {
      res = await sendWhatsApp({ to: order.customer_phone, template: 'order_shipped', params: five });
      if (!res.ok && isParamCountError(res)) {
        console.warn(`[shipped-notify] ${orderNumber}: 5-param order_shipped rejected, retrying with 4`);
        res = await sendWhatsApp({ to: order.customer_phone, template: 'order_shipped', params: four });
        if (res.ok) console.log(`[shipped-notify] order_shipped takes FOUR body variables`);
      } else if (res.ok) {
        console.log('[shipped-notify] order_shipped takes FIVE body variables');
      }
    } catch (e) {
      res = { ok: false, error: e.message };
    }
    if (!res.ok) console.error(`[shipped-notify] WhatsApp failed for ${orderNumber}:`, JSON.stringify(res.data || res.error || res));
    out.whatsapp = { ok: !!res.ok, status: res.status || null };
  }

  if (order.customer_email) {
    try {
      const r = await sendEmail({
        to: order.customer_email,
        subject: `Your Ink & Chai order ${orderNumber} has shipped`,
        html: shippedEmailHtml({ name: firstName, orderNumber, courier: courierName, awb: awbText, trackUrl: trackingUrl, items }),
      });
      out.email = { ok: !!(r && r.ok) };
    } catch (e) {
      out.email = { ok: false, error: e.message };
    }
  }

  return out;
}

module.exports = { sendShippedNotification, isParamCountError, shippedEmailHtml };
