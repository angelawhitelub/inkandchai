/**
 * Netlify Function: pay-later-order   (public, checkout)
 *   POST { cart, customer, coupon?, kyc: { pan, pan_name, account, account_confirm, ifsc, consent },
 *          pan_image: { type, data(base64) } }
 *   → { success, order_id, amount }
 *
 * Places a Pay Later order that waits for the owner (utils/pay-later): status
 * pay_later_review, so no courier path will touch it until it is approved.
 * Every rule is enforced here, whatever the browser showed: feature on, every
 * book selected, MIN_DELIVERED delivered orders on this phone, valid KYC.
 *
 * The PAN photo and bank details go ONLY to the private R2 bucket under
 * pay-later-kyc/<order id>/. The order row carries just the R2 prefix.
 */
const { createClient } = require('@supabase/supabase-js');
const PL = require('./utils/pay-later');
const notify = require('./utils/pay-later-notify');
const { resolveCartPrices, makeOrderId } = require('./utils/pricing');
const { pincodeRejection } = require('./utils/pincode-valid');
const { findShippingRestriction } = require('./utils/shipping-restrictions');
const { orderShipping } = require('./utils/free-delivery');
const { siteSaleDiscount } = require('./utils/site-sale');
const { r2PutObject, r2EbookConfig, r2EbookConfigured } = require('./utils/r2-put');
const { mirrorOrder } = require('./utils/order-fallback');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
};
const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });

