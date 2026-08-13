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
const { requireAdmin } = require('./utils/admin-auth');

const PHONE_ID = process.env.WHATSAPP_PHONE_ID || '1188708014316574';
const API_VER  = 'v20.0';

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Admin-Token, X-Admin-Key',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

function supabaseAdmin() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
}

// ── Verify admin password ─────────────────────────────────────────────────────
// ── Send a WhatsApp text message ──────────────────────────────────────────────
async function sendWhatsAppText(to, text, senderPhoneId) {
  const token = process.env.WHATSAPP_TOKEN;
  if (!token) return { ok: false, error: 'WHATSAPP_TOKEN not set' };
  const phone = normalizePhone(to) || to;
  const phoneId = senderPhoneId || PHONE_ID;
  const url = `https://graph.facebook.com/${API_VER}/${phoneId}/messages`;
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
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, data, phoneId };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  // Use the shared gate so this endpoint accepts the same auth as every other
  // admin function: X-Admin-Token (HMAC, what adminFetch sends) OR the legacy
  // X-Admin-Key / Bearer key. The old local check only accepted a raw Bearer
  // password, so passkey/token-restored sessions (adminKey empty) 401'd here.
  const _adminBlock = requireAdmin(event, CORS); if (_adminBlock) return _adminBlock;

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
          // Fetch the newest rows before applying the cap. Ordering ascending
          // here returned the *oldest* 200 messages, so recent human replies
          // were saved and shown in the sidebar preview but disappeared from
          // long threads. Reverse below to keep the UI chronological.
          .order('created_at', { ascending: false })
          .limit(200);
        if (error) throw error;
        return {
          statusCode: 200,
          headers: CORS,
          body: JSON.stringify({ messages: (data || []).reverse() }),
        };
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

        // A single webhook serves multiple Ink & Chai WhatsApp numbers. Send
        // from the same business number that received this conversation.
        const { data: conversation, error: conversationError } = await db
          .from('bot_conversations')
          .select('whatsapp_phone_id')
          .eq('customer_phone', phone)
          .maybeSingle();
        if (conversationError) throw conversationError;
        if (!conversation?.whatsapp_phone_id) {
          return {
            statusCode: 409,
            headers: CORS,
            body: JSON.stringify({
              error: 'Reply number unknown',
              detail: 'Ask the customer to send one new message, then retry. The inbox will remember which WhatsApp number they contacted.',
            }),
          };
        }

        // Send the message via WhatsApp
        const result = await sendWhatsAppText(phone, text, conversation.whatsapp_phone_id);
        if (!result.ok) {
          const detail = result.data?.error?.message || result.error || 'Meta rejected the message';
          console.error(`Manual WhatsApp send failed via ${result.phoneId} -> ${phone}:`, JSON.stringify(result.data || result.error));
          return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: 'WhatsApp send failed', detail }) };
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

        return {
          statusCode: 200,
          headers: CORS,
          body: JSON.stringify({ ok: true, message_id: result.data?.messages?.[0]?.id || '' }),
        };
      }

      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Unknown action' }) };
    }

    return { statusCode: 405, headers: CORS, body: 'Method Not Allowed' };

  } catch (err) {
    console.error('bot-inbox error:', err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
