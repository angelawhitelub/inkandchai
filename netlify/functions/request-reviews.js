/**
 * Netlify Function: request-reviews
 * POST /.netlify/functions/request-reviews
 *
 * Bulk-asks DELIVERED customers to leave a review — for reputation building
 * (and to satisfy Google Merchant "show your online reputation"). Each
 * customer gets a personalised review link (/review/?order=IC-…) so the
 * review page knows which order/books to show, plus a ₹50 scratch-card
 * incentive line in the approved WhatsApp template.
 *
 * Body:
 *   {
 *     template:   "review_request_v1",  // approved Meta template (3 vars)
 *     days_back:  90,                    // delivered in the last N days
 *     dry_run:    false,                 // true = count + sample only
 *     limit:      null,                  // cap recipients
 *     test_phone: "9199...",             // send only to this number
 *     lang:       "en",
 *   }
 *
 * Template variables: {{1}}=first name, {{2}}=book title, {{3}}=review link
 * Auth: X-Admin-Key header.
 *
 * Dedup: one request per phone (most recent delivered order). If the orders
 * table has a `review_requested_at` column it's used to skip already-asked
 * customers and is stamped after sending; if the column doesn't exist the
 * function still works (just without cross-run dedup).
 */

const { createClient } = require('@supabase/supabase-js');
const { sendWhatsApp, normalizePhone } = require('./utils/whatsapp');
const { isValidIndianMobile } = require('./utils/spam-filter');
const { requireAdmin } = require('./utils/admin-auth');
const { signReviewToken } = require('./utils/review-token');

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key',
  'Content-Type': 'application/json',
};

const BATCH_SIZE  = 20;
const BATCH_DELAY = 250;
const MAX_PER_RUN = 3000;
const sleep = ms => new Promise(r => setTimeout(r, ms));

