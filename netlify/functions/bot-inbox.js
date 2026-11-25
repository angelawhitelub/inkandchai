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
 * POST {action:"reopen",   phone}       — reopen a closed conversation
 * POST {action:"send",     phone, text} — admin sends a WhatsApp message
 * POST {action:"mark_read",phone}       — clear unread count
 * POST {action:"summarise",phone}       — generate an internal summary on demand
 * POST {action:"agent_open",phone}      — the owner OPENED a queued chat: tell the
 *                                         customer "Agent Anil is now available…"
 *                                         once (utils/agent-queue)
 *
 * Agent queue (utils/agent-queue): list rows carry `agent_queue` ({ since,
 * reason, joined_at }) for chats waiting for a person; Close chat and Hand to
 * bot take a chat out of it.
 */

const { threadPage, customerDetails, enrichNames } = require('./utils/inbox-history');
const { categorizeConversations } = require('./utils/conversation-priority');
const { summariseConversation } = require('./utils/inbox-summary');
const { createClient } = require('@supabase/supabase-js');
const { normalizePhone } = require('./utils/whatsapp');
const { requireAdmin } = require('./utils/admin-auth');
const agentQueue = require('./utils/agent-queue');

const PHONE_ID = process.env.WHATSAPP_PHONE_ID || '1188708014316574';
const API_VER  = 'v20.0';

const CORS = {
  'Cache-Control': 'private, no-store',
  'Content-Type': 'application/json',
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
        // Queued chats are listed even when older than the newest 200.
        let queue = [];
        try { queue = await agentQueue.list(); } catch (e) { console.warn('[bot-inbox] agent queue unreadable:', e.message); }
        const rows = data || [];
        const have = new Set(rows.map((r) => r.customer_phone));
        const missing = queue.map((q) => q.chat).filter((k) => !have.has(k));
        if (missing.length) {
          const { data: more } = await db.from('bot_conversations').select('*').in('customer_phone', missing.slice(0, 200));
          rows.push(...(more || []));
        }
        const conversations = await categorizeConversations(db, await enrichNames(db, rows));
        const byChat = new Map(queue.map((q) => [q.chat, q]));
        for (const c of conversations) {
          const q = byChat.get(agentQueue.keyOf(c.customer_phone));
          if (q) c.agent_queue = { since: q.since, reason: q.reason, last_text: q.last_text, joined_at: q.joined_at, joined_by: q.joined_by };
        }
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ conversations, agent_name: agentQueue.AGENT_NAME() }) };
      }

      if ((q.action === 'thread' || q.action === 'customer') && q.phone) {
        if (!/^\+?[\d ()-]{7,24}$/.test(q.phone) || !/^\d{7,15}$/.test(q.phone.replace(/\D/g,''))) return {statusCode:400,headers:CORS,body:JSON.stringify({error:'Invalid phone'})};
        const result = q.action === 'customer' ? await customerDetails(db,q.phone) : await threadPage(db,q.phone,q);
        return {statusCode:200,headers:CORS,body:JSON.stringify(result)};
      }

      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Unknown action' }) };
    }

    // ── POST endpoints ──────────────────────────────────────────────────────
    if (event.httpMethod === 'POST') {
      const body = JSON.parse(event.body || '{}');
      const { action, phone, text } = body;

      if (!phone) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'phone required' }) };

      // Explicit employee action only. Never called from listing, polling or webhooks.
      if (action === 'summarise') {
        try {
          const result = await summariseConversation(db,phone);
          return {statusCode:200,headers:CORS,body:JSON.stringify(result)};
        } catch (error) {
          return {statusCode:error.statusCode||500,headers:CORS,body:JSON.stringify({error:error.message})};
        }
      }

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
        await agentQueue.remove(phone);
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
      }

      if (action === 'reopen') {
        const {error}=await db.from('bot_conversations').update({status:'active'}).eq('customer_phone',phone);
        if(error)throw error;
        return {statusCode:200,headers:CORS,body:JSON.stringify({ok:true})};
      }
      if (action === 'resolve') {
        const {error}=await db.from('bot_conversations')
          .update({ status: 'resolved', human_takeover: false, unread_count: 0 })
          .eq('customer_phone', phone);
        if(error)throw error;
        await agentQueue.remove(phone);
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
      }

      // The owner opened a queued chat (a click in Bot Inbox, never a poll):
      // the customer hears once that an agent has joined. Only inside the
      // 24-hour window -- outside it WhatsApp drops the message without a word.
      if (action === 'agent_open') {
        const entry = await agentQueue.get(phone);
        if (!entry) return { statusCode: 200, headers: CORS, body: JSON.stringify({ queued: false }) };
        if (entry.joined_at) return { statusCode: 200, headers: CORS, body: JSON.stringify({ queued: true, joined: true, already: true }) };
        const { data: lastUser } = await db.from('bot_messages').select('created_at')
          .eq('customer_phone', phone).in('role', ['user', 'customer'])
          .order('created_at', { ascending: false }).limit(1).maybeSingle();
        if (!agentQueue.inWindow(lastUser?.created_at)) {
          return { statusCode: 200, headers: CORS, body: JSON.stringify({ queued: true, joined: false, window_closed: true, last_user_at: lastUser?.created_at || null }) };
        }
        // Claim first so two open tabs send it once; undone if the send fails.
        await agentQueue.markJoined(phone);
        const joinText = agentQueue.joinText();
        const sent = await exports.handler({ ...event, body: JSON.stringify({ action: 'send', phone, text: joinText }) });
        if (sent.statusCode !== 200) {
          await agentQueue.put(entry).catch(() => {});   // back to waiting
          let why = {}; try { why = JSON.parse(sent.body); } catch { /* keep empty */ }
          return { statusCode: 200, headers: CORS, body: JSON.stringify({ queued: true, joined: false, error: why.detail || why.error || 'send failed' }) };
        }
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ queued: true, joined: true, sent: true, text: joinText }) };
      }

      if (action === 'mark_read') {
        await db.from('bot_conversations')
          .update({ unread_count: 0 })
          .eq('customer_phone', phone);
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
      }

      if (action === 'send') {
        if (!text) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'text required' }) };

        // Instagram DM (instagram-webhook): reply through Instagram. Within 24 h
        // of their last message a plain reply; up to 7 days with the HUMAN_AGENT tag.
        if (/^ig:\d+$/.test(String(phone))) {
          const IG = require('./utils/instagram');
          let result = await IG.sendInstagramText(phone, text);
          if (!result.ok) {
            const tagged = await IG.sendInstagramText(phone, text, { humanAgent: true });
            if (tagged.ok) result = tagged;
          }
          if (!result.ok) {
            return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: 'Instagram send failed', detail: `${result.error}. Instagram only allows replies within 24 hours of the customer's last message (7 days once Meta approves Human Agent).` }) };
          }
          const at = new Date().toISOString();
          await db.from('bot_messages').insert({ customer_phone: phone, role: 'admin', message: text, created_at: at });
          await db.from('bot_conversations').upsert({ customer_phone: phone, last_message: `[You]: ${text.slice(0, 80)}`, last_message_at: at, human_takeover: true, status: 'active' }, { onConflict: 'customer_phone' });
          return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, channel: 'instagram' }) };
        }

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
