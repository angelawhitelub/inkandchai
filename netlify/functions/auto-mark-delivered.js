/**
 * Netlify Function: auto-mark-delivered
 * Scheduled: runs daily at 4 AM UTC (9:30 AM IST)
 * Manual:    POST with X-Admin-Key header
 *
 * The Problem We're Solving:
 * NimbusPost (and downstream couriers) consistently fire "shipped" + "out_for_delivery"
 * webhook events but FREQUENTLY skip the final "delivered" event. This left 335+
 * orders stuck in OFD even after physical delivery, blocking returns (the return
 * window is gated on `delivered_at`) and breaking the order timeline.
 *
 * The Fix:
 * Time-based heuristic. If a package has been "shipped" or "out_for_delivery" for
 * more than N days, mark it delivered. The reasoning:
 *   - Average delivery in India is 3-5 days
 *   - Couriers reliably fire RTO/NDR/Lost events when delivery FAILS
 *   - So absence of any failure event after 7 days = success
 *
 * Thresholds (intentionally conservative):
 *   - out_for_delivery → delivered after 3 days
 *   - shipped (never went OFD) → delivered after 8 days
 *
 * Webhooks still own real-time events. This is only the backstop.
 */

const { createClient } = require('@supabase/supabase-js');
const { sendWhatsApp } = require('./utils/whatsapp');
const { sendEmail }    = require('./utils/email');
const { requireAdmin } = require('./utils/admin-auth');

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key',
  'Content-Type': 'application/json',
};

const OFD_DAYS_THRESHOLD     = 3;   // OFD for 3+ days → delivered
const SHIPPED_DAYS_THRESHOLD = 8;   // shipped (no OFD ever) for 8+ days → delivered
const NOTIFY_LIMIT_PER_RUN   = 50;  // safety: cap WhatsApp/email sends per run

function daysAgo(iso) {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  return (Date.now() - t) / (24 * 60 * 60 * 1000);
}

async function notifyDelivered(order) {
  const tasks = [];
  const firstName = (order.customer_name || 'there').split(' ')[0];
  const orderId   = order.razorpay_order_id || order.id;
  const reviewUrl = `https://inkandchai.in/review/?order=${encodeURIComponent(orderId)}`;
  const returnsUrl= `https://inkandchai.in/return-policy/`;

  if (order.customer_phone) {
    tasks.push(
      sendWhatsApp({
        to: order.customer_phone,
        template: 'order_delivered',
        params: [firstName, reviewUrl],
      }).catch(e => console.warn('[auto-deliver] WhatsApp failed:', e.message))
    );
  }

  if (order.customer_email) {
    tasks.push(
      sendEmail({
        to: order.customer_email,
        subject: `📚 Your Ink & Chai order has been delivered`,
        html: `
          <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#2a2018;background:#faf7f2;">
            <h2 style="font-family:Georgia,serif;font-weight:400;color:#8a6a1f;margin:0 0 12px;">Ink &amp; Chai</h2>
            <p>Hi ${firstName},</p>
            <p>We've marked your order <strong>${orderId}</strong> as delivered.</p>
            <p>We hope you love your books! If you have a moment, would you mind <a href="${reviewUrl}" style="color:#8a6a1f;">leaving a quick review</a>?</p>
            <hr style="border:none;border-top:1px solid #eadfca;margin:24px 0;"/>
            <p style="font-size:13px;color:#5a4a38;">
              <strong>Got the wrong book? Not happy with the condition?</strong><br/>
              You have <strong>7 days</strong> from today to initiate a return directly from your <a href="https://inkandchai.in/" style="color:#8a6a1f;">My Orders</a> page.
              Refunds are processed automatically once we receive the returned book.
            </p>
            <p style="font-size:12px;color:#8a7a62;margin-top:24px;">Ink &amp; Chai · <a href="${returnsUrl}" style="color:#8a6a1f;">Return Policy</a> · support@inkandchai.in</p>
          </div>`,
      }).catch(e => console.warn('[auto-deliver] Email failed:', e.message))
    );
  }
  await Promise.all(tasks);
}

