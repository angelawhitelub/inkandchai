const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const IG = require('./instagram');
const { _test: W } = require('../instagram-webhook');

const SECRET = 'test-app-secret';
const sign = (raw) => 'sha256=' + crypto.createHmac('sha256', SECRET).update(raw, 'utf8').digest('hex');

test('signature: Meta-signed body passes, anything else fails', () => {
  const raw = JSON.stringify({ object: 'instagram', entry: [] });
  assert.equal(IG.signatureOk(raw, sign(raw), [SECRET]), true);
  assert.equal(IG.signatureOk(raw + ' ', sign(raw), [SECRET]), false);
  assert.equal(IG.signatureOk(raw, sign(raw), ['other']), false);
  assert.equal(IG.signatureOk(raw, '', [SECRET]), false);
  assert.equal(IG.signatureOk(raw, sign(raw), []), false, 'no secret configured never passes');
});

test('GET handshake echoes the challenge only for the right verify word', async () => {
  process.env.INSTAGRAM_VERIFY_TOKEN = 'word';
  const ok = await W.handle({ httpMethod: 'GET', queryStringParameters: { 'hub.mode': 'subscribe', 'hub.verify_token': 'word', 'hub.challenge': '12345' } });
  assert.equal(ok.statusCode, 200); assert.equal(ok.body, '12345');
  const bad = await W.handle({ httpMethod: 'GET', queryStringParameters: { 'hub.mode': 'subscribe', 'hub.verify_token': 'nope', 'hub.challenge': '12345' } });
  assert.equal(bad.statusCode, 403);
  delete process.env.INSTAGRAM_VERIFY_TOKEN;
});

test('unsigned POST is refused before anything is read', async () => {
  const r = await W.handle({ httpMethod: 'POST', headers: {}, body: '{"object":"instagram"}' }, { secrets: [SECRET] });
  assert.equal(r.statusCode, 401);
});

test('incoming keeps customer DMs, drops our own echoes and empty events', () => {
  const body = { object: 'instagram', entry: [{ id: '178', messaging: [
    { sender: { id: '555' }, message: { mid: 'm1', text: 'price of ikigai?' } },
    { sender: { id: '178' }, message: { mid: 'm2', text: 'our reply', is_echo: true } },
    { sender: { id: '555' }, read: { mid: 'm1' } },
    { sender: { id: '556' }, message: { mid: 'm3', attachments: [{ type: 'image' }] } },
  ] }] };
  const out = W.incoming(body, '178');
  assert.deepEqual(out.map((d) => [d.sender, d.text, d.attachments.join()]), [['555', 'price of ikigai?', ''], ['556', '', 'image']]);
});

test('chunks split long replies under Instagram\'s 1000-character limit', () => {
  const long = ('word '.repeat(450)).trim();
  const parts = IG.chunks(long);
  assert.ok(parts.length >= 3);
  assert.ok(parts.every((p) => p.length <= 1000));
  assert.equal(parts.join(' '), long);
});

function fakeBot(reply) {
  const calls = { persisted: [], asked: null };
  return {
    calls,
    bot: {
      persistMessage: async (key, role, text) => { calls.persisted.push([key, role, text]); },
      isHumanTakeover: async () => false,
      buildOrderContext: async () => '',
      askOpenAI: async (key, text, extra, phoneId, opts) => { calls.asked = { key, text, extra, opts }; return reply; },
    },
  };
}

test('switch OFF: the DM is saved for the inbox, nothing is sent', async () => {
  const { bot, calls } = fakeBot('hi');
  let sent = 0;
  const r = await W.handleDm({ sender: '555', text: 'hello', attachments: [] }, { bot, botOn: async () => false, username: async () => '@reader', send: async () => { sent++; return { ok: true }; } });
  assert.equal(r.replied, false);
  assert.equal(sent, 0);
  assert.deepEqual(calls.persisted, [['ig:555', 'user', 'hello']]);
});

test('switch ON: answered in Instagram mode and the reply is saved', async () => {
  const { bot, calls } = fakeBot('Ikigai is ₹199: https://inkandchai.in/product/ikigai/');
  const sent = [];
  const r = await W.handleDm({ sender: '555', text: 'price of ikigai?', attachments: [] }, { bot, botOn: async () => true, username: async () => '@reader', send: async (to, t) => { sent.push([to, t]); return { ok: true }; } });
  assert.equal(r.replied, true);
  assert.equal(calls.asked.opts.channel, 'instagram');
  assert.match(calls.asked.extra, /Instagram DM/);
  assert.deepEqual(sent, [['ig:555', 'Ikigai is ₹199: https://inkandchai.in/product/ikigai/']]);
  assert.deepEqual(calls.persisted.map((p) => p[1]), ['user', 'bot']);
});

test('[ESCALATE] alerts the owner, hands the chat to a person, and is not shown to the customer', async () => {
  const { bot } = fakeBot('Our team will reply here shortly. [ESCALATE]');
  const alerts = []; const taken = []; const sent = [];
  await W.handleDm({ sender: '777', text: 'I want a refund', attachments: [] }, {
    bot, botOn: async () => true, username: async () => '@angry', send: async (to, t) => { sent.push(t); return { ok: true }; },
    alertOwner: async (m) => alerts.push(m), takeover: async (k) => taken.push(k),
  });
  assert.equal(alerts.length, 1);
  assert.deepEqual(taken, ['ig:777']);
  assert.equal(sent[0].includes('[ESCALATE]'), false);
});

test('the bot never sees order tools on Instagram: only find_book', () => {
  const { FIND_BOOK_TOOL } = require('../whatsapp-bot')._internal;
  assert.equal(FIND_BOOK_TOOL.function.name, 'find_book');
});
