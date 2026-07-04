/**
 * Razorpay refund helper.
 *
 * Creates a refund against a captured Razorpay payment via
 *   POST https://api.razorpay.com/v1/payments/:paymentId/refund
 *
 * @param {string} paymentId   Razorpay payment id (starts with "pay_")
 * @param {number} amountPaise Amount to refund in paise. Omit/0 = full refund of remaining.
 * @param {object} [opts]      { speed: 'normal'|'optimum', notes: {} }
 * @returns {Promise<object>}  Razorpay refund object { id, amount, status, ... }
 * @throws  on missing creds or a non-2xx response (message = Razorpay's description)
 */
async function issueRazorpayRefund(paymentId, amountPaise, opts = {}) {
  const keyId     = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret) throw new Error('Razorpay credentials not configured');
  if (!paymentId || !String(paymentId).startsWith('pay_')) {
    throw new Error('Not a Razorpay payment id');
  }

  const auth = Buffer.from(`${keyId}:${keySecret}`).toString('base64');
  const payload = {
    speed: opts.speed || 'normal',            // 'normal' = 5-7 days; 'optimum' = instant (fee)
    notes: opts.notes || {},
  };
  // Only send amount for a partial refund; omitting it refunds the full remaining.
  if (amountPaise && Number(amountPaise) > 0) payload.amount = Math.round(Number(amountPaise));

  const res = await fetch(`https://api.razorpay.com/v1/payments/${paymentId}/refund`, {
    method: 'POST',
    headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.error?.description || `Razorpay refund error ${res.status}`);
  }
  return data; // { id: 'rfnd_...', amount, status, ... }
}

module.exports = { issueRazorpayRefund };
