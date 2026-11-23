'use strict';

/**
 * Pay Later AutoPay mandate (owner asked 24 Nov 2026): straight after the PAN
 * and bank details, the customer sets up a Razorpay recurring mandate, either
 *   upi      UPI AutoPay, ₹1 approval in their UPI app, or
 *   emandate a bank mandate (net banking) on the account number + IFSC they
 *            just typed, ₹0 approval.
 * On the day the order is delivered, if it is still unpaid, pay-later-scheduled
 * charges the mandate (chargeMandate). Razorpay tells the customer first (UPI:
 * about 25 hours before the debit), so the money arrives a day or two later.
 * A failed debit falls back to the 7-day payment link (pay-later-link).
 *
 * Everything lives in cart_items[0]._payment.mandate:
 *   { method, status: started|active|pending|failed|cancelled, customer_id,
 *     auth_order_id, auth_payment_id, token_id, max_amount, set_at,
 *     charge_order_id, charge_payment_id, charge_status: pending|paid|failed,
 *     charged_at, charge_error }
 * The ₹1 approval payment is never written into razorpay_payment_id, so it
 * never makes the order look paid.
 *
 * Needs Recurring Payments switched on for the Razorpay account (Razorpay
 * support); until then startMandate fails with Razorpay's own message and the
 * request simply carries on without a mandate.
 */
const crypto = require('crypto');
const PL = require('./pay-later');

const API = 'https://api.razorpay.com/v1';
const MANDATE_DAYS = 120; // long enough for review + shipping + delivery
const KIND_AUTH = 'pay_later_mandate';
// Razorpay retries a failed debit for a few days; only after this do we call it
// failed and send the payment link, so a late retry cannot charge on top of it.
const CHARGE_GIVE_UP_MS = 4 * 86400000;

function creds() {
  const id = process.env.RAZORPAY_KEY_ID;
  const secret = process.env.RAZORPAY_KEY_SECRET;
  if (!id || !secret) throw new Error('Razorpay credentials not configured');
  return { id, secret };
}

