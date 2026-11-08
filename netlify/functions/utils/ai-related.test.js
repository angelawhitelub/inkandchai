const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const ai = require('./ai-related');

function vecOf(...xs) {
  const v = new Float32Array(ai.DIMS);
  xs.forEach((x, i) => { v[i] = x; });
  return v;
}

function indexOf(rows) {
  const vec = new Int8Array(rows.length * ai.DIMS);
  rows.forEach(([, v], i) => ai.quantize(v, vec, i * ai.DIMS));
  const meta = { model: ai.MODEL, dims: ai.DIMS, slugs: rows.map(([s]) => s), hashes: rows.map(() => 'h') };
  return ai.buildIndex(meta, ai.fromBase64(ai.toBase64(vec)));
}

test('nearest books come back best first, never the book itself', () => {
  const index = indexOf([
    ['coffee', vecOf(1, 0.2, 0)],
    ['cafe-tales', vecOf(0.95, 0.25, 0.05)],
    ['japanese-novel', vecOf(0.8, 0.5, 0.1)],
    ['stock-market', vecOf(0, 0, 1)],
  ]);
  const out = ai.neighbours(index, ['coffee'], 5, 0.3);
  assert.deepEqual(out.map((r) => r.slug), ['cafe-tales', 'japanese-novel']);
  assert.ok(out[0].sim > out[1].sim);
});

test('an unknown book gets no AI neighbours rather than failing', () => {
  const index = indexOf([['a', vecOf(1)], ['b', vecOf(1)]]);
  assert.deepEqual(ai.neighbours(index, ['zzz']), []);
  assert.deepEqual(ai.neighbours(null, ['a']), []);
});

test('meta and vectors that disagree are ignored', () => {
  assert.equal(ai.buildIndex({ slugs: ['a', 'b'], dims: ai.DIMS }, new Int8Array(ai.DIMS)), null);
});

test('the embedded text is about the book, not the shop', () => {
  const t = ai.textFor({
    title: 'Ikigai Paperback #Trending', author: 'Various', category: 'Self-help (On Sale)',
    tags: 'r6s4, japanese, purpose', description: '<p>The Japanese secret to a long &amp; happy life</p>',
  });
  assert.doesNotMatch(t, /#Trending|Various|On Sale|r6s4|<p>/);
  assert.match(t, /japanese, purpose/);
  assert.match(t, /Japanese secret to a long/);
});

test('a close AI match lifts a book more than a distant one', () => {
  assert.ok(ai.aiBonus(0.7, 0) > ai.aiBonus(0.5, 0));
  assert.ok(ai.aiBonus(0.6, 0) > ai.aiBonus(0.6, 60));
  assert.equal(ai.aiBonus(0.25, 0), 0);
});

test('the nightly job only embeds books whose text changed, and a dry run calls nothing', async () => {
  const job = require('../ai-related-scheduled')._test;
  const kv = new Map();
  const store = {
    get: async (k, o) => (kv.has(k) ? (o && o.type === 'json' ? JSON.parse(kv.get(k)) : kv.get(k)) : null),
    set: async (k, v) => kv.set(k, v),
    setJSON: async (k, v) => kv.set(k, JSON.stringify(v)),
  };
  const rows = [
    { slug: 'x-one', title: 'Book One', author: 'A', category: 'Fiction', tags: '', description: 'one' },
    { slug: 'x-two', title: 'Book Two', author: 'B', category: 'Fiction', tags: '', description: 'two' },
  ];
  const supabase = {
    from: () => ({ select: () => ({ eq: () => ({ order: () => ({ range: async () => ({ data: rows, error: null }) }) }) }) }),
  };
  let calls = 0;
  const realFetch = global.fetch;
  global.fetch = async (_url, init) => {
    calls++;
    const { input } = JSON.parse(init.body);
    return {
      ok: true,
      json: async () => ({
        data: input.map((_, index) => {
          const f = new Float32Array(ai.DIMS); f[index % ai.DIMS] = 1;
          return { index, embedding: Buffer.from(f.buffer).toString('base64') };
        }),
        usage: { total_tokens: input.length * 10 },
      }),
    };
  };
  try {
    const dry = await job.run({ supabase, store, apiKey: 'k', limit: 100000, dryRun: true });
    assert.equal(calls, 0);
    assert.equal(kv.size, 0);
    assert.ok(dry.to_embed >= 2);
    const first = await job.run({ supabase, store, apiKey: 'k', limit: 100000, dryRun: false });
    assert.equal(first.embedded, first.to_embed);
    const before = calls;
    const second = await job.run({ supabase, store, apiKey: 'k', limit: 100000, dryRun: false });
    assert.equal(second.to_embed, 0, 'nothing changed, nothing re-embedded');
    assert.equal(calls, before);
    rows[0].description = 'changed';
    const third = await job.run({ supabase, store, apiKey: 'k', limit: 100000, dryRun: false });
    assert.equal(third.to_embed, 1);
  } finally {
    global.fetch = realFetch;
  }
});

test('the job is enabled, scheduled, and sends nothing to customers', () => {
  const root = path.resolve(__dirname, '../../..');
  const src = fs.readFileSync(path.join(root, 'netlify/functions/ai-related-scheduled.js'), 'utf8');
  assert.match(fs.readFileSync(path.join(root, 'worker/scheduled-jobs.mjs'), 'utf8'), /'ai-related-scheduled'/);
  assert.match(fs.readFileSync(path.join(root, 'jobs.toml'), 'utf8'), /\[functions\."ai-related-scheduled"\]\s+schedule = "0 22 \* \* \*"/);
  assert.doesNotMatch(src, /whatsapp|sendEmail|resend/i);
  assert.match(src, /MAX_TOKENS_PER_RUN = /);
  // An admin call is a dry run unless it says otherwise.
  assert.match(src, /dryRun: !fromCron && body\.dry_run !== false/);
});
