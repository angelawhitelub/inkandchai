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

/**
 * Fetch the CURRENT refund status for a payment directly from Razorpay.
 * Razorpay refunds are async: a freshly-created refund is `pending` and moves to
 * `processed` (or `failed`) once the bank confirms. This lets us report the real
 * state instead of assuming success.
 *
 *   GET https://api.razorpay.com/v1/payments/:paymentId/refunds
 *
 * @param {string} paymentId  Razorpay payment id ("pay_...")
 * @returns {Promise<{status:string|null, refundId:string|null, amountPaise:number, count:number}>}
 *          status is 'processed' | 'pending' | 'failed' | null (no refund found).
 *          Never throws — returns { status:null } on any error.
 */
async function fetchRazorpayRefundStatus(paymentId) {
  const keyId     = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  const empty = { status: null, refundId: null, amountPaise: 0, count: 0 };
  if (!keyId || !keySecret || !paymentId || !String(paymentId).startsWith('pay_')) return empty;
  try {
    const auth = Buffer.from(`${keyId}:${keySecret}`).toString('base64');
    const res = await fetch(`https://api.razorpay.com/v1/payments/${paymentId}/refunds`, {
      headers: { 'Authorization': `Basic ${auth}` },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return empty;
    const items = Array.isArray(data.items) ? data.items : [];
    if (!items.length) return empty;
    // Most-recent refund (items are newest-first from Razorpay).
    const latest = items[0];
    return {
      status: latest.status || null,
      refundId: latest.id || null,
      amountPaise: Number(latest.amount || 0),
      count: items.length,
    };
  } catch (e) {
    console.error('[razorpay] fetchRefundStatus:', e.message);
    return empty;
  }
}

module.exports = { issueRazorpayRefund, fetchRazorpayRefundStatus };
