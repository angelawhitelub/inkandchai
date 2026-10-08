'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test';
const { loadHistory, historyWithCurrent, ORDER_QUERY_RE } = require('../whatsapp-bot')._internal;

/** bot_messages newest first, as the query asks; records the filters used. */
function fakeDb(rows, { fail = false } = {}) {
  const seen = {};
  const q = {
    select: () => q,
    eq: (c, v) => { seen[c] = v; return q; },
    gte: (c, v) => { seen.since = v; return q; },
    order: (c, o) => { seen.order = o; return q; },
    limit: (n) => { seen.limit = n; return Promise.resolve(fail ? { data: null, error: new Error('down') } : { data: rows, error: null }); },
  };
  return { seen, from: (t) => { seen.table = t; return q; } };
}

// The Garvita Nagar chat, 8 Oct 2026, as the Bot Inbox stored it (newest first).
const CHAT = [
  { role: 'user', message: 'Everything i know about love', created_at: '2026-10-08T15:26:00Z' },
  { role: 'bot', message: "I'm sorry to hear that! Could you please let me know which book is missing from your order?", created_at: '2026-10-08T15:21:30Z' },
  { role: 'user', message: 'One book is missing', created_at: '2026-10-08T15:21:20Z' },
  { role: 'bot', message: 'Hi! I can only read text messages right now', created_at: '2026-10-08T15:21:10Z' },
  { role: 'user', message: '[📷 Photo]', created_at: '2026-10-08T15:21:00Z' },
];

test('history comes from bot_messages, oldest first, bot and team as the assistant', async () => {
  const db = fakeDb(CHAT);
  const hist = await loadHistory('919898686551', { supabase: db, now: Date.parse('2026-10-08T15:26:05Z') });
  assert.equal(db.seen.table, 'bot_messages');
  assert.equal(db.seen.customer_phone, '919898686551');
  assert.equal(db.seen.since, '2026-10-07T15:26:05.000Z', 'only the last 24 hours');
  assert.deepEqual(hist.map((m) => m.role), ['user', 'assistant', 'user', 'assistant', 'user']);
  assert.equal(hist[2].content, 'One book is missing');
});

test('a fresh isolate still sends the model the whole exchange, the current message once', async () => {
  const stored = await loadHistory('919898686551', { supabase: fakeDb(CHAT), now: Date.parse('2026-10-08T15:26:05Z') });
  const msgs = historyWithCurrent(stored, 'Everything i know about love');
  assert.equal(msgs.filter((m) => m.content === 'Everything i know about love').length, 1);
  assert.ok(msgs.some((m) => m.content === 'One book is missing'));
  assert.equal(msgs[msgs.length - 1].role, 'user');
});

test('a retry that joins several stored messages does not send them twice', () => {
  const stored = [
    { role: 'assistant', content: 'Which book?' },
    { role: 'user', content: 'Everything i know' },
    { role: 'user', content: 'about love' },
  ];
  const msgs = historyWithCurrent(stored, 'Everything i know\nabout love');
  assert.deepEqual(msgs, [{ role: 'assistant', content: 'Which book?' }, { role: 'user', content: 'Everything i know\nabout love' }]);
});

test('a database fault returns null so the caller falls back to memory', async () => {
  assert.equal(await loadHistory('919898686551', { supabase: fakeDb([], { fail: true }) }), null);
});

test('a bare book title is not an order query on its own; the earlier message is', () => {
  assert.equal(ORDER_QUERY_RE.test('Everything i know about love'), false);
  assert.equal(ORDER_QUERY_RE.test('One book is missing'), true);
});
