/**
 * Netlify Function: add-review
 * POST /.netlify/functions/add-review   (admin only)
 *
 * Lets the store owner add a genuine customer review collected off-platform
 * (Instagram DMs, WhatsApp feedback, etc.) directly to a product page —
 * useful when the delivery webhook isn't marking orders delivered, so the
 * normal customer review flow (which requires a delivered order) can't run.
 *
 * IMPORTANT: this is for REAL customer feedback you've actually received.
 * Reviews added here default to verified_buyer=false (no linked order), so
 * they show as regular reviews, not "Verified Buyer". They are approved
 * immediately so they appear on the product page.
 *
 * Body: { product_slug, customer_name, rating (1-5), comment,
 *         verified_buyer?, created_at? }
 * Auth: X-Admin-Key header.
 */

const { createClient } = require('@supabase/supabase-js');
const { requireAdmin } = require('./utils/admin-auth');
const { orderIdFilter } = require('./utils/order-id-filter');

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key',
  'Content-Type': 'application/json',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST')    return { statusCode: 405, headers: CORS, body: 'Method Not Allowed' };

  const _adminBlock = requireAdmin(event, CORS); if (_adminBlock) return _adminBlock;
  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Bad JSON' }) }; }

  const productSlug = String(body.product_slug || '').trim();
  const name        = String(body.customer_name || '').trim().slice(0, 80);
  const comment     = String(body.comment || '').trim().slice(0, 1000);
  const rating      = parseInt(body.rating, 10);
  let   verified    = !!body.verified_buyer;
  let   createdAt   = String(body.created_at || '').trim();
  const orderIdIn   = String(body.order_id || '').trim();

  if (!productSlug) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'product_slug is required' }) };
  if (!name)        return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'customer_name is required' }) };
  if (!(rating >= 1 && rating <= 5)) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'rating must be 1–5' }) };

  // Validate/normalise created_at (allow backdating to a real review date)
  let createdIso = new Date().toISOString();
  if (createdAt) {
    const d = new Date(createdAt);
    if (!isNaN(d.getTime()) && d.getTime() <= Date.now()) createdIso = d.toISOString();
  }

  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // If a real order ID is supplied, look it up: confirm it exists, pull the
    // customer email, and treat it as a genuine verified-buyer review.
    let orderId = '';
    let customerEmail = '';
    if (orderIdIn) {
      const filter = orderIdFilter(orderIdIn);
      const { data: ord } = filter
        ? await supabase
            .from('orders')
            .select('razorpay_order_id,id,customer_email')
            .or(filter)
            .maybeSingle()
        : { data: null };
      if (!ord) {
        return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: `Order "${orderIdIn}" not found. Leave Order ID blank to add without linking, or check the ID.` }) };
      }
      orderId = ord.razorpay_order_id || ord.id;
      customerEmail = ord.customer_email || '';
      verified = true;  // a real, found order ⇒ genuine verified buyer

      // One review per order per product (matches submit-review's rule)
      const { data: dup } = await supabase
        .from('product_reviews')
        .select('id')
        .eq('order_id', orderId)
        .eq('product_slug', productSlug)
        .maybeSingle();
      if (dup) {
        return { statusCode: 409, headers: CORS, body: JSON.stringify({ error: 'This order already has a review for this product.' }) };
      }
    } else {
      // No real order — synthetic id (order_id is NOT NULL in the table)
      orderId = `MANUAL-${Date.now()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
    }

    const { data, error } = await supabase
      .from('product_reviews')
      .insert({
        order_id:       orderId,
        product_slug:   productSlug,
        rating,
        comment,
        customer_name:  name,
        customer_email: customerEmail,
        approved:       true,           // show immediately
        verified_buyer: verified,
        created_at:     createdIso,
      })
      .select('id')
      .single();

    if (error) throw error;
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ success: true, review_id: data.id }) };
  } catch (err) {
    console.error('[add-review] error:', err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
