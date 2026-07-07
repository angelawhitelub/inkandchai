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

exports.handler = async () => {
  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const nowIso = new Date().toISOString();

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
    return { statusCode: 200, body: 'no-op' };
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
  return { statusCode: 200, body: JSON.stringify({ sent, failed }) };
};
