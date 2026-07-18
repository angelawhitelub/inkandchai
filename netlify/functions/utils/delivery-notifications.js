/**
 * Customer delivery-stage notifications — email + WhatsApp.
 *
 * Shared by nimbuspost-webhook (real-time courier events) and
 * nimbuspost-reconcile (the backup poller) so a customer gets the SAME
 * email + WhatsApp regardless of which path detects the transition.
 *
 * Three stages:
 *   in transit        → sendInTransitNotifications  (WA needs "order_in_transit" template)
 *   out for delivery  → sendOFDNotification
 *   delivered         → sendDeliveredNotification
 *
 * All senders are non-fatal (each channel is caught) and never throw.
 */

const { sendWhatsApp } = require('./whatsapp');
const { sendEmail }    = require('./email');

function npTrackUrl(awb) {
  return `https://ship.nimbuspost.com/shipping/tracking/${awb}`;
}

function siteTrackUrl(order) {
  return `https://inkandchai.in/track/?id=${encodeURIComponent(order.razorpay_order_id || order.id)}`;
}

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

// ── In transit ──────────────────────────────────────────────────────────────
async function sendInTransitNotifications(order, awb) {
  // WhatsApp-only: the in-transit EMAIL was dropped to conserve email-provider
  // quota (WhatsApp covers this stage). See sendDeliveredNotification for a stage
  // that still emails. `awb` is kept in the signature for call-site compatibility.
  const firstName = (order.customer_name || 'there').split(' ')[0];
  const items     = Array.isArray(order.cart_items) ? order.cart_items : [];
  const bookList  = items.map(i => i.title ? (Number(i.qty) > 1 ? `${i.title} ×${i.qty}` : i.title) : (i.name || '')).filter(Boolean).join(', ') || 'your books';
  const courier   = order.courier_name || 'DTDC Surface';

  if (order.customer_phone) {
    await sendWhatsApp({
      to: order.customer_phone,
      template: 'order_in_transit',
      params: [firstName, bookList, courier],          // {{1}} {{2}} {{3}}
      urlButtonParam: String(order.razorpay_order_id || order.id), // Track button → /track/?id={{1}}
    }).catch(e => console.error('[delivery-notify] in-transit WhatsApp error:', e.message));
  }
}

// ── Out for delivery ─────────────────────────────────────────────────────────
async function sendOFDNotification(order) {
  // WhatsApp-only: the out-for-delivery EMAIL was dropped to conserve email
  // quota (WhatsApp covers this stage).
  const firstName = (order.customer_name || 'there').split(' ')[0];
  const items     = Array.isArray(order.cart_items) ? order.cart_items : [];
  // List EVERY book (with qty), like the in-transit and delivered messages —
  // using only items[0] made a 2-book order read as if the second wasn't coming.
  const bookList  = items.map(i => i.title ? (Number(i.qty) > 1 ? `${i.title} ×${i.qty}` : i.title) : (i.name || '')).filter(Boolean).join(', ') || 'your books';
  const isCOD     = !order.razorpay_payment_id || ['cod_pending','partial_cod_pending'].includes(order.status);
  const total     = order.amount_paise ? `₹${(order.amount_paise / 100).toLocaleString('en-IN')}` : '';
  const trackUrl  = order.tracking_url || siteTrackUrl(order);

  if (order.customer_phone) {
    await sendWhatsApp({
      to: order.customer_phone,
      template: 'order_out_for_delivery',
      params: [
        firstName,
        bookList,
        isCOD ? `Please keep ${total} cash ready for delivery` : 'All set — no payment needed at door!',
        trackUrl,
      ],
    }).catch(e => console.error('[delivery-notify] OFD WhatsApp error:', e.message));
  }
}

// ── Delivered ────────────────────────────────────────────────────────────────
async function sendDeliveredNotification(order) {
  const firstName = (order.customer_name || 'there').split(' ')[0];
  const orderId   = order.razorpay_order_id || order.id;
  const items     = Array.isArray(order.cart_items) ? order.cart_items : [];
  const bookList  = items.map(i => i.title ? (Number(i.qty) > 1 ? `${i.title} ×${i.qty}` : i.title) : (i.name || '')).filter(Boolean).join(', ') || 'your books';
  const reviewUrl = `https://inkandchai.in/review/?order=${encodeURIComponent(orderId)}`;
  const isReplacement = order.source === 'replacement';

  if (order.customer_email) {
    await sendEmail({
      to: order.customer_email,
      subject: isReplacement
        ? `✅ Your replacement books have arrived! (${orderId})`
        : `✅ Delivered — enjoy your books! (${orderId})`,
      html: emailBase(`
        <h2 style="color:#f0e8d8;font-size:20px;font-weight:400;">${isReplacement ? 'Your replacement has been delivered ✅' : 'Delivered — happy reading! ✅'}</h2>
        <p style="color:#a09080;line-height:1.8;margin-bottom:16px;">
          Hi ${firstName}, ${isReplacement ? 'the replacement for your missing ' + (items.length > 1 ? 'books' : 'book') + ' — ' : ''}${bookList} ${items.length > 1 ? 'have' : 'has'} been delivered. We hope you love ${items.length > 1 ? 'them' : 'it'}!
        </p>
        <div style="margin:20px 0;padding:16px;background:#1c1916;border-left:3px solid #c9a84c;">
          <p style="color:#f0e8d8;font-size:13px;margin:0 0 12px;">⭐ Loved your books? A quick review means the world to us.</p>
          <a href="${reviewUrl}"
             style="display:inline-block;background:#c9a84c;color:#0d0b08;padding:10px 24px;
                    text-decoration:none;font-size:11px;letter-spacing:2px;text-transform:uppercase;font-weight:600;">
            Leave a Review →
          </a>
        </div>
        <p style="color:#a09080;font-size:13px;line-height:1.8;">
          Missing a book from your order? Reply to this email or report it from your order page and we'll fix it right away.
        </p>
      `),
    }).catch(e => console.error('[delivery-notify] delivered email error:', e.message));
  }

  if (order.customer_phone) {
    await sendWhatsApp({
      to: order.customer_phone,
      template: 'order_delivered',
      params: [firstName, reviewUrl],
    }).catch(e => console.error('[delivery-notify] delivered WhatsApp error:', e.message));
  }
}

module.exports = {
  npTrackUrl,
  emailBase,
  sendInTransitNotifications,
  sendOFDNotification,
  sendDeliveredNotification,
};
