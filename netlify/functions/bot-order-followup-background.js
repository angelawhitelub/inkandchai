/**
 * Scheduled: send a 5-minute "still confirming?" ping to WhatsApp book-order
 * requests placed via the bot.
 *
 * Runs every 2 minutes via netlify.toml. Finds rows in bot_order_requests
 * where follow_up_at <= now(), follow_up_sent_at IS NULL, and the row is
 * still in an actionable state (status=new, no cancel/confirm yet).
 *
 * Design notes:
 *  - Idempotent by follow_up_sent_at: once a row gets its ping, follow_up_sent_at
 *    is set so a second scheduler tick won't re-ping.
 *  - Small batch cap so a backlog never fans out too many messages in one run.
 *  - Uses the store's default WhatsApp number (PHONE_ID) to send from — we don't
 *    track which of the 2 numbers the original conversation used, and the
 *    customer will read replies from either number the same way.
 */

const { createClient } = require('@supabase/supabase-js');
const { normalizePhone } = require('./utils/whatsapp');

const PHONE_ID = process.env.WHATSAPP_PHONE_ID || '1188708014316574';
const API_VER  = 'v20.0';
const BATCH    = 25;

// ── Razorpay payment-link status polling ────────────────────────────────────
// GET /v1/payment_links/:id returns { status: 'created'|'partially_paid'|'paid'|'cancelled'|'expired', ... }
async function fetchRazorpayLinkStatus(plinkId) {
  const keyId     = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret) throw new Error('Razorpay credentials not configured');
  const auth = Buffer.from(`${keyId}:${keySecret}`).toString('base64');
  const res = await fetch(`https://api.razorpay.com/v1/payment_links/${plinkId}`, {
    headers: { 'Authorization': `Basic ${auth}` },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.description || `Razorpay ${res.status}`);
  return data;
}

async function sendReply(to, text) {
  const token = process.env.WHATSAPP_TOKEN;
  if (!token) throw new Error('WHATSAPP_TOKEN not set');
  const phone = normalizePhone(to) || to;
  const url = `https://graph.facebook.com/${API_VER}/${PHONE_ID}/messages`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: phone,
      type: 'text',
      text: { body: text, preview_url: false },
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`WhatsApp send ${res.status}: ${body.slice(0, 200)}`);
  }
}

function buildMessage(row) {
  const orderId = row.order_id || '—';
  const books = (row.books || '').split(',').map(s => s.trim()).filter(Boolean);
  const title = books.length === 1 ? books[0] : `${books[0]}${books.length > 1 ? ` (+${books.length - 1} more)` : ''}`;
  const linkLine = row.payment_mode === 'prepaid' && row.payment_link
    ? `\n\n💳 Pay online here (dispatched as soon as we receive payment):\n${row.payment_link}`
    : (row.payment_mode === 'cod' ? '\n\n💵 Payment mode: Cash on Delivery' : '');
  return (
    `Hi ${row.customer_name || 'there'}! 👋\n\n` +
    `Just checking on your Ink & Chai order:\n` +
    `🆔 ${orderId}\n` +
    `📚 ${title || 'your books'}\n\n` +
    `Reply *YES* to confirm, or *NO* if you'd like to cancel.${linkLine}`
  );
}

