/**
 * The Bot Inbox agent queue (owner, 25 Nov 2026): every chat the bot hands to a
 * person waits here, oldest first, until the owner closes it or hands it back
 * to the bot.
 *
 *   1. The bot escalates ([ESCALATE], a request for a human, anything it
 *      cannot do, or OpenAI out of credits): the customer is told
 *      WAIT_TEXT and the chat is queued (add).
 *   2. The owner OPENS the chat in Bot Inbox (a click, never a poll): if no
 *      agent has joined yet, the customer gets JOIN_TEXT ("Agent Anil is now
 *      available…") and the entry is marked joined (bot-inbox action
 *      agent_open). Only inside WhatsApp's 24-hour window, or WhatsApp would
 *      drop it silently.
 *   3. Close chat / Hand to bot removes it (remove).
 *
 * One KV key per chat in the "agent-queue" store, so two escalations at once
 * never overwrite each other. Chat keys are WhatsApp numbers or "ig:<id>".
 */
'use strict';

const AGENT_NAME = () => String(process.env.INBOX_AGENT_NAME || 'Anil').trim() || 'Anil';
const WAIT_TEXT = 'The next available agent will take up your issue and talk to you here. 🙏';
const joinText = () => `Agent ${AGENT_NAME()} is now available to talk to you. Please reply to share your concern.`;
const WINDOW_MS = 24 * 3600e3;

function store(deps = {}) {
  if (deps.store) return deps.store;
  const { getStore } = require('@netlify/blobs');
  return getStore('agent-queue');
}
const keyOf = (chat) => String(chat || '').trim().replace(/[^0-9a-z:]/gi, '');

async function get(chat, deps = {}) {
  try { return (await store(deps).get(keyOf(chat), { type: 'json' })) || null; } catch { return null; }
}

/** Queue a chat. A chat already waiting keeps its place; a new issue after an agent joined waits again. */
async function add(chat, { reason = '', text = '' } = {}, deps = {}) {
  const key = keyOf(chat);
  if (!key) return null;
  const now = new Date().toISOString();
  const prev = await get(key, deps);
  const entry = prev && !prev.joined_at
    ? { ...prev, reason: reason || prev.reason, last_text: String(text || prev.last_text || '').slice(0, 300), updated_at: now }
    : { chat: key, since: now, reason: String(reason || '').slice(0, 120), last_text: String(text || '').slice(0, 300), updated_at: now, joined_at: null, joined_by: null };
  await store(deps).setJSON(key, entry);
  return entry;
}

async function markJoined(chat, by = AGENT_NAME(), deps = {}) {
  const prev = await get(chat, deps);
  if (!prev) return null;
  const entry = { ...prev, joined_at: new Date().toISOString(), joined_by: by };
  await store(deps).setJSON(keyOf(chat), entry);
  return entry;
}

/** Write an entry back as it was (an agent_open whose send failed). */
async function put(entry, deps = {}) {
  if (entry && entry.chat) await store(deps).setJSON(keyOf(entry.chat), entry);
}

async function remove(chat, deps = {}) {
  try { await store(deps).delete(keyOf(chat)); } catch { /* nothing queued */ }
}

/** Every queued chat, longest waiting first. */
async function list(deps = {}) {
  const s = store(deps);
  const { blobs } = await s.list();
  const rows = await Promise.all((blobs || []).map((b) => s.get(b.key, { type: 'json' }).catch(() => null)));
  return rows.filter(Boolean).sort((a, b) => Date.parse(a.since) - Date.parse(b.since));
}

/** Can a plain message still reach them? WhatsApp/Instagram: within 24 h of their last message. */
const inWindow = (lastUserAt, now = Date.now()) => {
  const t = Date.parse(lastUserAt || '');
  return Number.isFinite(t) && now - t < WINDOW_MS;
};

module.exports = { AGENT_NAME, WAIT_TEXT, joinText, keyOf, get, add, markJoined, put, remove, list, inWindow, WINDOW_MS };
