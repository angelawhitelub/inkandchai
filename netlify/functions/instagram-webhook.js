/**
 * Netlify Function: instagram-webhook   (public; Meta calls it)
 *
 * Instagram DMs to @inkandchai.in, answered by the same AI as WhatsApp
 * (whatsapp-bot askOpenAI in Instagram mode: book lookup only, no order tools).
 *
 *   GET  ?hub.mode=subscribe&hub.verify_token=…&hub.challenge=…  Meta's check
 *   POST message events, signed X-Hub-Signature-256 with INSTAGRAM_APP_SECRET
 *
 * Every incoming DM is saved to the admin Bot Inbox (key "ig:<id>"). The bot
 * replies only while the owner's switch is ON (KV catalog:instagram-bot, admin
 * Bot settings), never in a chat a person has taken over, and hands anything it
 * cannot do to the team with [ESCALATE].
 *
 * Admin: POST { action: 'status' | 'switch', on } with the admin token.
 */
const IG = require('./utils/instagram');
const { requireAdmin } = require('./utils/admin-auth');
const agentQueue = require('./utils/agent-queue');

const text = (statusCode, body) => ({ statusCode, headers: { 'Content-Type': 'text/plain' }, body: String(body) });
const json = (statusCode, body) => ({ statusCode, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(body) });

const seen = new Map();          // message ids handled by this instance (Meta may redeliver)
function firstTime(mid) {
  if (!mid) return true;
  const now = Date.now();
  for (const [k, t] of seen) if (now - t > 3600e3) seen.delete(k);
  if (seen.has(mid)) return false;
  seen.set(mid, now);
  return true;
}

/** The DMs in a webhook body: [{ sender, mid, text, attachments }], echoes and reads left out. */
function incoming(body, ownId = IG.accountId()) {
  const out = [];
  for (const entry of body?.entry || []) {
    for (const ev of entry.messaging || []) {
      const m = ev.message;
      if (!m || m.is_echo || m.is_deleted || m.is_unsupported) continue;
      const sender = String(ev.sender?.id || '');
      if (!sender || sender === String(ownId) || sender === String(entry.id)) continue;
      const atts = (m.attachments || []).map((a) => a.type || 'file');
      const t = String(m.text || m.quick_reply?.payload || '').trim();
      if (!t && !atts.length) continue;
      out.push({ sender, mid: m.mid || '', text: t, attachments: atts, replyTo: m.reply_to?.story ? 'story' : '' });
    }
  }
  return out;
}

async function alertOwner(message) {
  const phone = process.env.STORE_OWNER_PHONE;
  if (!phone) return;
  try { await require('./utils/whatsapp').sendText(phone, message); } catch { /* best effort */ }
}

async function handleDm(dm, deps = {}) {
  const bot = deps.bot || require('./whatsapp-bot')._internal;
  const key = IG.igKey(dm.sender);
  const name = await (deps.username || IG.instagramUsername)(dm.sender);
  const said = dm.text || `[sent ${dm.attachments.join(', ')}]`;
  const userText = (dm.replyTo === 'story' ? '[replied to our story] ' : '') + said;
  await bot.persistMessage(key, 'user', userText, name, null);

  if (!(await (deps.botOn || IG.botOn)())) return { replied: false, why: 'switch off' };
  if (await bot.isHumanTakeover(key)) return { replied: false, why: 'human takeover' };
  if (!dm.text) {
    const reply = 'Thanks for sending this! 💛 Our team will take a look and reply here. If it is about an order, please also type your order ID (the last 5 letters are enough).';
    const sent = await (deps.send || IG.sendInstagramText)(key, reply);
    if (sent.ok) await bot.persistMessage(key, 'bot', reply, name, null);
    return { replied: sent.ok };
  }

  const orderContext = await bot.buildOrderContext(key, dm.text).catch(() => '');
  const extra = [IG.CHANNEL_NOTE, orderContext].filter(Boolean).join('\n\n');
  let reply = await bot.askOpenAI(key, dm.text, extra, null, { channel: 'instagram' });
  if (reply.includes('[ESCALATE]')) {
    reply = reply.replace(/\[ESCALATE\]/g, '').trim();
    if (!/next available agent/i.test(reply)) reply = `${reply}\n\n${agentQueue.WAIT_TEXT}`.trim();
    await (deps.queue || agentQueue.add)(key, { reason: 'Bot handed over (Instagram)', text: dm.text });
    await (deps.alertOwner || alertOwner)(`⚠️ Instagram DM needs a person\nFrom: ${name || key}\nMessage: "${dm.text.slice(0, 200)}"\n\nAdmin → Bot Inbox to reply (chat key ${key}).`);
    await (deps.takeover || takeover)(key);
  }
  const sent = await (deps.send || IG.sendInstagramText)(key, reply);
  if (!sent.ok) throw new Error(`Instagram send failed: ${sent.error}`);
  await bot.persistMessage(key, 'bot', reply, name, null);
  return { replied: true };
}

