/**
 * Admin-only recovery for WhatsApp messages missed while the AI provider was
 * unavailable. A dry run is required by the UI before the operator confirms.
 * Only customer messages inside WhatsApp's 24-hour service window qualify.
 */
const { createClient } = require('@supabase/supabase-js');
const { requireAdmin } = require('./utils/admin-auth');
const { _internal: bot } = require('./whatsapp-bot');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Admin-Token, X-Admin-Key',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const retryLocks = new Set();

function combinePendingMessages(messages) {
  const texts = messages.map(row => String(row.message || '').trim()).filter(Boolean);
  if (texts.length <= 1) return texts[0] || '';
  return `The customer sent these messages while support was temporarily unavailable:\n${texts.map((text, i) => `${i + 1}. ${text}`).join('\n')}`;
}

function findMissedConversations(messages, conversations, limit = 10) {
  const allowed = new Map(
    conversations
      .filter(conv => conv.status === 'active' && conv.human_takeover !== true && conv.whatsapp_phone_id)
      .map(conv => [String(conv.customer_phone), conv])
  );
  const grouped = new Map();
  for (const message of messages) {
    const phone = String(message.customer_phone || '');
    if (!allowed.has(phone)) continue;
    if (!grouped.has(phone)) grouped.set(phone, []);
    grouped.get(phone).push(message);
  }

  const candidates = [];
  for (const [phone, rows] of grouped) {
    rows.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    if (!rows.length || rows[rows.length - 1].role !== 'user') continue;
    const pending = [];
    for (let i = rows.length - 1; i >= 0 && rows[i].role === 'user'; i -= 1) pending.unshift(rows[i]);
    const conv = allowed.get(phone);
    candidates.push({
      phone,
      whatsappPhoneId: String(conv.whatsapp_phone_id),
      messages: pending,
      lastCreatedAt: rows[rows.length - 1].created_at,
    });
  }
  return candidates
    .sort((a, b) => new Date(a.lastCreatedAt) - new Date(b.lastCreatedAt))
    .slice(0, limit);
}

async function latestPendingMessages(db, candidate) {
  const { data, error } = await db.from('bot_messages')
    .select('customer_phone,role,message,created_at')
    .eq('customer_phone', candidate.phone)
    .order('created_at', { ascending: false })
    .limit(20);
  if (error) throw error;
  const rows = data || [];
  if (!rows.length || rows[0].role !== 'user' || rows[0].created_at !== candidate.lastCreatedAt) return [];
  const pending = [];
  for (const row of rows) {
    if (row.role !== 'user') break;
    pending.unshift(row);
  }
  return pending;
}

async function recoverOne(db, candidate) {
  if (retryLocks.has(candidate.phone)) return { phone: candidate.phone, status: 'skipped', reason: 'already_processing' };
  retryLocks.add(candidate.phone);
  try {
    const pending = await latestPendingMessages(db, candidate);
    if (!pending.length) return { phone: candidate.phone, status: 'skipped', reason: 'already_answered_or_changed' };

    const { data: conv, error: convError } = await db.from('bot_conversations')
      .select('status,human_takeover,whatsapp_phone_id')
      .eq('customer_phone', candidate.phone)
      .maybeSingle();
    if (convError) throw convError;
    if (!conv || conv.status !== 'active' || conv.human_takeover === true) {
      return { phone: candidate.phone, status: 'skipped', reason: 'human_or_resolved' };
    }
    if (!conv.whatsapp_phone_id) return { phone: candidate.phone, status: 'skipped', reason: 'reply_number_unknown' };

    const combined = combinePendingMessages(pending);
    const orderContext = await bot.buildOrderContext(candidate.phone, combined);
    let reply = await bot.askOpenAI(candidate.phone, combined, orderContext);
    const escalated = reply.includes('[ESCALATE]');
    reply = reply.replace('[ESCALATE]', '').trim();
    if (!reply) throw new Error('AI returned an empty reply');

    // Recheck after generation too: a human or live webhook may have replied
    // while OpenAI was preparing this response.
    const stillPending = await latestPendingMessages(db, candidate);
    if (!stillPending.length) return { phone: candidate.phone, status: 'skipped', reason: 'answered_during_generation' };

    const sent = await bot.sendReply(candidate.phone, reply, String(conv.whatsapp_phone_id));
    if (!sent.ok) throw new Error(sent.error || 'Meta rejected the WhatsApp message');
    await bot.persistMessage(candidate.phone, 'bot', reply, null, String(conv.whatsapp_phone_id));
    await db.from('bot_conversations').update({
      unread_count: 0,
      human_takeover: escalated,
    }).eq('customer_phone', candidate.phone);
    return { phone: candidate.phone, status: 'sent' };
  } catch (error) {
    console.error(`Missed reply recovery failed for ${candidate.phone}:`, error.message);
    return { phone: candidate.phone, status: 'failed', reason: error.message };
  } finally {
    retryLocks.delete(candidate.phone);
  }
}

exports.handler = async event => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  const adminBlock = requireAdmin(event, CORS);
  if (adminBlock) return adminBlock;
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const dryRun = body.dry_run !== false;
    // Each GPT-4o reply consumes roughly 4k TPM with the store instructions.
    // Stay comfortably below the account's 30k TPM ceiling and let the admin
    // run another guarded batch for the remainder.
    const limit = Math.max(1, Math.min(Number(body.limit) || 5, 5));
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

    const { data: conversations, error: convError } = await db.from('bot_conversations')
      .select('customer_phone,whatsapp_phone_id,last_message_at,status,human_takeover')
      .eq('status', 'active')
      .gte('last_message_at', cutoff)
      .order('last_message_at', { ascending: true })
      .limit(250);
    if (convError) throw convError;

    const phones = (conversations || []).map(conv => conv.customer_phone).filter(Boolean);
    if (!phones.length) {
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, dry_run: dryRun, candidate_count: 0 }) };
    }

    const { data: messages, error: messageError } = await db.from('bot_messages')
      .select('customer_phone,role,message,created_at')
      .in('customer_phone', phones)
      .gte('created_at', cutoff)
      .order('created_at', { ascending: true })
      .limit(5000);
    if (messageError) throw messageError;

    const allCandidates = findMissedConversations(messages || [], conversations || [], 250);
    const candidates = allCandidates.slice(0, limit);
    if (dryRun) {
      return {
        statusCode: 200,
        headers: CORS,
        body: JSON.stringify({
          ok: true,
          dry_run: true,
          candidate_count: allCandidates.length,
          process_count: candidates.length,
          remaining_after_run: Math.max(0, allCandidates.length - candidates.length),
          limit,
          window_hours: 24,
        }),
      };
    }

    // Process sequentially. Parallel generation caused a burst against the
    // account's token-per-minute limit even though billing credit was healthy.
    const results = [];
    for (const candidate of candidates) {
      results.push(await recoverOne(db, candidate));
    }
    const sent = results.filter(result => result.status === 'sent').length;
    const skipped = results.filter(result => result.status === 'skipped').length;
    const failed = results.filter(result => result.status === 'failed').length;
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        ok: failed === 0,
        dry_run: false,
        candidate_count: allCandidates.length,
        processed: candidates.length,
        remaining_after_run: Math.max(0, allCandidates.length - sent - skipped),
        sent,
        skipped,
        failed,
        results,
      }),
    };
  } catch (error) {
    console.error('retry-missed-bot-replies error:', error.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: error.message }) };
  }
};

exports._test = { combinePendingMessages, findMissedConversations };
