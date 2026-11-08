/**
 * Scheduled + admin function: ai-related-scheduled
 *
 * Nightly (jobs.toml): keeps the AI book-similarity vectors in KV up to date
 * (see utils/ai-related.js). Embeds only books that are new or whose title,
 * author, category, tags or description changed; books that went inactive
 * drop out. Sends no messages and changes no product.
 *
 * Cost: text-embedding-3-small is $0.02 per million tokens. The first run
 * (~35k books, ~7M tokens) is about $0.15; a normal night is a few new books.
 * MAX_TOKENS_PER_RUN is a hard stop on top of that.
 *
 * Admin HTTP: POST { dry_run?: true, limit?: number } -- dry_run reports what
 * would be embedded and the cost, without calling OpenAI or writing anything.
 * The cron path is told apart by the event having no rawUrl.
 */
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { requireAdmin } = require('./utils/admin-auth');
const { makeSlug } = require('./utils/pricing');
const { catalogueCategory } = require('./utils/catalogue-category');
const ai = require('./utils/ai-related');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key, X-Admin-Token',
  'Content-Type': 'application/json',
};
const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });

const BATCH = 400;
const MAX_TOKENS_PER_RUN = 15_000_000;   // ~$0.30 ceiling, ~2x the first full run
const HTTP_DEFAULT_LIMIT = 4000;
const CHECKPOINT_EVERY = 8000;            // books embedded between KV saves
const USD_PER_M_TOKENS = 0.02;

const estTokens = (s) => Math.ceil(String(s).length / 4);

function readCatalogue() {
  const candidates = [
    path.join(process.cwd(), 'data', 'ALL_BOOKS.json'),
    path.join(__dirname, '..', '..', 'data', 'ALL_BOOKS.json'),
    path.join('/var/task', 'data', 'ALL_BOOKS.json'),
  ];
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return JSON.parse(fs.readFileSync(c, 'utf8')); } catch { /* next */ }
  }
  return [];
}

async function loadBooks(supabase) {
  const books = new Map();
  for (const b of readCatalogue()) {
    const slug = makeSlug(b.title, b.shopify_id);
    if (!slug || !b.title || books.has(slug)) continue;
    books.set(slug, { slug, title: b.title, author: b.author, category: catalogueCategory(b), tags: b.tags, description: b.description });
  }
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from('custom_products')
      .select('slug,title,author,category,tags,description')
      .eq('is_active', true)
      .order('slug', { ascending: true })
      .range(from, from + 999);
    if (error) throw new Error(`custom_products: ${error.message}`);
    for (const p of data || []) {
      const slug = String(p.slug || '').toLowerCase();
      if (slug && p.title && !books.has(slug)) books.set(slug, { ...p, slug });
    }
    if (!data || data.length < 1000) break;
  }
  return [...books.values()];
}