async function takeover(key) {
  try {
    const { createClient } = require('@supabase/supabase-js');
    const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    await db.from('bot_conversations').upsert({ customer_phone: key, human_takeover: true, status: 'active', last_message_at: new Date().toISOString() }, { onConflict: 'customer_phone' });
  } catch (e) { console.error('[instagram] takeover failed', e.message); }
}

async function handle(event = {}, deps = {}) {
  const method = event.httpMethod || 'GET';
  const q = event.queryStringParameters || {};

  if (method === 'GET') {
    const want = process.env.INSTAGRAM_VERIFY_TOKEN;
    if (q['hub.mode'] === 'subscribe' && want && q['hub.verify_token'] === want) return text(200, q['hub.challenge'] || '');
    return text(403, 'Forbidden');
  }
  if (method !== 'POST') return text(405, 'Method Not Allowed');

  const raw = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : (event.body || '');
  const headers = event.headers || {};

  // The admin's switch rides on this function too (admin token, no Meta signature).
  if (headers['x-admin-token'] || headers['x-admin-key']) {
    const blocked = requireAdmin(event, { 'Content-Type': 'application/json' });
    if (blocked) return blocked;
    let body = {};
    try { body = JSON.parse(raw || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }
    if (body.action === 'switch') return json(200, await IG.setBotOn(body.on === true));
    return json(200, {
      on: await IG.botOn(), account_id: IG.accountId(),
      token_set: !!process.env.INSTAGRAM_TOKEN, verify_set: !!process.env.INSTAGRAM_VERIFY_TOKEN,
      secret_set: !!(process.env.INSTAGRAM_APP_SECRET || process.env.META_APP_SECRET),
    });
  }

  if (!IG.signatureOk(raw, headers['x-hub-signature-256'], deps.secrets)) {
    console.warn('[instagram] webhook POST with a bad or missing signature');
    return text(401, 'bad signature');
  }
  let body;
  try { body = JSON.parse(raw); } catch { return text(400, 'bad json'); }
  if (body.object && body.object !== 'instagram') return text(200, 'ignored');

  for (const dm of incoming(body)) {
    if (!firstTime(dm.mid)) continue;
    try {
      const r = await handleDm(dm, deps);
      console.log('[instagram]', IG.igKey(dm.sender), r.replied ? 'replied' : `not replied (${r.why || 'send failed'})`);
    } catch (e) {
      console.error('[instagram] DM failed', e.message);
      if (e.code === 'openai_quota') await agentQueue.add(IG.igKey(dm.sender), { reason: 'Bot out of OpenAI credits', text: dm.text }).catch(() => {});   // always 200, so Meta does not resend the whole batch
    }
  }
  return text(200, 'EVENT_RECEIVED');
}

exports.handler = (event) => handle(event);
exports._test = { handle, incoming, handleDm };
