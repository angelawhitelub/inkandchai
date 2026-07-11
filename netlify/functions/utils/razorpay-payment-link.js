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
 * @param {string} [opts.shippingAddress] Full delivery address — stored in notes so the webhook can save it
 * @param {string} [opts.books] Book title(s) — stored in notes for the webhook's placeholder cart
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
    // Stash the customer details in notes using the SAME keys the Razorpay
    // webhook reads (customer_name / shipping_address / customer_phone / books).
    // Without this, a paid link creates an order with an empty name+address and
    // Razorpay's void@razorpay.com placeholder email, because a payment link has
    // no browser checkout to run verify-payment.
    notes: {
      ...(opts.referenceId ? { bot_order_id: opts.referenceId } : {}),
      ...(opts.customerName ? { customer_name: String(opts.customerName).slice(0, 100) } : {}),
      ...(contact ? { customer_phone: contact } : {}),
      ...(opts.shippingAddress ? { shipping_address: String(opts.shippingAddress).slice(0, 300) } : {}),
      ...(opts.books ? { books: String(opts.books).slice(0, 300) } : {}),
    },
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

/**
 * Fetch a payment link and, if it's been paid, return the captured Razorpay
 * payment id (pay_...). Used when converting a paid WhatsApp book request into
 * a real order so the order carries a real payment id (and thus reads as an
 * online/prepaid order, not COD).
 *
 * @returns {Promise<{status:string, paymentId:string|null, amountPaise:number|null}>}
 */
async function fetchPaymentLinkStatus(plinkId) {
  const keyId     = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret) throw new Error('Razorpay keys not configured');
  if (!plinkId) return { status: 'unknown', paymentId: null, amountPaise: null };

  const auth = Buffer.from(`${keyId}:${keySecret}`).toString('base64');
  const res = await fetch(`https://api.razorpay.com/v1/payment_links/${encodeURIComponent(plinkId)}`, {
    headers: { 'Authorization': `Basic ${auth}` },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.description || `Razorpay payment_links GET ${res.status}`);

  const payments = Array.isArray(data.payments) ? data.payments : [];
  const captured = payments.find(p => p.status === 'captured') || payments.find(p => p.status === 'authorized') || payments[0];
  return {
    status: data.status || 'unknown',                 // created | paid | expired | cancelled
    paymentId: captured?.payment_id || null,          // pay_...
    amountPaise: typeof data.amount_paid === 'number' ? data.amount_paid : (typeof data.amount === 'number' ? data.amount : null),
  };
}

module.exports = { createRazorpayPaymentLink, fetchPaymentLinkStatus };
