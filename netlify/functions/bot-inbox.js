/**
 * Netlify Function: bot-inbox
 *
 * Admin API for the WhatsApp bot conversation inbox.
 * All endpoints require the admin key in the Authorization header.
 *
 * GET  ?action=list                     — list all conversations (most-recent-first)
 * GET  ?action=thread&phone=91XXXXXXXXXX — load all messages for one conversation
 * POST {action:"takeover", phone}       — admin takes over; bot stops replying
 * POST {action:"release",  phone}       — release back to bot
 * POST {action:"resolve",  phone}       — mark conversation resolved
 * POST {action:"send",     phone, text} — admin sends a WhatsApp message
 * POST {action:"mark_read",phone}       — clear unread count
 */

const { createClient } = require('@supabase/supabase-js');
const { normalizePhone } = require('./utils/whatsapp');

const PHONE_ID = process.env.WHATSAPP_PHONE_ID || '1188708014316574';
const API_VER  = 'v20.0';
const WA_URL   = `https://graph.facebook.com/${API_VER}/${PHONE_ID}/messages`;

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

function supabaseAdmin() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
}

// ── Verify admin password ─────────────────────────────────────────────────────
function verifyAdmin(event) {
  const auth = event.headers['authorization'] || event.headers['Authorization'] || '';
  const key  = auth.replace(/^Bearer\s+/i, '').trim();
  return key === process.env.ADMIN_PASSWORD;
}

// ── Send a WhatsApp text message ──────────────────────────────────────────────
async function sendWhatsAppText(to, text) {
  const token = process.env.WHATSAPP_TOKEN;
  if (!token) return { ok: false, error: 'WHATSAPP_TOKEN not set' };
  const phone = normalizePhone(to) || to;
  const res = await fetch(WA_URL, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: phone,
      type: 'text',
      text: { body: text, preview_url: false },
    }),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, data };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  if (!verifyAdmin(event)) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  const db = supabaseAdmin();

  try {

    // ── GET endpoints ───────────────────────────────────────────────────────
    if (event.httpMethod === 'GET') {
      const q = event.queryStringParameters || {};

      if (q.action === 'list') {
        // Return all conversations sorted by last message, with unread counts
        const { data, error } = await db
          .from('bot_conversations')
          .select('*')
          .order('last_message_at', { ascending: false })
          .limit(200);
        if (error) throw error;
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ conversations: data || [] }) };
      }

      if (q.action === 'thread' && q.phone) {
        const { data, error } = await db
          .from('bot_messages')
          .select('*')
          .eq('customer_phone', q.phone)
          .order('created_at', { ascending: true })
          .limit(200);
        if (error) throw error;
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ messages: data || [] }) };
      }

      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Unknown action' }) };
    }

    // ── POST endpoints ──────────────────────────────────────────────────────
    if (event.httpMethod === 'POST') {
      const body = JSON.parse(event.body || '{}');
      const { action, phone, text } = body;

      if (!phone) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'phone required' }) };

      if (action === 'takeover') {
        await db.from('bot_conversations').upsert({
          customer_phone: phone,
          human_takeover: true,
          status: 'active',
          last_message_at: new Date().toISOString(),
        }, { onConflict: 'customer_phone' });
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
      }

      if (action === 'release') {
        await db.from('bot_conversations')
          .update({ human_takeover: false })
          .eq('customer_phone', phone);
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
      }

      if (action === 'resolve') {
        await db.from('bot_conversations')
          .update({ status: 'resolved', human_takeover: false, unread_count: 0 })
          .eq('customer_phone', phone);
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
      }

      if (action === 'mark_read') {
        await db.from('bot_conversations')
          .update({ unread_count: 0 })
          .eq('customer_phone', phone);
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
      }

      if (action === 'send') {
        if (!text) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'text required' }) };

        // Send the message via WhatsApp
        const result = await sendWhatsAppText(phone, text);
        if (!result.ok) {
          return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: 'WhatsApp send failed', detail: result.data }) };
        }

        // Save to bot_messages
        const now = new Date().toISOString();
        await db.from('bot_messages').insert({
          customer_phone: phone,
          role: 'admin',
          message: text,
          created_at: now,
        });

        // Update conversation last message
        await db.from('bot_conversations').upsert({
          customer_phone: phone,
          last_message: `[You]: ${text.slice(0, 80)}`,
          last_message_at: now,
          human_takeover: true,   // taking over implies human mode
          status: 'active',
        }, { onConflict: 'customer_phone' });

        return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
      }

      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Unknown action' }) };
    }

    return { statusCode: 405, headers: CORS, body: 'Method Not Allowed' };

  } catch (err) {
    console.error('bot-inbox error:', err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