async function runSweep(supabase, { dryRun = false } = {}) {
  const summary = {
    candidates: 0,
    marked_delivered: 0,
    skipped_already_delivered: 0,
    skipped_too_recent: 0,
    skipped_no_movement: 0,
    notify_skipped_quota: 0,
    errors: 0,
    examples: [],
  };

  // Pull both shipped + OFD orders
  const { data: orders, error } = await supabase
    .from('orders')
    .select('id,razorpay_order_id,status,shipped_at,awb_assigned_at,shipment_moved_at,delivered_at,created_at,customer_name,customer_email,customer_phone,tracking_id,courier_name,amount_paise,cart_items')
    .or('source.is.null,source.neq.paperbound')  // exclude paperbound store's orders (shared DB)
    .in('status', ['shipped', 'out_for_delivery'])
    .order('created_at', { ascending: true })
    .limit(2000);

  if (error) throw new Error('DB query failed: ' + error.message);
  if (!orders?.length) return summary;

  summary.candidates = orders.length;

  let notifiedCount = 0;

  for (const order of orders) {
    try {
      if (order.delivered_at) { summary.skipped_already_delivered++; continue; }

      // An AWB is not proof of dispatch. Newly tracked orders must show a real
      // pickup/in-transit scan before this delivery fallback can act; otherwise
      // the seven-day COD cancellation job owns them.
      if (order.awb_assigned_at && !order.shipment_moved_at) {
        summary.skipped_no_movement++;
        continue;
      }

      // Decide threshold based on current status
      const isOFD = order.status === 'out_for_delivery';
      const threshold = isOFD ? OFD_DAYS_THRESHOLD : SHIPPED_DAYS_THRESHOLD;

      // We use shipped_at as the time anchor (the only reliable timestamp we have
      // for the courier hand-off). Fall back to created_at if shipped_at missing.
      const anchorIso = order.shipped_at || order.created_at;
      const age = daysAgo(anchorIso);
      if (age === null || age < threshold) {
        summary.skipped_too_recent++;
        continue;
      }

      if (dryRun) {
        summary.marked_delivered++;
        if (summary.examples.length < 10) summary.examples.push({
          order_id: order.razorpay_order_id, status: order.status, age_days: Math.round(age),
        });
        continue;
      }

      const nowIso = new Date().toISOString();
      const { error: updErr } = await supabase
        .from('orders')
        .update({ status: 'delivered', delivered_at: nowIso })
        .eq('id', order.id);
      if (updErr) { summary.errors++; console.error('[auto-deliver] update error:', updErr.message); continue; }

      summary.marked_delivered++;
      if (summary.examples.length < 10) summary.examples.push({
        order_id: order.razorpay_order_id, status: order.status, age_days: Math.round(age),
      });

      // Send notification (rate-limited per run to avoid WhatsApp/email floods)
      if (notifiedCount < NOTIFY_LIMIT_PER_RUN) {
        await notifyDelivered(order);
        notifiedCount++;
      } else {
        summary.notify_skipped_quota++;
      }
    } catch (e) {
      summary.errors++;
      console.error('[auto-deliver] error processing order:', e.message);
    }
  }

  return summary;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  // Manual trigger (admin button) — POST + X-Admin-Key
  if (event.httpMethod === 'POST') {
  const _adminBlock = requireAdmin(event, CORS); if (_adminBlock) return _adminBlock;
    let body = {};
    try { body = JSON.parse(event.body || '{}'); } catch {}

    try {
      const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
        auth: { autoRefreshToken: false, persistSession: false },
      });
      const summary = await runSweep(supabase, { dryRun: !!body.dry_run });
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ success: true, summary }) };
    } catch (err) {
      console.error('[auto-deliver] manual error:', err.message);
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
    }
  }

  // Scheduled trigger (Netlify cron) — no auth header, but only fires from Netlify
  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const summary = await runSweep(supabase);
    console.log('[auto-deliver] scheduled sweep:', JSON.stringify(summary));
    return { statusCode: 200, body: JSON.stringify({ success: true, summary }) };
  } catch (err) {
    console.error('[auto-deliver] scheduled error:', err.message);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
