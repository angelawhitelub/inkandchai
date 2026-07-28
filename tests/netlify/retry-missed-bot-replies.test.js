const test = require('node:test');
const assert = require('node:assert/strict');

const {
  combinePendingMessages,
  findMissedConversations,
} = require('../../netlify/functions/retry-missed-bot-replies')._test;

const conversations = [
  { customer_phone: '111', whatsapp_phone_id: 'phone-a', status: 'active', human_takeover: false },
  { customer_phone: '222', whatsapp_phone_id: 'phone-a', status: 'active', human_takeover: false },
  { customer_phone: '333', whatsapp_phone_id: 'phone-a', status: 'active', human_takeover: true },
  { customer_phone: '444', whatsapp_phone_id: 'phone-a', status: 'resolved', human_takeover: false },
  { customer_phone: '555', whatsapp_phone_id: null, status: 'active', human_takeover: false },
];

test('finds only active customer-last conversations and preserves trailing message order', () => {
  const messages = [
    { customer_phone: '111', role: 'bot', message: 'How can I help?', created_at: '2026-07-29T01:00:00Z' },
    { customer_phone: '111', role: 'user', message: 'Where is my order?', created_at: '2026-07-29T01:01:00Z' },
    { customer_phone: '111', role: 'user', message: 'I need it urgently', created_at: '2026-07-29T01:02:00Z' },
    { customer_phone: '222', role: 'user', message: 'Hello', created_at: '2026-07-29T01:03:00Z' },
    { customer_phone: '222', role: 'admin', message: 'Hi', created_at: '2026-07-29T01:04:00Z' },
    { customer_phone: '333', role: 'user', message: 'Taken over', created_at: '2026-07-29T01:05:00Z' },
    { customer_phone: '444', role: 'user', message: 'Resolved', created_at: '2026-07-29T01:06:00Z' },
    { customer_phone: '555', role: 'user', message: 'Unknown sender', created_at: '2026-07-29T01:07:00Z' },
  ];

  const found = findMissedConversations(messages, conversations, 10);
  assert.equal(found.length, 1);
  assert.equal(found[0].phone, '111');
  assert.deepEqual(found[0].messages.map(row => row.message), ['Where is my order?', 'I need it urgently']);
});

test('oldest unanswered conversations are processed first and the limit is enforced', () => {
  const convs = ['111', '222', '333'].map(phone => ({
    customer_phone: phone,
    whatsapp_phone_id: 'phone-a',
    status: 'active',
    human_takeover: false,
  }));
  const messages = [
    { customer_phone: '111', role: 'user', message: 'third', created_at: '2026-07-29T03:00:00Z' },
    { customer_phone: '222', role: 'user', message: 'first', created_at: '2026-07-29T01:00:00Z' },
    { customer_phone: '333', role: 'user', message: 'second', created_at: '2026-07-29T02:00:00Z' },
  ];
  assert.deepEqual(findMissedConversations(messages, convs, 2).map(item => item.phone), ['222', '333']);
});

test('combines consecutive customer messages into one clear recovery prompt', () => {
  assert.equal(combinePendingMessages([{ message: 'Hi' }]), 'Hi');
  assert.equal(
    combinePendingMessages([{ message: 'Where is my order?' }, { message: 'It has been eight days' }]),
    'The customer sent these messages while support was temporarily unavailable:\n1. Where is my order?\n2. It has been eight days'
  );
});
