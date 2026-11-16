'use strict';
// Reading-list agent: OpenAI-written /best-books/ pages, grounded in our stock.
const test = require('node:test');
const assert = require('node:assert/strict');

// In-memory @netlify/blobs before the agent loads it.
const mem = new Map();
const Module = require('module');
const fakeBlobs = {
  getStore: (name) => ({
    async get(key) { const v = mem.get(`${name}:${key}`); return v ? JSON.parse(v) : null; },
    async setJSON(key, value) { mem.set(`${name}:${key}`, JSON.stringify(value)); },
  }),
};
const origLoad = Module._load;
Module._load = function (req, ...rest) { return req === '@netlify/blobs' ? fakeBlobs : origLoad.call(this, req, ...rest); };

const agent = require('./reading-list-agent');
const RL = require('./reading-lists');

const note = (t) => `${t} is a thoughtful pick for readers who want to build better habits and stick with them.`;
const candidateBooks = Array.from({ length: 20 }, (_, i) => ({ slug: `book-${i + 1}`, title: `Book ${i + 1}`, author: 'A. Writer', price: 199 }));

function fakeWriter({ ids = candidateBooks.slice(0, 14).map((_, i) => `c${i + 1}`), extra = {} } = {}) {
  return {
    title: 'Books Like Atomic Habits: 14 Reads to Build Better Habits',
    h1: 'Books Like Atomic Habits',
    description: 'Loved Atomic Habits? These books on habits, focus and self-discipline are the natural next reads, from Charles Duhigg to Cal Newport.',
    intro: 'If Atomic Habits changed how you think about small daily actions, these books take the same ideas further: focus, discipline and how change really sticks.',
    picks: ids.map((id) => ({ id, name: `Title ${id}`, by: 'A. Writer', note: note(id) })),
    body: [
      { heading: 'How we picked', text: 'We chose books that share the practical, research-backed approach of Atomic Habits, and that our readers keep buying together with it. Each one gives you something you can try the same day, not just inspiration.' },
      { heading: 'Where to start', text: 'Start with the habit books if you want a direct follow-up, then move on to focus and productivity. If you prefer stories to systems, the memoirs on this list show the same ideas at work in real lives.' },
    ],
    faq: [
      { q: 'What should I read after Atomic Habits?', a: 'The Power of Habit is the closest follow-up, and Deep Work is ideal if focus is your goal.' },
      { q: 'Are these books good for students?', a: 'Yes. Most are short, practical and easy to apply to study routines.' },
    ],
    ...extra,
  };
}

test('a written list is checked: only candidates, 10-20 picks, sane lengths, no links', () => {
  const ok = agent.validateWritten(fakeWriter(), candidateBooks, { slug: 'books-like-atomic-habits', topic: 'Books like Atomic Habits' });
  assert.ok(ok.list, JSON.stringify(ok.errors));
  assert.equal(ok.list.picks.length, 14);
  assert.equal(ok.list.picks[0].slug, 'book-1');

  const invented = agent.validateWritten(fakeWriter({ ids: [...candidateBooks.slice(0, 12).map((_, i) => `c${i + 1}`), 'c99'] }), candidateBooks, { slug: 's', topic: 't' });
  assert.match(invented.errors.join(' '), /c99 is not a candidate/);

  const few = agent.validateWritten(fakeWriter({ ids: ['c1', 'c2', 'c3'] }), candidateBooks, { slug: 's', topic: 't' });
  assert.match(few.errors.join(' '), /3 picks/);

  const long = fakeWriter();
  long.picks[0].name = 'The Subtle Art of Not Giving a F*ck A Counterintuitive Approach to Living a Good Life Paperback Edition';
  const trimmed = agent.validateWritten(long, candidateBooks, { slug: 's', topic: 't' });
  assert.ok(trimmed.list, JSON.stringify(trimmed.errors));
  assert.ok(trimmed.list.picks[0].name.length <= 90 && trimmed.list.picks[0].name.endsWith('…'));

  const linky = agent.validateWritten(fakeWriter({ extra: { intro: 'Buy now at https://example.com — the best habit books, all in one place for you to enjoy today and every day after.' } }), candidateBooks, { slug: 's', topic: 't' });
  assert.match(linky.errors.join(' '), /intro has a link/);
});

test('topics: the owner queue first, then seeds, then our bestsellers; never one twice', () => {
  const doc = { lists: [], topics: { queued: [{ topic: 'Books for new parents' }], done: [] }, settings: {} };
  assert.deepEqual(agent.nextTopic(doc), { topic: 'Books for new parents', source: 'queue' });
  doc.topics.queued = [];
  assert.equal(agent.nextTopic(doc).topic, agent.SEED_TOPICS[0]);
  doc.topics.done = [...agent.SEED_TOPICS];
  assert.deepEqual(agent.nextTopic(doc, { bestsellerTitles: ['Ikigai: The Japanese Secret | Hindi', 'The Silent Patient by Alex Michaelides'] }),
    { topic: 'Books like The Silent Patient', source: 'bestseller' });   // Ikigai is already a seed
  // A hand-written list's topic is never written again.
  assert.ok(!/^Books Like It Ends With Us$/i.test(String((agent.nextTopic({ lists: [], topics: { queued: [{ topic: 'Books like It Ends With Us' }], done: agent.SEED_TOPICS }, settings: {} }) || {}).topic)));
});

