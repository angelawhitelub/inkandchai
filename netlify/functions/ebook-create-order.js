/**
 * Netlify Function: ebook-create-order
 * POST { slug } → { order_id, amount, currency, key_id, title, already_owned? }
 *
 * Opens a Razorpay order for one eBook. Signed-in customers only.
 *
 * WHY SIGN-IN IS REQUIRED, WHEN BUYING A PAPER BOOK IS NOT
 * A physical order is proved by a parcel arriving at an address. A digital one
 * has no such anchor: whatever identifies the buyer IS the key to the file,
 * forever. Email alone would mean anyone who learns an address can download
 * that customer's library, so entitlements hang off an authenticated user id.
 *
 * WHY THE PRICE IS NOT IN THE REQUEST
 * Same reason create-order.js recomputes every cart line: the browser is
 * hostile. The amount comes from the ebooks table, and the slug it was charged
 * for is written into the Razorpay order's notes, where the customer cannot
 * reach it. ebook-verify-payment reads the slug back from there rather than
 * from the browser, so a paid ₹49 order cannot be redeemed for a ₹499 book.
 */

const Razorpay = require('razorpay');
const { createClient } = require('@supabase/supabase-js');
const { requireCustomer } = require('./utils/customer-auth');
const { normaliseSlug } = require('./utils/ebook');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};
const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const who = await requireCustomer(event, db);
  if (who.error) return json(who.status, { error: who.error });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: 'Invalid JSON' }); }

  const slug = normaliseSlug(body.slug);
  if (!slug) return json(400, { error: 'Which eBook?' });

  try {
    const { data: ebook, error } = await db
      .from('ebooks').select('*').eq('slug', slug).eq('active', true).maybeSingle();
    if (error) throw new Error(error.message);
    if (!ebook) return json(404, { error: 'That eBook is not available.' });

    // Charging twice for a file they already own would be indefensible, and it
    // is an easy double-tap on a slow connection. Send them to the library.
    const { data: owned } = await db.from('ebook_entitlements')
      .select('id').eq('slug', slug).eq('user_id', who.user.id).maybeSingle();
    if (owned) return json(200, { already_owned: true, slug, title: ebook.title });

    const rzp = new Razorpay({
      key_id: process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_KEY_SECRET,
    });

    const order = await rzp.orders.create({
      amount: ebook.price * 100,
      currency: 'INR',
      // Razorpay caps receipts at 40 characters.
      receipt: `eb_${Date.now()}`.slice(0, 40),
      notes: {
        kind: 'ebook',
        slug,
        user_id: who.user.id,
        title: String(ebook.title || '').slice(0, 100),
        // Read by utils/refund-guard.js to refuse the refund, and shown on the
        // payment in the Razorpay dashboard so a manual refund is a deliberate act.
        refund_policy: 'non-refundable',
      },
    });

    return json(200, {
      order_id: order.id,
      amount: order.amount,
      currency: order.currency,
      key_id: process.env.RAZORPAY_KEY_ID,
      slug,
      title: ebook.title,
      email: who.user.email || '',
    });
  } catch (e) {
    console.error('[ebook-create-order]', e.message);
    return json(500, { error: 'Could not start the payment. Please try again.' });
  }
};
