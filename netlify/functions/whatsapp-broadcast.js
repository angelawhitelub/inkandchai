/**
 * Netlify Function: whatsapp-broadcast
 * POST /.netlify/functions/whatsapp-broadcast
 *
 * Send a one-off WhatsApp template message to every past customer.
 * Used to re-engage existing customers when paid ads are down.
 *
 * Body:
 *   {
 *     template:     "broadcast_reengage_v1",   // approved Meta template name
 *     days_back:    60,                         // only customers from last N days (default 60)
 *     dry_run:      false,                      // true = only return list, don't send
 *     limit:        null,                       // cap recipients (for testing)
 *     test_phone:   "919999999999",            // send ONLY to this phone (overrides everything)
 *   }
 *
 * Auth: requires X-Admin-Key header.
 *
 * Rate limit:
 *   WhatsApp Cloud API allows ~80 msgs/sec for Business-tier numbers.
 *   We send in batches of 20 with 250ms gap to stay well under that.
 *
 * Dedupe: customers are deduplicated by phone (most recent name kept).
 *
 * Throttling: max 5000 sends per invocation (Netlify 10-second timeout safety).
 *   For bigger lists, call repeatedly with offset support (TODO).
 */

const { createClient } = require('@supabase/supabase-js');
const { sendWhatsApp, normalizePhone } = require('./utils/whatsapp');

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key',
  'Content-Type': 'application/json',
};

const BATCH_SIZE   = 20;
const BATCH_DELAY  = 250;  // ms between batches (stays under 80 msg/sec limit)
const MAX_PER_RUN  = 5000;

const sleep = ms => new Promise(r => setTimeout(r, ms));

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST')    return { statusCode: 405, headers: CORS, body: 'Method Not Allowed' };

  // ── Auth ────────────────────────────────────────────────────────────────────
  const adminKey = process.env.ADMIN_SECRET;
  const sentKey  = event.headers['x-admin-key'] || event.headers['X-Admin-Key'];
  if (!adminKey || sentKey !== adminKey) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Bad JSON' }) }; }

  const template   = String(body.template || '').trim();
  const daysBack   = Math.max(1, Math.min(365, parseInt(body.days_back) || 60));
  const dryRun     = !!body.dry_run;
  const limit      = body.limit ? Math.max(1, parseInt(body.limit)) : MAX_PER_RUN;
  const testPhone  = body.test_phone ? normalizePhone(body.test_phone) : null;
  const lang       = String(body.lang || 'en').trim();

  if (!template) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({
      error: 'Missing "template" — pass the approved Meta WhatsApp template name',
    }) };
  }

  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // ── Build recipient list ────────────────────────────────────────────────
    let recipients;

    if (testPhone) {
      recipients = [{ phone: testPhone, name: 'Test' }];
    } else {
      const since = new Date(Date.now() - daysBack * 24 * 3600 * 1000).toISOString();

      // Pull paid/delivered/shipped customers (skip cancelled/refunded so we don't poke unhappy ones)
      const { data, error } = await supabase
        .from('orders')
        .select('customer_phone, customer_name, created_at, status')
        .in('status', ['paid', 'delivered', 'shipped', 'out_for_delivery',
                       'cod_pending', 'partial_cod_pending', 'confirmed'])
        .gte('created_at', since)
        .order('created_at', { ascending: false })
        .limit(20000);

      if (error) throw new Error('DB query failed: ' + error.message);

      // Dedupe by phone — keep most recent name (data is already DESC by created_at)
      const seen = new Map();
      for (const r of (data || [])) {
        const phone = normalizePhone(r.customer_phone);
        if (!phone) continue;
        if (!seen.has(phone)) {
          seen.set(phone, { phone, name: (r.customer_name || 'there').split(' ')[0] });
        }
      }

      recipients = Array.from(seen.values()).slice(0, limit);
    }

    if (!recipients.length) {
      return { statusCode: 200, headers: CORS, body: JSON.stringify({
        success: true, message: 'No recipients found', total: 0,
      }) };
    }

    // ── Dry run: return the list without sending ────────────────────────────
    if (dryRun) {
      return { statusCode: 200, headers: CORS, body: JSON.stringify({
        success: true,
        dry_run: true,
        total: recipients.length,
        sample: recipients.slice(0, 10).map(r => ({
          phone: r.phone.slice(0, 4) + '****' + r.phone.slice(-3),
          name: r.name,
        })),
        message: `Would send template "${template}" to ${recipients.length} recipients. Set dry_run:false to actually send.`,
      }) };
    }

    // ── Send in batches ─────────────────────────────────────────────────────
    let sent = 0, failed = 0;
    const failures = [];

    for (let i = 0; i < recipients.length; i += BATCH_SIZE) {
      const batch = recipients.slice(i, i + BATCH_SIZE);

      // Fire batch in parallel
      const results = await Promise.allSettled(batch.map(async r => {
        try {
          // Pass first name as template parameter {{1}}
          await sendWhatsApp({
            to: r.phone,
            template,
            params: [r.name],
            lang,
          });
          return { phone: r.phone, ok: true };
        } catch (e) {
          return { phone: r.phone, ok: false, error: e.message };
        }
      }));

      for (const res of results) {
        if (res.status === 'fulfilled' && res.value.ok) {
          sent++;
        } else {
          failed++;
          const reason = res.status === 'rejected' ? res.reason?.message : res.value?.error;
          if (failures.length < 20) failures.push({ phone: res.value?.phone, error: reason });
        }
      }

      if (i + BATCH_SIZE < recipients.length) await sleep(BATCH_DELAY);
    }

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        success: true,
        template,
        total: recipients.length,
        sent,
        failed,
        sample_failures: failures,
      }),
    };

  } catch (err) {
    console.error('[whatsapp-broadcast] error:', err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