async function embed(texts, apiKey) {
  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: ai.MODEL, input: texts, dimensions: ai.DIMS, encoding_format: 'base64' }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${(body.error && body.error.message) || 'embedding failed'}`);
  const out = new Array(texts.length);
  for (const row of body.data || []) out[row.index] = ai.decodeFloat32(row.embedding);
  return { vectors: out, tokens: (body.usage && body.usage.total_tokens) || 0 };
}

async function readStore(store) {
  const [meta, vecB64] = await Promise.all([
    store.get(ai.META_KEY, { type: 'json' }).catch(() => null),
    store.get(ai.VEC_KEY).catch(() => null),
  ]);
  const vec = vecB64 ? ai.fromBase64(vecB64) : null;
  const old = new Map();
  if (meta && Array.isArray(meta.slugs) && vec && vec.length === meta.slugs.length * (meta.dims || ai.DIMS)
      && meta.model === ai.MODEL && (meta.dims || ai.DIMS) === ai.DIMS) {
    meta.slugs.forEach((slug, i) => old.set(slug, { hash: meta.hashes[i], vec: vec.subarray(i * ai.DIMS, (i + 1) * ai.DIMS) }));
  }
  return old;
}

async function writeStore(store, entries) {
  const slugs = [];
  const hashes = [];
  const vec = new Int8Array(entries.length * ai.DIMS);
  entries.forEach((e, i) => { slugs.push(e.slug); hashes.push(e.hash); vec.set(e.vec, i * ai.DIMS); });
  // Vectors first: a reader that sees new meta with old vectors finds the
  // lengths disagree and simply skips AI for that request.
  await store.set(ai.VEC_KEY, ai.toBase64(vec));
  await store.setJSON(ai.META_KEY, { model: ai.MODEL, dims: ai.DIMS, updated_at: new Date().toISOString(), slugs, hashes });
}

async function run({ supabase, store, apiKey, limit, dryRun, log = () => {} }) {
  const books = await loadBooks(supabase);
  const old = await readStore(store);
  const keep = [];
  const todo = [];
  for (const b of books) {
    const text = ai.textFor(b);
    const hash = ai.hashText(text);
    const prev = old.get(b.slug);
    if (prev && prev.hash === hash) keep.push({ slug: b.slug, hash, vec: prev.vec });
    else todo.push({ slug: b.slug, hash, text });
  }
  const summary = {
    books: books.length,
    unchanged: keep.length,
    to_embed: todo.length,
    dropped: (() => { const live = new Set(books.map((b) => b.slug)); return [...old.keys()].filter((s) => !live.has(s)).length; })(),
    est_tokens: todo.reduce((s, t) => s + estTokens(t.text), 0),
  };
  summary.est_cost_usd = Math.round(summary.est_tokens / 1e6 * USD_PER_M_TOKENS * 1000) / 1000;
  if (dryRun) return { ...summary, dry_run: true };
  if (!apiKey) throw new Error('OPENAI_API_KEY is not set');

  const queue = todo.slice(0, limit);
  let tokens = 0;
  let embedded = 0;
  let sinceSave = 0;
  for (let i = 0; i < queue.length; i += BATCH) {
    if (tokens >= MAX_TOKENS_PER_RUN) { summary.stopped = 'token ceiling'; break; }
    const batch = queue.slice(i, i + BATCH);
    const { vectors, tokens: used } = await embed(batch.map((t) => t.text), apiKey);
    tokens += used;
    batch.forEach((t, k) => {
      if (!vectors[k]) return;
      const v = new Int8Array(ai.DIMS);
      ai.quantize(vectors[k], v, 0);
      keep.push({ slug: t.slug, hash: t.hash, vec: v });
      embedded++;
    });
    sinceSave += batch.length;
    if (sinceSave >= CHECKPOINT_EVERY) { await writeStore(store, keep); sinceSave = 0; log(`[ai-related] checkpoint ${embedded}`); }
  }
  // Books whose text changed but did not get a new vector this run keep the old one.
  const have = new Set(keep.map((e) => e.slug));
  for (const t of todo) {
    const prev = old.get(t.slug);
    if (!have.has(t.slug) && prev) keep.push({ slug: t.slug, hash: 'stale', vec: prev.vec });
  }
  await writeStore(store, keep);
  return { ...summary, embedded, stored: keep.length, tokens, cost_usd: Math.round(tokens / 1e6 * USD_PER_M_TOKENS * 1000) / 1000 };
}

exports.handler = async (event = {}) => {
  const fromCron = !event.rawUrl;
  let body = {};
  if (!fromCron) {
    if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
    if (event.httpMethod !== 'POST') return json(405, { error: 'POST only' });
    const blocked = requireAdmin(event, CORS);
    if (blocked) return blocked;
    try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }
  }
  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const store = require('@netlify/blobs').getStore(ai.STORE);
    const limit = fromCron ? 60000 : Math.max(1, Math.min(60000, Number(body.limit) || HTTP_DEFAULT_LIMIT));
    const summary = await run({
      supabase, store, apiKey: process.env.OPENAI_API_KEY, limit,
      dryRun: !fromCron && body.dry_run !== false, log: console.log,
    });
    console.log('[ai-related]', JSON.stringify(summary));
    return json(200, summary);
  } catch (err) {
    console.error('[ai-related] failed:', err.message);
    return json(500, { error: err.message });
  }
};

exports._test = { run, loadBooks, readStore, writeStore };
