/**
 * Netlify Function: pay-later-mandate   (public, POST)
 *
 * The AutoPay step shown right after a Pay Later request (utils/pay-later-mandate).
 * Only the browser that placed the request can use it: pay-later-order hands
 * it a one-off key and keeps only its hash.
 *
 *   { action:'start',  order, key, method:'upi'|'emandate' } → Razorpay Checkout options
 *   { action:'verify', order, key, razorpay_payment_id, razorpay_order_id, razorpay_signature }
 *        → { ok, status: 'active' (UPI) | 'pending' (bank confirms in 1–2 days) }
 */
const { createClient } = require('@supabase/supabase-js');
const PL = require('./utils/pay-later');
const M = require('./utils/pay-later-mandate');
const { r2GetObject, r2EbookConfig } = require('./utils/r2-put');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
};
const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });

async function kycOf(order) {
  const prefix = (PL.payLaterMeta(order) || {}).kyc;
  if (!prefix) return null;
  const rec = await r2GetObject(r2EbookConfig(), `${prefix}kyc.json`);
  if (!rec.ok) return null;
  const k = JSON.parse(Buffer.from(rec.body).toString('utf8'));
  return { pan_name: k.name_on_pan, account: k.bank_account, ifsc: k.ifsc };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });
  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }
  const oid = String(body.order || '').trim().toUpperCase();
  if (!/^IC-[A-Z0-9-]{5,40}$/.test(oid)) return json(400, { error: 'Unknown order' });

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  try {
    const { data: order, error } = await supabase.from('orders').select('*').eq('razorpay_order_id', oid).maybeSingle();
    if (error) throw new Error(error.message);
    if (!order || !PL.isPayLater(order) || !M.keyMatches(order, body.key)) return json(403, { error: 'This AutoPay link is not valid. Please message us on WhatsApp.' });

    if (body.action === 'start') {
      const method = body.method === 'emandate' ? 'emandate' : 'upi';
      let kyc = null;
      if (method === 'emandate') {
        kyc = await kycOf(order);
        if (!kyc || !kyc.account || !kyc.ifsc) return json(503, { error: 'We could not read your bank details just now. Please use UPI AutoPay or try again in a minute.' });
      }
      const out = await M.startMandate(supabase, order, method, kyc);
      return json(200, { ok: true, ...out, name: order.customer_name || '', email: order.customer_email || '', contact: order.customer_phone || '' });
    }

    if (body.action === 'verify') {
      const m = M.mandateOf(order) || {};
      const payId = String(body.razorpay_payment_id || '');
      if (!payId || String(body.razorpay_order_id || '') !== m.auth_order_id) return json(400, { error: 'This approval does not match your order.' });
      if (!M.signatureOk(m.auth_order_id, payId, body.razorpay_signature)) return json(400, { error: 'We could not verify the approval. Please try again.' });
      const r = await M.recordApproval(supabase, order, payId);
      if (r.ok) await require('./utils/pay-later-notify').ownerAlert(`🔁 AutoPay ${m.method === 'upi' ? 'UPI' : 'bank mandate'} ${r.status === 'active' ? 'set up' : 'sent to the bank'} for Pay Later ${oid}`).catch(() => null);
      return json(r.ok ? 200 : 409, r);
    }
    return json(400, { error: 'Unknown action' });
  } catch (e) {
    console.error('[pay-later-mandate]', oid, e.message);
    return json(e.status || 502, { error: e.status ? e.message : `AutoPay could not be started: ${e.message}` });
  }
};