// ── Poll unpaid prepaid orders, mark paid and notify ─────────────────────────
async function pollPaymentStatuses(db) {
  // Look back at the last 24 hours — enough to catch any pending pay-later.
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data: rows, error } = await db.from('bot_order_requests')
    .select('id, order_id, customer_phone, customer_name, amount_paise, razorpay_payment_link_id, payment_status')
    .eq('payment_mode', 'prepaid')
    .not('razorpay_payment_link_id', 'is', null)
    .in('payment_status', ['created', 'partially_paid'])
    .gt('created_at', since)
    .limit(BATCH);
  if (error) { console.error('[payment-poll] query:', error.message); return { paid: 0, checked: 0 }; }
  if (!rows?.length) return { paid: 0, checked: 0 };

  let paid = 0;
  for (const row of rows) {
    try {
      const link = await fetchRazorpayLinkStatus(row.razorpay_payment_link_id);
      const status = link.status;
      if (status === 'paid') {
        await db.from('bot_order_requests').update({
          payment_status: 'paid',
          paid_at:        new Date().toISOString(),
        }).eq('id', row.id);
        paid++;
        // Congratulate the customer (best-effort, don't fail the batch)
        try {
          await sendReply(row.customer_phone,
            `✅ Payment received for order ${row.order_id}! Thank you 💚 We're dispatching your books shortly — you'll get a tracking link on WhatsApp once the courier picks it up. 📚`);
        } catch (e) { console.error('[payment-poll] notify customer:', e.message); }
        // Ping the owner
        const ownerPhone = process.env.STORE_OWNER_PHONE;
        if (ownerPhone) {
          try {
            await sendReply(ownerPhone,
              `💰 Payment received (WhatsApp bot order)\n🆔 ${row.order_id}\n👤 ${row.customer_name}\n📞 ${row.customer_phone}\n💳 ₹${Math.round((row.amount_paise || 0) / 100)}`);
          } catch (e) { console.error('[payment-poll] notify owner:', e.message); }
        }
      } else if (status === 'expired' || status === 'cancelled') {
        await db.from('bot_order_requests').update({ payment_status: status }).eq('id', row.id);
      }
    } catch (e) {
      console.error(`[payment-poll] ${row.order_id}:`, e.message);
    }
  }
  return { paid, checked: rows.length };
}

exports.handler = async () => {
  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const nowIso = new Date().toISOString();

  // Payment polling runs on every tick — separate from the confirmation ping
  // so a payment gets marked as soon as we notice it.
  let paymentResult = { paid: 0, checked: 0 };
  try { paymentResult = await pollPaymentStatuses(db); }
  catch (e) { console.error('[payment-poll] batch:', e.message); }
  if (paymentResult.checked) {
    console.log(`[payment-poll] checked=${paymentResult.checked} paid=${paymentResult.paid}`);
  }

  const { data: rows, error } = await db
    .from('bot_order_requests')
    .select('id, order_id, customer_phone, customer_name, books, payment_mode, payment_link, follow_up_at')
    .lte('follow_up_at', nowIso)
    .is('follow_up_sent_at', null)
    .is('customer_confirmed_at', null)
    .is('customer_cancelled_at', null)
    .eq('status', 'new')
    .order('follow_up_at', { ascending: true })
    .limit(BATCH);

  if (error) {
    console.error('bot-order-followup query error:', error.message);
    return { statusCode: 500, body: error.message };
  }
  if (!rows?.length) {
    console.log('[followup] no due rows');
    return { statusCode: 200, body: JSON.stringify({ followup: 'no-op', ...paymentResult }) };
  }

  console.log(`[followup] sending ${rows.length} confirmation pings`);
  let sent = 0, failed = 0;
  for (const row of rows) {
    if (!row.customer_phone) { failed++; continue; }
    try {
      await sendReply(row.customer_phone, buildMessage(row));
      await db.from('bot_order_requests')
        .update({ follow_up_sent_at: new Date().toISOString(), status: 'contacted' })
        .eq('id', row.id);
      sent++;
    } catch (e) {
      console.error(`[followup] ${row.order_id} send failed:`, e.message);
      // Mark it sent anyway to prevent retry-loop hammering — we can't tell if
      // it was a permanent (opted-out) or transient failure from just the API
      // error, and Netlify scheduled functions have no per-row backoff. Better
      // to miss a ping than to flood the same number every 2 minutes forever.
      await db.from('bot_order_requests')
        .update({ follow_up_sent_at: new Date().toISOString() })
        .eq('id', row.id);
      failed++;
    }
  }
  return { statusCode: 200, body: JSON.stringify({ sent, failed, ...paymentResult }) };
};