function firstBookTitle(order) {
  const items = Array.isArray(order.cart_items) ? order.cart_items : [];
  const t = items[0]?.title || items[0]?.name || '';
  return String(t).replace(/\s+/g, ' ').trim().slice(0, 60) || 'your books';
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST')    return { statusCode: 405, headers: CORS, body: 'Method Not Allowed' };

  const _adminBlock = requireAdmin(event, CORS); if (_adminBlock) return _adminBlock;
  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Bad JSON' }) }; }

  const template  = String(body.template || 'review_request_v1').trim();
  const daysBack  = Math.max(1, Math.min(365, parseInt(body.days_back) || 90));
  const dryRun    = !!body.dry_run;
  const limit     = body.limit ? Math.max(1, parseInt(body.limit)) : MAX_PER_RUN;
  const testPhone = body.test_phone ? normalizePhone(body.test_phone) : null;
  const lang      = String(body.lang || 'en').trim();

  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // ── Build recipient list ────────────────────────────────────────────────
    let recipients;

    if (testPhone) {
      const { data } = await supabase
        .from('orders')
        .select('razorpay_order_id,id,customer_name,customer_phone,cart_items,delivered_at')
        .eq('status', 'delivered')
        .order('delivered_at', { ascending: false })
        .limit(1);
      const o = (data || [])[0] || {};
      recipients = [{
        phone: testPhone,
        name: (o.customer_name || 'there').split(' ')[0],
        orderId: o.razorpay_order_id || o.id || 'TEST',
        book: firstBookTitle(o),
      }];
    } else {
      const since = new Date(Date.now() - daysBack * 24 * 3600 * 1000).toISOString();

      // Try with the dedup column first; fall back if it doesn't exist.
      let data, error, hasReqCol = true;
      ({ data, error } = await supabase
        .from('orders')
        .select('razorpay_order_id,id,customer_name,customer_phone,cart_items,delivered_at,review_requested_at')
        .eq('status', 'delivered')
        .gte('delivered_at', since)
        .is('review_requested_at', null)
        .order('delivered_at', { ascending: false })
        .limit(20000));
      if (error && /review_requested_at/.test(error.message || '')) {
        hasReqCol = false;
        ({ data, error } = await supabase
          .from('orders')
          .select('razorpay_order_id,id,customer_name,customer_phone,cart_items,delivered_at')
          .eq('status', 'delivered')
          .gte('delivered_at', since)
          .order('delivered_at', { ascending: false })
          .limit(20000));
      }
      if (error) throw new Error('DB query failed: ' + error.message);

      // Dedup by phone (keep most recent delivered order — already DESC)
      const seen = new Map();
      for (const o of (data || [])) {
        if (!isValidIndianMobile(o.customer_phone)) continue;
        const phone = normalizePhone(o.customer_phone);
        if (seen.has(phone)) continue;
        seen.set(phone, {
          phone,
          name: (o.customer_name || 'there').split(' ')[0],
          orderId: o.razorpay_order_id || o.id,
          book: firstBookTitle(o),
          _rowId: o.id,
          _hasReqCol: hasReqCol,
        });
      }
      recipients = Array.from(seen.values()).slice(0, limit);
    }

    if (!recipients.length) {
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ success: true, message: 'No eligible delivered customers found', total: 0 }) };
    }

    // The `t` token is what lets a guest buyer submit without an account --
    // submit-review takes it as proof we sent this link. Without it every
    // submission 401s, which is how this table stayed empty.
    const reviewLink = (oid) => {
      const t = signReviewToken(oid);
      return `https://inkandchai.in/review/?order=${encodeURIComponent(oid)}`
        + (t ? `&t=${encodeURIComponent(t)}` : '');
    };

    // ── Dry run ─────────────────────────────────────────────────────────────
    if (dryRun) {
      return { statusCode: 200, headers: CORS, body: JSON.stringify({
        success: true, dry_run: true, total: recipients.length,
        sample: recipients.slice(0, 10).map(r => ({
          phone: r.phone.slice(0,4) + '****' + r.phone.slice(-3),
          name: r.name, book: r.book, link: reviewLink(r.orderId),
        })),
        message: `Would ask ${recipients.length} delivered customers for a review using template "${template}".`,
      }) };
    }

    // ── Send in batches ─────────────────────────────────────────────────────
    let sent = 0, failed = 0;
    const failures = [];
    const stampIds = [];

    for (let i = 0; i < recipients.length; i += BATCH_SIZE) {
      const batch = recipients.slice(i, i + BATCH_SIZE);
      const results = await Promise.allSettled(batch.map(async r => {
        try {
          await sendWhatsApp({
            to: r.phone, template, lang,
            params: [r.name, r.book, reviewLink(r.orderId)],
          });
          if (r._rowId && r._hasReqCol) stampIds.push(r._rowId);
          return { ok: true };
        } catch (e) { return { ok: false, phone: r.phone, error: e.message }; }
      }));
      for (const res of results) {
        if (res.status === 'fulfilled' && res.value.ok) sent++;
        else { failed++; const v = res.value || {}; if (failures.length < 20) failures.push({ phone: v.phone, error: v.error || res.reason?.message }); }
      }
      if (i + BATCH_SIZE < recipients.length) await sleep(BATCH_DELAY);
    }

    // ── Stamp review_requested_at so we don't re-ask (best-effort) ──────────
    if (stampIds.length) {
      const nowIso = new Date().toISOString();
      // chunk updates to stay within URL/payload limits
      for (let i = 0; i < stampIds.length; i += 200) {
        await supabase.from('orders')
          .update({ review_requested_at: nowIso })
          .in('id', stampIds.slice(i, i + 200))
          .then(() => {}, () => {});
      }
    }

    return { statusCode: 200, headers: CORS, body: JSON.stringify({
      success: true, template, total: recipients.length, sent, failed, sample_failures: failures,
    }) };

  } catch (err) {
    console.error('[request-reviews] error:', err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