/** Private bucket: the eBook bucket, which has no public URL at all. */
function kycStore() {
  return { ...r2EbookConfig(), publicBase: 'https://private.invalid' };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });
  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid request.' }); }

  const customer = body.customer || {};
  const rawCart = body.cart;
  if (!Array.isArray(rawCart) || !rawCart.length || !customer.phone) return json(400, { error: 'Missing cart or phone.' });
  if (!String(customer.name || '').trim() || !/^\S+@\S+\.\S+$/.test(String(customer.email || ''))) {
    return json(400, { error: 'Please fill in your name and email above.' });
  }

  const cfg = await PL.config();
  if (!cfg.enabled) return json(403, { error: 'Pay Later is not available right now.', code: 'pay_later_off' });
  if (!r2EbookConfigured()) return json(503, { error: 'Pay Later is not available right now. Please try again later.', code: 'pay_later_storage' });

  const kyc = PL.cleanKyc(body.kyc);
  const problem = PL.kycProblem(kyc);
  if (problem) return json(400, { error: problem, code: 'pay_later_kyc' });
  const img = PL.decodeImage(body.pan_image);
  if (!img.ok) return json(400, { error: img.error, code: 'pay_later_kyc' });

  {
    const bad = await pincodeRejection(customer);
    if (bad) return json(400, bad);
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const priced = await resolveCartPrices(rawCart, supabase, { discountGrants: body.discount_grants });
  if (!priced.cart.length) return json(400, { error: 'No catalogue items in cart.' });
  const cart = priced.cart;
  if (PL.cartCoverage(cart, cfg) !== 'all') {
    return json(400, { error: 'Pay Later works only when every book in your cart is a Pay Later title.', code: 'pay_later_cart' });
  }
  const restriction = findShippingRestriction(cart, customer);
  if (restriction.blocked) return json(400, restriction);

  let elig;
  try { elig = await PL.eligibility(supabase, cfg, customer.phone); }
  catch (e) { console.error('[pay-later-order] eligibility', e.message); return json(503, { error: 'We could not check Pay Later right now. Please try again in a minute.' }); }
  if (!elig.eligible) return json(403, { error: PL.NOT_ELIGIBLE, code: 'pay_later_not_eligible' });
  const delivered = elig.delivered;

  // One open request per phone at a time; a double tap returns the first one.
  const ten = PL.phone10(customer.phone);
  {
    const { data: open } = await supabase.from('orders')
      .select('razorpay_order_id, amount_paise, created_at')
      .like('customer_phone', `%${ten}`).eq('status', PL.REVIEW_STATUS)
      .order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (open) {
      const recent = Date.now() - Date.parse(open.created_at) < 10 * 60 * 1000;
      if (recent) return json(200, { success: true, order_id: open.razorpay_order_id, amount: Math.round(open.amount_paise / 100), deduped: true });
      return json(409, { error: `You already have a Pay Later request (${open.razorpay_order_id}) waiting for confirmation. Please wait for our reply before placing another.`, code: 'pay_later_open' });
    }
  }

  const subtotal = priced.subtotal;
  const shipping = orderShipping(cart, subtotal, 'cod');
  const sale = siteSaleDiscount(subtotal, Date.now(), body.coupon);
  const total = Math.max(1, subtotal + shipping - sale.discount);
  if (sale.code && cart[0]) cart[0]._coupon = { code: sale.code, discount: sale.discount, source: sale.source };

  const orderId = await makeOrderId('IC', cart);
  const prefix = PL.kycPrefix(orderId);
  const now = new Date().toISOString();

  // KYC first: an order the owner cannot check is an order they cannot approve.
  try {
    await r2PutObject(kycStore(), { key: `${prefix}pan.${img.ext}`, body: img.buffer, contentType: img.type });
    const record = {
      order_id: orderId, submitted_at: now,
      name_on_pan: kyc.pan_name, pan: kyc.pan, bank_account: kyc.account, ifsc: kyc.ifsc,
      pan_image: `${prefix}pan.${img.ext}`,
      consent: { text: PL.CONSENT_TEXT, at: now },
      customer: { name: customer.name || '', phone: customer.phone, email: customer.email || '' },
      ip: (event.headers && (event.headers['cf-connecting-ip'] || event.headers['x-forwarded-for'])) || '',
    };
    await r2PutObject(kycStore(), { key: `${prefix}kyc.json`, body: Buffer.from(JSON.stringify(record)), contentType: 'application/json' });
  } catch (e) {
    console.error('[pay-later-order] KYC upload failed', orderId, e.message);
    return json(503, { error: 'We could not save your PAN photo just now. Please try again in a minute.' });
  }

  cart[0]._payment = {
    mode: 'pay_later', state: 'review', applied_at: now, due_days: PL.DUE_DAYS,
    kyc: prefix, pan_name: kyc.pan_name, account_last4: kyc.account.slice(-4), delivered_orders: delivered, allowed_by_owner: elig.allowed,
  };
  const row = {
    razorpay_order_id: orderId,
    razorpay_payment_id: null,
    amount_paise: Math.round(total * 100),
    status: PL.REVIEW_STATUS,
    shipment_payment_type: 'prepaid',
    customer_name: customer.name || '',
    customer_email: customer.email || '',
    customer_phone: customer.phone,
    customer_address: customer.address || '',
    cart_items: cart,
    user_id: body.user_id || null,
    source: 'pay_later',
  };
  await mirrorOrder(event, row, { source: 'pay-later-order' });
  const { error } = await supabase.from('orders').insert(row);
  if (error) {
    // Not stashed for replay: the owner still has to look at it, and the
    // customer is better told now than surprised later.
    console.error('[pay-later-order] insert failed', orderId, error.message);
    await notify.ownerAlert(`⚠️ Pay Later order ${orderId} could not be saved: ${error.message}. KYC is in R2 at ${prefix}.`);
    return json(500, { error: 'We could not place your Pay Later request just now. Please try again in a minute.' });
  }

  await notify.requestReceived(row);
  await notify.ownerAlert(`💳 New Pay Later request ${orderId}\n${customer.name || ''} · ${customer.phone}\n₹${total.toLocaleString('en-IN')} · ${elig.allowed ? 'on your Pay Later customer list' : `${delivered} delivered orders before`}\nName on PAN: ${kyc.pan_name}\nReview it in admin → 💳 Pay Later.`);
  return json(200, { success: true, order_id: orderId, amount: total });
};