test('slugs are clean and never collide', () => {
  const taken = new Set(['books-like-atomic-habits', ...RL.LISTS.map((l) => l.slug)]);
  assert.equal(agent.slugFor('Books Like Atomic Habits!', 'x', taken), 'books-like-atomic-habits-2');
  assert.equal(agent.slugFor('', 'Gift books for book lovers under ₹500', new Set()), 'gift-books-for-book-lovers-under-500');
});

test('one run: plans, keeps in-stock books only, writes a draft; the page renders it', async () => {
  mem.clear();
  const prompts = [];
  const ai = async (messages) => {
    prompts.push(messages);
    if (prompts.length === 1) return { slug: 'books-like-atomic-habits', max_price: null, queries: ['atomic habits', 'power of habit', 'deep work', 'james clear', 'charles duhigg', 'cal newport', 'habits'] };
    const cands = JSON.parse(messages[1].content).candidates;
    return fakeWriter({ ids: cands.slice(0, 12).map((c) => c.id) });
  };
  const priceBooks = async (slugs) => Object.fromEntries(slugs.map((s, i) => [s, i % 5 === 4 ? { price: 0 } : { price: 199 + i }]));
  const r = await agent.generateOne({ topic: 'Books like Atomic Habits' }, { supabase: null, priceBooks, ai });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.status, 'draft');
  const sent = JSON.parse(prompts[1][1].content).candidates;
  assert.ok(sent.every((c) => c.price > 0), 'only priced books reach the writer');

  const doc = await agent.readDoc();
  assert.equal(doc.lists.length, 1);
  assert.equal(doc.lists[0].status, 'draft');
  assert.ok(doc.lists[0].preview_token.length >= 16);
  assert.ok(doc.topics.done.includes('Books like Atomic Habits'));
  // Drafts are not public; publishing makes the page.
  assert.equal(RL.allLists(doc).length, RL.LISTS.length);
  await agent.applyAction('publish', { slug: doc.lists[0].slug });
  const all = RL.allLists(await agent.readDoc());
  const list = RL.listFor(doc.lists[0].slug, all);
  assert.ok(list && list.generated);
  const books = Object.fromEntries(list.picks.map((p) => [p.slug.toLowerCase(), { price: 199, img: '/x.webp' }]));
  const parts = RL.renderList(list, books, all);
  assert.equal(parts.count, 12);
  assert.match(parts.main, /Delivery and payment/);
  assert.ok(!parts.main.includes('<script'));
});

test('a failed check gets one retry with the problems listed', async () => {
  mem.clear();
  let calls = 0; let feedback = '';
  const ai = async (messages) => {
    calls += 1;
    if (calls === 1) return { slug: 'books-like-ikigai', queries: ['atomic habits', 'power of habit', 'deep work', 'james clear', 'charles duhigg', 'cal newport', 'habits'] };
    const cands = JSON.parse(messages[1].content).candidates;
    if (calls === 2) return fakeWriter({ ids: cands.slice(0, 3).map((c) => c.id) });
    feedback = messages[messages.length - 1].content;
    return fakeWriter({ ids: cands.slice(0, 11).map((c) => c.id) });
  };
  const priceBooks = async (slugs) => Object.fromEntries(slugs.map((s) => [s, { price: 250 }]));
  const r = await agent.generateOne({ topic: 'Books like Ikigai' }, { supabase: null, priceBooks, ai });
  assert.equal(r.ok, true, r.error);
  assert.equal(calls, 3);
  assert.match(feedback, /3 picks/);
});

test('too few books in stock: no list, topic set aside', async () => {
  mem.clear();
  const ai = async () => ({ slug: 'books-like-nothing', queries: ['zzqx', 'qqzz', 'xxyy', 'yyxx', 'zzzz'] });
  const r = await agent.generateOne({}, { supabase: null, priceBooks: async () => ({}), ai });
  assert.equal(r.ok, false);
  assert.match(r.error, /in-stock books match/);
  assert.equal((await agent.readDoc()).topics.done.length, 1);
});

test('scheduled runs honour the switch and the interval', () => {
  const now = Date.parse('2026-11-20T22:00:00Z');
  const doc = (over) => ({ lists: [{ created_at: '2026-11-18T22:00:00Z' }], settings: { enabled: true, every_days: 3, ...over } });
  assert.equal(agent.isDue(doc(), now), false);
  assert.equal(agent.isDue(doc({ every_days: 2 }), now), true);
  assert.equal(agent.isDue(doc({ enabled: false, every_days: 1 }), now), false);
});
