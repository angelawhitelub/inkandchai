/**
 * Razorpay Payment Links helper.
 *
 * Creates a hosted payment link the customer can pay from anywhere (WhatsApp,
 * SMS, email). Razorpay handles the checkout page + notifies our webhook on
 * success — we just store the link URL and the plink_ id.
 *
 * Docs: https://razorpay.com/docs/api/payments/payment-links/
 *
 * @param {object} opts
 * @param {number} opts.amountPaise   Total amount in paise (required, > 0)
 * @param {string} opts.description   What the payment is for (shown on link page)
 * @param {string} opts.customerName
 * @param {string} opts.customerPhone 10-digit or +91… — will be normalised
 * @param {string} [opts.referenceId] Our own id (bot order id) — echoed back in webhook
 * @param {string} [opts.callbackUrl] Where to redirect after payment
 * @returns {Promise<{id:string, short_url:string, status:string}>}
 */
async function createRazorpayPaymentLink(opts) {
  const keyId     = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret) throw new Error('Razorpay credentials not configured');
  const amount = Math.round(Number(opts.amountPaise || 0));
  if (!amount || amount < 100) throw new Error('amountPaise must be >= 100');

  const digits = String(opts.customerPhone || '').replace(/\D/g, '');
  const ten    = digits.length >= 10 ? digits.slice(-10) : digits;
  const contact = ten ? `+91${ten}` : undefined;

  const payload = {
    amount,
    currency: 'INR',
    accept_partial: false,
    description: String(opts.description || 'Ink & Chai order').slice(0, 2048),
    customer: {
      name: String(opts.customerName || 'Customer').slice(0, 100),
      ...(contact ? { contact } : {}),
    },
    notify: { sms: !!contact, email: false },
    reminder_enable: true,
    notes: opts.referenceId ? { bot_order_id: opts.referenceId } : {},
    ...(opts.referenceId ? { reference_id: opts.referenceId } : {}),
    ...(opts.callbackUrl ? { callback_url: opts.callbackUrl, callback_method: 'get' } : {}),
  };

  const auth = Buffer.from(`${keyId}:${keySecret}`).toString('base64');
  const res = await fetch('https://api.razorpay.com/v1/payment_links', {
    method: 'POST',
    headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.error?.description || `Razorpay payment_links ${res.status}`);
  }
  return data; // { id: 'plink_...', short_url, status: 'created', ... }
}

module.exports = { createRazorpayPaymentLink };
