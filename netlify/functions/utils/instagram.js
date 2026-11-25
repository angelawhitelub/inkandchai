/**
 * Instagram DMs for @inkandchai.in (Meta Instagram API, Unified login).
 *
 * Secrets (Worker settings; set by the owner, never in code):
 *   INSTAGRAM_TOKEN         access token from the app's "Generate token" (step 2)
 *   INSTAGRAM_VERIFY_TOKEN  the word typed into "Verify token" (step 3)
 *   INSTAGRAM_APP_SECRET    the Meta app's App secret (App settings → Basic);
 *                           Meta signs every webhook POST with it
 *   INSTAGRAM_ACCOUNT_ID    optional; defaults to @inkandchai.in's id
 *
 * Conversations live in bot_conversations / bot_messages under the key
 * "ig:<Instagram-scoped user id>", beside WhatsApp's phone numbers. Instagram
 * lets a business reply only within 24 hours of the customer's last message
 * (7 days for a person, with the HUMAN_AGENT tag); it cannot start a chat.
 */
const crypto = require('crypto');

const DEFAULT_ACCOUNT_ID = '17841456475751080';   // @inkandchai.in
const GRAPH_VERSION = 'v21.0';
const MAX_TEXT = 1000;                            // Instagram's limit per message
const SWITCH_KEY = 'instagram-bot';

const accountId = () => String(process.env.INSTAGRAM_ACCOUNT_ID || DEFAULT_ACCOUNT_ID);
const isIgKey = (key) => /^ig:\d+$/.test(String(key || ''));
const igKey = (senderId) => `ig:${String(senderId).replace(/\D/g, '')}`;
const senderOf = (key) => String(key || '').replace(/^ig:/, '');

/** Instagram-login tokens (IGAA…) live on graph.instagram.com, Facebook ones (EAA…) on graph.facebook.com. */
function graphHost(token = process.env.INSTAGRAM_TOKEN) {
  return /^IG/.test(String(token || '')) ? 'https://graph.instagram.com' : 'https://graph.facebook.com';
}

/** True when the POST really came from Meta: X-Hub-Signature-256 = sha256 HMAC of the raw body. */
function signatureOk(rawBody, header, secrets = [process.env.INSTAGRAM_APP_SECRET, process.env.META_APP_SECRET]) {
  const got = String(header || '').replace(/^sha256=/, '');
  if (!/^[0-9a-f]{64}$/i.test(got)) return false;
  for (const secret of secrets.filter(Boolean)) {
    const want = crypto.createHmac('sha256', secret).update(rawBody || '', 'utf8').digest('hex');
    if (crypto.timingSafeEqual(Buffer.from(want, 'hex'), Buffer.from(got.toLowerCase(), 'hex'))) return true;
  }
  return false;
}

/** Split a reply into Instagram-sized pieces, at paragraph / line / word breaks. */
function chunks(text, max = MAX_TEXT) {
  const out = [];
  let rest = String(text || '').trim();
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n\n', max);
    if (cut < max * 0.5) cut = rest.lastIndexOf('\n', max);
    if (cut < max * 0.5) cut = rest.lastIndexOf(' ', max);
    if (cut < max * 0.5) cut = max;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

async function graphPost(path, body, deps = {}) {
  const token = process.env.INSTAGRAM_TOKEN;
  if (!token) return { ok: false, error: 'INSTAGRAM_TOKEN not set' };
  const res = await (deps.fetch || fetch)(`${graphHost(token)}/${GRAPH_VERSION}/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return res.ok && !data.error ? { ok: true, data } : { ok: false, status: res.status, error: data.error?.message || `HTTP ${res.status}`, code: data.error?.code, subcode: data.error?.error_subcode };
}

/**
 * Send text to one Instagram user. `humanAgent` adds the HUMAN_AGENT tag so a
 * person can still answer between 24 hours and 7 days after the customer's
 * last message (needs Meta's Human Agent approval).
 */
async function sendInstagramText(recipient, text, { humanAgent = false } = {}, deps = {}) {
  const id = senderOf(recipient);
  let last = { ok: false, error: 'empty message' };
  for (const piece of chunks(text)) {
    const body = { recipient: { id }, message: { text: piece } };
    if (humanAgent) Object.assign(body, { messaging_type: 'MESSAGE_TAG', tag: 'HUMAN_AGENT' });
    last = await graphPost(`${accountId()}/messages`, body, deps);
    // Some token types only accept the /me/messages form.
    if (!last.ok && (last.code === 100 || last.code === 3)) last = await graphPost('me/messages', body, deps);
    if (!last.ok) return last;
  }
  return last;
}

/** @username for the inbox; null when the token may not read it. */
async function instagramUsername(senderId, deps = {}) {
  const token = process.env.INSTAGRAM_TOKEN;
  if (!token) return null;
  try {
    const res = await (deps.fetch || fetch)(`${graphHost(token)}/${GRAPH_VERSION}/${senderOf(senderId)}?fields=username,name`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json().catch(() => ({}));
    return data.username ? `@${data.username}` : (data.name || null);
  } catch { return null; }
}

function store() {
  const { getStore } = require('@netlify/blobs');
  return getStore('catalog');
}
async function botOn() {
  try { const d = await store().get(SWITCH_KEY, { type: 'json' }); return !!(d && d.on); } catch { return false; }
}
async function setBotOn(on) {
  const doc = { on: !!on, updated_at: new Date().toISOString() };
  await store().setJSON(SWITCH_KEY, doc);
  return doc;
}

/** Told to the model on every Instagram reply: what it can and cannot do here. */
const CHANNEL_NOTE = [
  'CHANNEL: This conversation is an Instagram DM to @inkandchai.in, not WhatsApp.',
  '- You cannot place, change, cancel or refund orders here, and you have no phone number for this person.',
  '- To buy a book, look it up with find_book and send the inkandchai.in link with the price; ordering happens on the website.',
  '- For an existing order, ask for the order ID (the last 5 letters, e.g. AB3CD, are enough) and answer from the order details you are given.',
  '- Keep replies short and friendly for Instagram: a few lines, no long lists, plain text (no markdown).',
  '- Anything you cannot do here (returns, refunds, address changes, complaints, or they want a person): say "The next available agent will take up your issue and talk to you here. 🙏" and end with [ESCALATE]. Never give any phone number or wa.me link.',
].join('\n');

module.exports = {
  DEFAULT_ACCOUNT_ID, MAX_TEXT, CHANNEL_NOTE,
  accountId, isIgKey, igKey, senderOf, graphHost, signatureOk, chunks,
  sendInstagramText, instagramUsername, botOn, setBotOn,
};