async function rp(method, path, body, deps = {}) {
  if (deps.rp) return deps.rp(method, path, body);
  const { id, secret } = creds();
  const res = await fetch(API + path, {
    method,
    headers: { Authorization: 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64'), 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data && data.error && data.error.description) || `Razorpay ${method} ${path} ${res.status}`);
  return data;
}

const idOf = (order) => String(order.razorpay_order_id || order.id);
const mandateOf = (order) => (PL.payLaterMeta(order) || {}).mandate || null;
const hashKey = (k) => crypto.createHash('sha256').update(String(k || '')).digest('hex');
const newKey = () => crypto.randomBytes(24).toString('hex');
const contactOf = (order) => { const t = PL.phone10(order.customer_phone); return t ? `+91${t}` : ''; };

/** The browser that placed the request holds this key; only it can start the mandate. */
function keyMatches(order, key) {
  const m = PL.payLaterMeta(order) || {};
  if (!m.mandate_key_hash || !key) return false;
  const a = Buffer.from(m.mandate_key_hash, 'hex');
  const b = Buffer.from(hashKey(key), 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Saves meta while the order is unpaid (same guard as pay-later-link). */
async function saveMandate(supabase, order, fn) {
  const cart = PL.withMeta(order, (m) => ({ ...m, mandate: fn((m && m.mandate) || {}) }));
  const { data, error } = await supabase.from('orders').update({ cart_items: cart })
    .eq('id', order.id).is('razorpay_payment_id', null).select('id');
  if (error) throw new Error(error.message);
  return Array.isArray(data) && data.length ? { ...order, cart_items: cart } : null;
}

/**
 * Step 1 (after the request is placed): the Razorpay customer and the
 * approval order. Returns what Razorpay Checkout needs.
 * kyc = { pan_name, account, ifsc } (emandate only).
 */
async function startMandate(supabase, order, method, kyc, deps = {}) {
  if (!['upi', 'emandate'].includes(method)) throw Object.assign(new Error('Choose UPI AutoPay or bank mandate.'), { status: 400 });
  if (!PL.isUnpaidPayLater(order)) throw Object.assign(new Error('This order is already paid.'), { status: 409 });
  if (!['pay_later_review', 'confirmed'].includes(order.status)) throw Object.assign(new Error(`This order is ${order.status}.`), { status: 409 });
  const cur = mandateOf(order);
  if (cur && ['active', 'pending'].includes(cur.status)) return { already: true, status: cur.status };

  const maxAmount = Math.max(100, Math.round(Number(order.amount_paise) || 0));
  const customer = cur && cur.customer_id ? { id: cur.customer_id } : await rp('POST', '/customers', {
    name: String(order.customer_name || 'Customer').slice(0, 50),
    ...(order.customer_email ? { email: order.customer_email } : {}),
    ...(contactOf(order) ? { contact: contactOf(order) } : {}),
    fail_existing: '0',
  }, deps);
  const expireAt = Math.floor(Date.now() / 1000) + MANDATE_DAYS * 86400;
  const notes = { kind: KIND_AUTH, order_id: idOf(order) };
  const token = method === 'upi'
    ? { max_amount: maxAmount, expire_at: expireAt, frequency: 'as_presented' }
    : { auth_type: 'netbanking', max_amount: maxAmount, expire_at: expireAt,
        bank_account: { beneficiary_name: String(kyc.pan_name || order.customer_name || '').slice(0, 120),
          account_number: String(kyc.account || ''), account_type: 'savings', ifsc_code: String(kyc.ifsc || '').toUpperCase() } };
  const authOrder = await rp('POST', '/orders', {
    amount: method === 'upi' ? 100 : 0, currency: 'INR', customer_id: customer.id, method,
    ...(method === 'emandate' ? { payment_capture: true } : {}),
    receipt: `PLM-${idOf(order)}`.slice(0, 40), notes, token,
  }, deps);
  const saved = await saveMandate(supabase, order, (m) => ({
    ...m, method, status: 'started', customer_id: customer.id, auth_order_id: authOrder.id,
    max_amount: maxAmount, started_at: new Date().toISOString(),
  }));
  if (!saved) throw Object.assign(new Error('This order changed. Please refresh.'), { status: 409 });
  return {
    key_id: process.env.RAZORPAY_KEY_ID || (deps.keyId || ''), order_id: authOrder.id, customer_id: customer.id,
    amount: authOrder.amount, method, notes,
  };
}

function signatureOk(orderId, paymentId, signature) {
  const { secret } = creds();
  const want = crypto.createHmac('sha256', secret).update(`${orderId}|${paymentId}`).digest('hex');
  const a = Buffer.from(want); const b = Buffer.from(String(signature || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Step 2: the approval came back (browser handler or webhook). Reads the
 * payment to get the token. UPI is live at once; a bank mandate is "pending"
 * until the bank confirms it (refreshMandate / token.confirmed).
 */
async function recordApproval(supabase, order, paymentId, deps = {}) {
  const m = mandateOf(order);
  if (!m || !m.auth_order_id) return { ok: false, error: 'No AutoPay was started for this order.' };
  if (['active', 'pending'].includes(m.status) && m.auth_payment_id === paymentId) return { ok: true, status: m.status, already: true };
  const pay = await rp('GET', `/payments/${encodeURIComponent(paymentId)}`, null, deps);
  if (pay.order_id !== m.auth_order_id) return { ok: false, error: 'That payment is not this order\'s AutoPay approval.' };
  if (!['authorized', 'captured'].includes(pay.status)) return { ok: false, error: `AutoPay approval is ${pay.status}.` };
  const status = m.method === 'upi' ? 'active' : 'pending';
  const saved = await saveMandate(supabase, order, (x) => ({
    ...x, status, auth_payment_id: paymentId, token_id: pay.token_id || x.token_id || '', set_at: new Date().toISOString(),
  }));
  if (!saved) return { ok: false, error: 'Order changed.' };
  if (status === 'pending') await refreshMandate(supabase, saved, deps).catch(() => null);
  return { ok: true, status };
}

/** Bank mandates: asks Razorpay whether the bank has confirmed the token yet. */
async function refreshMandate(supabase, order, deps = {}) {
  const m = mandateOf(order);
  if (!m || m.status !== 'pending' || !m.customer_id) return { ok: true, skipped: true };
  const list = await rp('GET', `/customers/${encodeURIComponent(m.customer_id)}/tokens`, null, deps);
  const items = (list && list.items) || [];
  const tok = items.find((t) => t.id === m.token_id) || (!m.token_id && items.find((t) => t.method === 'emandate')) || null;
  const st = tok && tok.recurring_details && tok.recurring_details.status;
  if (st === 'confirmed') { await saveMandate(supabase, order, (x) => ({ ...x, status: 'active', token_id: tok.id, confirmed_at: new Date().toISOString() })); return { ok: true, status: 'active' }; }
  if (st === 'rejected' || st === 'cancelled') { await saveMandate(supabase, order, (x) => ({ ...x, status: 'failed', token_id: tok.id, fail_reason: (tok.recurring_details && tok.recurring_details.failure_reason) || st })); return { ok: true, status: 'failed' }; }
  return { ok: true, status: 'pending' };
}

/**
 * Charges an active mandate for the order total, once. Razorpay sends the
 * pre-debit notice and debits later; payment.captured (notes kind pay_later)
 * then marks the order paid through the ordinary Pay Later webhook branch.
 */
async function chargeMandate(supabase, order, deps = {}) {
  const m = mandateOf(order);
  if (!m || m.status !== 'active' || !m.token_id) return { ok: false, error: 'No active AutoPay' };
  if (m.charge_order_id) return { ok: true, already: true };
  if (!PL.isUnpaidPayLater(order)) return { ok: false, error: 'Already paid' };
  const amount = Math.round(Number(order.amount_paise) || 0);
  if (amount < 100) return { ok: false, error: 'No amount due' };
  if (m.max_amount && amount > m.max_amount) return { ok: false, error: 'Order total is above the AutoPay limit' };
  const notes = { kind: 'pay_later', order_id: idOf(order), via: 'autopay' };
  const rpOrder = await rp('POST', '/orders', { amount, currency: 'INR', payment_capture: true, receipt: `PL-${idOf(order)}`.slice(0, 40), notes }, deps);
  // Saved before the debit call, so a crash in between can never charge twice.
  const saved = await saveMandate(supabase, order, (x) => ({ ...x, charge_order_id: rpOrder.id, charge_status: 'pending', charged_at: new Date().toISOString() }));
  if (!saved) return { ok: false, error: 'Order changed (already paid?)' };
  try {
    const pay = await rp('POST', '/payments/create/recurring', {
      email: order.customer_email || 'void@razorpay.com', contact: contactOf(saved) || '+919999999999',
      amount, currency: 'INR', order_id: rpOrder.id, customer_id: m.customer_id, token: m.token_id,
      recurring: true, description: `Ink & Chai Pay Later ${idOf(order)}`.slice(0, 50), notes,
    }, deps);
    await saveMandate(supabase, saved, (x) => ({ ...x, charge_payment_id: pay.razorpay_payment_id || '' }));
    return { ok: true, payment_id: pay.razorpay_payment_id || '' };
  } catch (e) {
    await saveMandate(supabase, saved, (x) => ({ ...x, charge_status: 'failed', charge_error: String(e.message).slice(0, 200) }));
    return { ok: false, error: e.message };
  }
}

/** Hourly net under the webhook: did the debit go through, or has it given up? */
async function syncCharge(supabase, order, deps = {}) {
  const now = deps.now || Date.now();
  const m = mandateOf(order);
  if (!m || m.charge_status !== 'pending' || !m.charge_order_id) return { ok: true, skipped: true };
  const list = await rp('GET', `/orders/${encodeURIComponent(m.charge_order_id)}/payments`, null, deps);
  const pays = (list && list.items) || [];
  const captured = pays.find((p) => p.status === 'captured');
  if (captured) {
    const done = await require('./pay-later-link').markPayLaterPaid(supabase, order, { paymentId: captured.id, how: 'autopay' }, deps);
    return { ok: true, paid: !!(done && done.ok) };
  }
  const old = now - Date.parse(m.charged_at || 0) >= CHARGE_GIVE_UP_MS;
  if (old && !pays.some((p) => ['created', 'authorized'].includes(p.status))) {
    const why = pays.length ? String(pays[pays.length - 1].error_description || 'debit failed') : 'no debit after 4 days';
    await saveMandate(supabase, order, (x) => ({ ...x, charge_status: 'failed', charge_error: why.slice(0, 200) }));
    return { ok: true, failed: true };
  }
  return { ok: true, status: 'pending' };
}

/** Cancels the mandate (declined order, or paid another way). Never throws. */
async function cancelMandate(supabase, order, deps = {}) {
  const m = mandateOf(order);
  if (!m || !m.customer_id || !m.token_id || m.status === 'cancelled') return { ok: true, skipped: true };
  try {
    if (m.method === 'upi') await rp('PUT', `/customers/${encodeURIComponent(m.customer_id)}/tokens/${encodeURIComponent(m.token_id)}/cancel`, null, deps);
    else await rp('DELETE', `/customers/${encodeURIComponent(m.customer_id)}/tokens/${encodeURIComponent(m.token_id)}`, null, deps);
  } catch (e) {
    console.warn('[pay-later-mandate] cancel failed', idOf(order), e.message);
    return { ok: false, error: e.message };
  }
  // A paid order no longer passes saveMandate's unpaid guard; write directly.
  const cart = PL.withMeta(order, (x) => ({ ...x, mandate: { ...((x && x.mandate) || {}), status: 'cancelled', cancelled_at: new Date().toISOString() } }));
  await supabase.from('orders').update({ cart_items: cart }).eq('id', order.id);
  return { ok: true };
}

/** Webhook helper: finds the Pay Later order for a mandate approval or debit. */
async function orderForRazorpayOrder(supabase, rpOrderId) {
  if (!rpOrderId) return null;
  for (const col of ['auth_order_id', 'charge_order_id']) {
    const { data } = await supabase.from('orders').select('*')
      .eq(`cart_items->0->_payment->mandate->>${col}`, rpOrderId).limit(1);
    if (data && data.length) return { order: data[0], kind: col === 'auth_order_id' ? 'auth' : 'charge' };
  }
  return null;
}

module.exports = {
  startMandate, recordApproval, refreshMandate, chargeMandate, syncCharge, cancelMandate,
  signatureOk, keyMatches, hashKey, newKey, mandateOf, orderForRazorpayOrder, KIND_AUTH, MANDATE_DAYS, CHARGE_GIVE_UP_MS,
};
