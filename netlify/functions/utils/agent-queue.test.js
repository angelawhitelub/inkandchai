const test = require('node:test');
const assert = require('node:assert');
const AQ = require('./agent-queue');
const guard = require('./belonging-guard');
const credit = require('./credit-alert');

function memStore() {
  const m = new Map();
  return {
    m,
    get: async (k) => (m.has(k) ? JSON.parse(m.get(k)) : null),
    setJSON: async (k, v) => { m.set(k, JSON.stringify(v)); },
    delete: async (k) => { m.delete(k); },
    list: async () => ({ blobs: [...m.keys()].map((key) => ({ key })) }),
  };
}

test('queue: waiting chats keep their place, list is longest-waiting first, close removes', async () => {
  const store = memStore();
  const a = await AQ.add('919800000001', { reason: 'Bot handed over', text: 'refund?' }, { store });
  await new Promise((r) => setTimeout(r, 5));
  await AQ.add('ig:555', { reason: 'Bot handed over (Instagram)' }, { store });
  const again = await AQ.add('919800000001', { text: 'hello??' }, { store });
  assert.equal(again.since, a.since, 'a second message does not move them to the back');
  assert.equal(again.last_text, 'hello??');
  assert.deepEqual((await AQ.list({ store })).map((e) => e.chat), ['919800000001', 'ig:555']);

  const joined = await AQ.markJoined('919800000001', 'Anil', { store });
  assert.ok(joined.joined_at);
  const fresh = await AQ.add('919800000001', { text: 'new issue' }, { store });
  assert.equal(fresh.joined_at, null, 'a new hand-over after the agent joined waits again');

  await AQ.remove('ig:555', { store });
  assert.deepEqual((await AQ.list({ store })).map((e) => e.chat), ['919800000001']);
});

test('the words: wait message and the agent-joined message', () => {
  assert.equal(AQ.WAIT_TEXT, 'The next available agent will take up your issue and talk to you here. 🙏');
  assert.equal(AQ.joinText(), 'Agent Anil is now available to talk to you. Please reply to share your concern.');
});

test('24-hour window', () => {
  const now = Date.parse('2026-11-25T12:00:00Z');
  assert.equal(AQ.inWindow('2026-11-25T01:00:00Z', now), true);
  assert.equal(AQ.inWindow('2026-11-24T11:00:00Z', now), false);
  assert.equal(AQ.inWindow(null, now), false);
});

test('no customer ever gets the team number: it is swapped for the agent line and handed over', () => {
  const out = guard.scrub('Sure! Tap here to chat with our team 👉 https://wa.me/919217175546 — they reply fast. Thanks for waiting!');
  assert.doesNotMatch(out, /9217|wa\.me/);
  assert.match(out, /next available agent/);
  assert.match(out, /\[ESCALATE\]$/);
  assert.equal(guard.scrub('Your order is out for delivery 📦'), 'Your order is out for delivery 📦');
  assert.doesNotMatch(guard.scrub('Call +91 92171 75546 between 4 and 5 PM.'), /9217|92171/);
  // The posted-returns phone is allowed.
  assert.match(guard.scrub('Send it to 6, Ansari Road, Delhi - 110002 (phone 92175 87201).'), /92175 87201/);
});

test('out of credits is told apart from a passing rate limit; one email per 3 hours', async () => {
  assert.equal(credit.isOpenAIQuota(429, { error: { code: 'insufficient_quota', message: 'You exceeded your current quota' } }), true);
  assert.equal(credit.isOpenAIQuota(429, { error: { code: 'rate_limit_exceeded', message: 'Rate limit reached for requests' } }), false);
  const store = memStore();
  const mails = [];
  const deps = { store, to: 'owner@example.com', sendEmail: async (m) => { mails.push(m); return { ok: true }; } };
  const t0 = Date.parse('2026-11-25T10:00:00Z');
  assert.equal(await credit.notifyOutOfCredits('OpenAI', 'quota', { ...deps, now: t0 }), 'sent');
  assert.equal(await credit.notifyOutOfCredits('OpenAI', 'quota', { ...deps, now: t0 + 3600e3 }), 'throttled');
  assert.equal(await credit.notifyOutOfCredits('OpenAI', 'quota', { ...deps, now: t0 + 3.1 * 3600e3 }), 'sent');
  assert.equal(mails.length, 2);
  assert.match(mails[0].subject, /OpenAI credits have run out/);
});
