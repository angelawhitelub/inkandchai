'use strict';
/**
 * Reading-list agent (owner, 16 Nov 2026): writes new /best-books/ pages with
 * OpenAI, grounded in what we actually sell.
 *
 * One run makes one list:
 *   1. topic   - the owner's queue first, then SEED_TOPICS, then "Books like
 *                <bestseller>" from our own sales ranks; never a topic twice.
 *   2. plan    - OpenAI turns the topic into catalogue searches (titles,
 *                authors, themes) and a page slug, and says if there's a budget.
 *   3. search  - those searches run over the catalogue file and custom_products.
 *                Only in-stock books the till prices (and within budget) stay.
 *   4. write   - OpenAI picks 10-20 of THOSE books (by id, it cannot add any)
 *                and writes the page: title, intro, a note per book, sections, FAQ.
 *   5. check   - every field is validated; anything off fails the run.
 *   6. save    - a draft for review in admin (or published, if the owner turned
 *                auto-publish on), in KV catalog:reading-lists.
 *
 * Nothing here sends a message or changes a product.
 */

const crypto = require('crypto');
const { getStore } = require('@netlify/blobs');
const { makeSlug } = require('./pricing');
const { LISTS, SLUG_RE } = require('./reading-lists');
const CATALOGUE = require('../../../data/ALL_BOOKS.json');

const STORE = 'catalog';
const KEY = 'reading-lists';
const MODEL = () => process.env.OPENAI_READING_LIST_MODEL || 'gpt-4.1';
const DEFAULT_SETTINGS = { enabled: true, auto_publish: false, every_days: 3 };
const MAX_STORED = 400;

// Evergreen topics Indian readers search for, in the order they are written.
// The owner's own topics (admin queue) always go first.
const SEED_TOPICS = [
  'Books like Atomic Habits',
  'Books like The Psychology of Money',
  'Books like Rich Dad Poor Dad',
  'Books like Ikigai',
  'Books like The Alchemist',
  'Books like Sapiens',
  'Books like Verity',
  'Books like Fourth Wing',
  'Books like Twisted Love',
  'Books like A Good Girl\'s Guide to Murder',
  'Best Freida McFadden books',
  'Best Colleen Hoover books',
  'Best books on investing for beginners in India',
  'Best books on stock market trading',
  'Best business books for entrepreneurs',
  'Best Hindi novels',
  'Best Hindi self-help books',
  'Best Urdu and Hindi poetry books',
  'Best Indian mythology fiction',
  'Best fantasy books for beginners',
  'Best manga for beginners',
  'Best books for first-time readers',
  'Short books you can finish in a weekend',
  'Best books for college students',
  'Gift books for book lovers under ₹500',
  'Best romance books under ₹250',
  'Best spiritual books',
  'Best biographies of Indian leaders',
  'Books like Harry Potter for kids',
  'Best books on productivity and focus',
];

const store = () => getStore(STORE);

async function readDoc() {
  const doc = await store().get(KEY, { type: 'json' });
  return {
    lists: Array.isArray(doc && doc.lists) ? doc.lists : [],
    topics: { queued: (doc && doc.topics && doc.topics.queued) || [], done: (doc && doc.topics && doc.topics.done) || [] },
    settings: { ...DEFAULT_SETTINGS, ...((doc && doc.settings) || {}) },
    last_run: (doc && doc.last_run) || null,
  };
}

async function writeDoc(doc) {
  const lists = doc.lists.slice(-MAX_STORED);
  await store().setJSON(KEY, { ...doc, lists, updated_at: new Date().toISOString() });
}

const topicKey = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9₹]+/g, ' ').trim();

/** "Atomic Habits: An Easy & Proven Way… by James Clear | Hindi" -> "Atomic Habits". */
function cleanTitle(title) {
  return String(title || '').split(/\s[|–—]\s|\s-\s|:|\(|\[/)[0].replace(/\s+by\s+.*$/i, '').replace(/#\w+/g, '').trim();
}

/** The next topic: the owner's queue, then the seeds, then our own bestsellers. */
function nextTopic(doc, { bestsellerTitles = [] } = {}) {
  const done = new Set([...doc.topics.done, ...LISTS.map((l) => l.h1), ...doc.lists.map((l) => l.topic || '')].map(topicKey));
  const queued = doc.topics.queued.map((q) => (typeof q === 'string' ? q : q && q.topic)).filter(Boolean);
  for (const t of queued) if (!done.has(topicKey(t))) return { topic: t, source: 'queue' };
  for (const t of SEED_TOPICS) if (!done.has(topicKey(t))) return { topic: t, source: 'seed' };
  for (const title of bestsellerTitles) {
    const clean = cleanTitle(title);
    if (clean.length < 3 || clean.length > 60) continue;
    const t = `Books like ${clean}`;
    if (!done.has(topicKey(t))) return { topic: t, source: 'bestseller' };
  }
  return null;
}

// ── OpenAI ──────────────────────────────────────────────────────────────────
async function openaiJson(messages, { fetchImpl = fetch, apiKey = process.env.OPENAI_API_KEY, temperature = 0.4 } = {}) {
  if (!apiKey) throw new Error('OPENAI_API_KEY is not set');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 90_000);
  try {
    const res = await fetchImpl('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL(), temperature, response_format: { type: 'json_object' }, messages }),
      signal: ctrl.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`OpenAI ${res.status}: ${(data.error && data.error.message) || 'error'}`);
    const text = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    return JSON.parse(text || '{}');
  } finally {
    clearTimeout(timer);
  }
}

const PLAN_PROMPT = `You plan a reading-list page for Ink & Chai, an online bookstore in India.
Given a topic, return JSON:
{"slug": "url-slug-for-the-page (lowercase words joined by hyphens, 3-8 words, no year)",
 "max_price": null or a whole number of rupees if the topic sets a budget,
 "language": "english" | "hindi" | "any",
 "queries": ["15 to 25 short catalogue searches"]}
Queries are matched against book titles and author names, so use: exact titles of well-known
books that fit the topic (one title per query, 1-5 words), author names, and a few one- or
two-word themes. Include the book named in the topic itself when there is one.`;

const WRITE_PROMPT = `You write reading-list pages for Ink & Chai, an online bookstore in India.
You get a topic and CANDIDATES: books we have in stock, each with an id. Return JSON:
{"title": "SEO page title, 40-70 characters, may end with (2026) only if natural",
 "h1": "the page heading, under 60 characters",
 "description": "meta description, 120-160 characters, names a few authors or titles",
 "intro": "2-3 sentences, 200-450 characters, plain text",
 "picks": [{"id": "c12", "name": "the book's title only: no 'by Author', no edition or format words", "by": "the real author's name(s), or empty", "note": "1-2 sentences, 80-260 characters", "group": "optional short group heading"}],
 "body": [{"heading": "short heading", "text": "one paragraph, 250-700 characters"}],
 "faq": [{"q": "a question readers search for", "a": "1-3 sentences"}]}
Rules:
- Choose 12 to 20 picks, ONLY from the candidates, by id, best and most fitting first. Never invent books.
- Skip candidates that do not truly fit the topic, duplicates of the same book, and used/"preloved" copies.
- If the topic is "Books like X", never pick X itself, nor its other editions, summaries, workbooks or combos that include it.
- Prefer books you recognise. If you are not sure a candidate is a genuine published book by that author (catalogue listings can be wrong), skip it.
- For a series, pick the first book or one strong entry point, not several volumes of the same series, unless the topic is that series.
- Never call a book new, upcoming, anticipated or the latest: the page stays up for years.
- Write author names in natural order ("Paulo Coelho", not "Coelho Paulo").
- The candidate "author" field is sometimes a shelf or series label (e.g. "Crossword Recommends", "Daily Habits", "Emotional Intelligence"). In "by", give only a real person's name you are sure of; otherwise leave it empty.
- FAQ answers may only state facts about books on this list or give general reading advice. Never say other editions, translations or formats are available.
- Use "group" only when 2-4 groups genuinely help readers (e.g. "Start here", "If you want something lighter"); otherwise leave it out of every pick.
- Do not call a book "official", "bestselling" or "award-winning" unless the candidate description says so.
- Notes say why a reader of this topic would enjoy the book. Base specifics only on the candidate description or facts you are certain of. Never invent plot details, awards, sales figures or quotes. No spoilers.
- Body: 2-3 sections (e.g. how we picked, where to start). FAQ: 3-4 questions.
- Plain text only: no HTML, no markdown, no links, no emojis. Do not mention prices, discounts, delivery or the store's policies.
- Clear, warm, direct English for Indian readers. Avoid filler words like "delve", "tapestry", "embark", "unleash", "must-read" and "game-changer".`;

// ── Catalogue search ────────────────────────────────────────────────────────
const STOP = new Set(['by', 'the', 'a', 'an', 'of', 'and', '&', 'books', 'book', 'best', 'like']);
const words = (q) => [...new Set(String(q || '').toLowerCase().replace(/[^\p{L}\p{N}\s'-]/gu, ' ').split(/\s+/)
  .filter((w) => w.length >= 2 && !STOP.has(w)))].slice(0, 5);
const plain = (s) => String(s || '').replace(/[#*_`>]+/g, ' ').replace(/\s+/g, ' ').trim();

let _cat = null;
function catalogueRows() {
  if (_cat) return _cat;
  const seen = new Set();
  _cat = [];
  for (const b of CATALOGUE) {
    const slug = makeSlug(b.title, b.shopify_id);
    if (!slug || !b.title || seen.has(slug)) continue;
    seen.add(slug);
    _cat.push({ slug, title: b.title, author: b.author || '', tags: String(b.tags || '').toLowerCase(), description: plain(b.description).slice(0, 400) });
  }
  return _cat;
}

async function searchCandidates(queries, supabase, { perQuery = 10, max = 90 } = {}) {
  const found = new Map();
  const add = (r) => { if (r.slug && !found.has(r.slug.toLowerCase()) && found.size < max) found.set(r.slug.toLowerCase(), r); };
  for (const q of queries.slice(0, 25)) {
    const w = words(q);
    if (!w.length) continue;
    let n = 0;
    for (const b of catalogueRows()) {
      const hay = `${b.title} ${b.author}`.toLowerCase();
      if (w.every((x) => hay.includes(x)) || (w.length === 1 && b.tags.includes(w[0]))) { add(b); if (++n >= perQuery) break; }
    }
    if (supabase && found.size < max) {
      let query = supabase.from('custom_products').select('slug,title,author,description').eq('is_active', true);
      for (const x of w) query = query.or(`title.ilike.%${x.replace(/[%,()]/g, '')}%,author.ilike.%${x.replace(/[%,()]/g, '')}%`);
      const { data, error } = await query.limit(perQuery);
      if (!error) for (const r of data || []) add({ slug: String(r.slug), title: r.title || '', author: r.author || '', description: plain(r.description).slice(0, 400) });
    }
  }
  // Used copies and obvious duplicates out; the writer is told to skip the rest.
  const byTitle = new Set();
  return [...found.values()].filter((b) => {
    if (/\bpreloved\b|\bused\b/i.test(b.title)) return false;
    const k = `${cleanTitle(b.title).toLowerCase()}|${/hindi/i.test(b.title) ? 'hi' : 'en'}`;
    if (byTitle.has(k)) return false;
    byTitle.add(k);
    return true;
  });
}

// ── Validation ──────────────────────────────────────────────────────────────
const BANNED = /https?:|www\.|<|>|\bdelve|\btapestry|\bgame-?changer|\bupcoming\b|\banticipated\b|\blatest (?:book|release|instal)/i;
function checkText(label, value, min, max, errors) {
  const s = String(value || '').trim();
  if (s.length < min || s.length > max) errors.push(`${label} is ${s.length} characters (want ${min}-${max})`);
  if (BANNED.test(s)) errors.push(`${label} has a link, HTML or a banned word`);
  return s;
}

/** The writer's JSON as a stored list, or { errors }. */
/** "Books like X" -> "x" (normalised), so X, its combos and workbooks stay off its own list. */
const norm = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
function likeSubject(topic) {
  const m = String(topic || '').match(/^books?\s+(?:like|similar to)\s+(.+)$/i);
  const k = m ? norm(m[1]) : '';
  return k.length >= 4 ? k : '';
}

/** A shelf or series label in the author field is not an author. */
const NOT_A_PERSON = /\b(recommends?|habits?|intelligence|editions?|collections?|combo|bestsellers?|series|books?|classics?|publications?|press|publishers?|unknown|various|paperback|hardcover|hb|pb)\b/i;
function personName(by) {
  const t = String(by || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  // A full name: "Stephen" alone (a cut-off catalogue field) is not credited.
  return t && !NOT_A_PERSON.test(t) && /\S\s+\S/.test(t) ? t : '';
}

/** Catalogue junk out of a display name: hashtags, "| Hindi", format words, "by Author". */
const FORMAT = /\s*\((?:paperback|hardcover|hard cover|hb|pb|lead title|pocket classic|penguin classics|tbp|[^)]*\bedition)\)|\s+\b(?:paperback|hardcover|hb)\b\.?$/gi;
function cleanName(name) {
  return String(name || '').replace(/#\w+/g, ' ').split(/\s*\|/)[0].replace(FORMAT, '').replace(FORMAT, '')
    .replace(/\s+by\s+[^,()]+$/i, '').replace(/\s+/g, ' ').replace(/[\s.,:;–—-]+$/, '').trim();
}

/** A long catalogue title is cut at a word, not a reason to throw the list away. */
function shortName(name) {
  const t = cleanName(name);
  if (t.length <= 90) return t;
  const cut = t.slice(0, 88);
  return `${cut.slice(0, cut.lastIndexOf(' ') > 40 ? cut.lastIndexOf(' ') : 88).replace(/[\s,:;–—-]+$/, '')}…`;
}

function validateWritten(out, candidates, { slug, topic, maxPrice }) {
  const errors = [];
  const byId = new Map(candidates.map((c, i) => [`c${i + 1}`, c]));
  const list = {
    slug, topic,
    title: checkText('title', out.title, 25, 80, errors),
    h1: checkText('h1', out.h1, 10, 70, errors),
    description: checkText('description', out.description, 90, 200, errors),
    intro: checkText('intro', out.intro, 120, 600, errors),
    maxPrice: maxPrice || undefined,
    picks: [], body: [], faq: [],
  };
  const seen = new Set();
  // Two listings of one book ("The Power of Habit" / "Power of Habit") count once.
  const titleKey = (t) => norm(cleanTitle(t) || t).replace(/^(the|a|an) /, '');
  for (const p of Array.isArray(out.picks) ? out.picks : []) {
    const c = byId.get(String(p && p.id || ''));
    if (!c) { errors.push(`pick ${p && p.id} is not a candidate`); continue; }
    const tk = titleKey(cleanName(c.title)).replace(/(?: \d+)+$/, '');   // "… 2.0", "… 20"
    // Same book, other edition: one key starts with the other ("A Short History
    // of Nearly Everything 2.0", "The Little Prince & Letter to a Hostage").
    const sameBook = [...seen].some((k) => k.startsWith('t:') && Math.min(k.length - 2, tk.length) >= 10
      && (k.slice(2).startsWith(tk) || tk.startsWith(k.slice(2))));
    if (seen.has(c.slug) || sameBook) continue;
    seen.add(c.slug); seen.add(`t:${tk}`);
    list.picks.push({
      slug: c.slug,
      name: checkText(`name of ${p.id}`, shortName(p.name || cleanTitle(c.title) || c.title), 1, 90, errors),
      by: personName(p.by),
      note: checkText(`note for ${p.id}`, p.note, 50, 320, errors),
      ...(p.group ? { group: checkText(`group of ${p.id}`, p.group, 2, 50, errors) } : {}),
    });
  }
  if (list.picks.length < 10 || list.picks.length > 20) errors.push(`${list.picks.length} picks (want 10-20)`);
  for (const b of (Array.isArray(out.body) ? out.body : []).slice(0, 4)) {
    list.body.push({ heading: checkText('body heading', b && b.heading, 3, 80, errors), text: checkText('body text', b && b.text, 150, 900, errors) });
  }
  if (list.body.length < 2) errors.push('fewer than 2 body sections');
  for (const f of (Array.isArray(out.faq) ? out.faq : []).slice(0, 5)) {
    list.faq.push({ q: checkText('faq question', f && f.q, 10, 150, errors), a: checkText('faq answer', f && f.a, 20, 400, errors) });
  }
  if (list.faq.length < 2) errors.push('fewer than 2 FAQs');
  return errors.length ? { errors } : { list };
}

function slugFor(planSlug, topic, taken) {
  // The URL is the search: "Books like Ikigai" -> books-like-ikigai, not the
  // planner's padded "books-like-ikigai-mindfulness-purpose".
  let s = topicKey(topic).replace(/₹/g, '').trim().replace(/\s+/g, '-').slice(0, 80);
  if (!SLUG_RE.test(s) || s.length < 8) s = String(planSlug || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
  let out = s;
  for (let i = 2; taken.has(out); i += 1) out = `${s}-${i}`;
  return out;
}

/**
 * Make one list. deps: { supabase, priceBooks(slugs) -> { slug: {price,...} },
 * ai(messages) -> json, bestsellerTitles }. Returns { ok, list?, error?, topic? }.
 */
async function generateOne({ topic: asked, trigger = 'manual' } = {}, deps) {
  const doc = await readDoc();
  const next = asked ? { topic: String(asked).trim().slice(0, 120), source: 'owner' } : nextTopic(doc, deps);
  const run = { at: new Date().toISOString(), trigger, topic: next && next.topic, model: MODEL() };
  const finish = async (result) => {
    const fresh = await readDoc();   // re-read: another run or an admin action may have saved meanwhile
    fresh.last_run = { ...run, ...result, finished_at: new Date().toISOString() };
    if (next && result.markDone) {
      fresh.topics.done = [...new Set([...fresh.topics.done, next.topic])].slice(-500);
      fresh.topics.queued = fresh.topics.queued.filter((q) => topicKey(typeof q === 'string' ? q : q.topic) !== topicKey(next.topic));
    }
    if (result.list) fresh.lists.push(result.list);
    delete fresh.last_run.list;
    delete fresh.last_run.markDone;
    await writeDoc(fresh);
    return { ok: !!result.list, ...result };
  };
  if (!next) return finish({ error: 'No topics left. Add one in admin.' });

  const ai = deps.ai || ((m) => openaiJson(m));
  let plan;
  try {
    plan = await ai([{ role: 'system', content: PLAN_PROMPT }, { role: 'user', content: `Topic: ${next.topic}` }]);
  } catch (err) { return finish({ error: `plan: ${err.message}` }); }
  const queries = (Array.isArray(plan.queries) ? plan.queries : []).map(String).filter(Boolean);
  const maxPrice = Number(plan.max_price) > 0 ? Math.round(Number(plan.max_price)) : 0;
  if (queries.length < 5) return finish({ error: 'plan had too few searches' });

  const subject = likeSubject(next.topic);
  const found = await searchCandidates(queries, deps.supabase);
  const prices = found.length ? await deps.priceBooks(found.map((b) => b.slug.toLowerCase())) : {};
  const candidates = found
    .map((b) => ({ ...b, price: prices[b.slug.toLowerCase()] && prices[b.slug.toLowerCase()].price }))
    .filter((b) => Number(b.price) > 0 && (!maxPrice || b.price <= maxPrice))
    .filter((b) => !subject || !(` ${norm(b.title)} `).includes(` ${subject} `))
    .slice(0, 70);
  if (candidates.length < 12) {
    return finish({ error: `only ${candidates.length} in-stock books match "${next.topic}"`, candidates: candidates.length, markDone: !asked });
  }

  const taken = new Set([...LISTS.map((l) => l.slug), ...doc.lists.map((l) => l.slug)]);
  const slug = slugFor(plan.slug, next.topic, taken);
  const payload = candidates.map((c, i) => ({ id: `c${i + 1}`, title: c.title, author: c.author, price: c.price, description: c.description }));
  const messages = [
    { role: 'system', content: WRITE_PROMPT },
    { role: 'user', content: JSON.stringify({ topic: next.topic, budget_rupees: maxPrice || null, candidates: payload }) },
  ];
  let checked;
  // One retry: the writer sees what failed and fixes it.
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    let written;
    try { written = await ai(messages); } catch (err) { return finish({ error: `write: ${err.message}`, candidates: candidates.length }); }
    checked = validateWritten(written, candidates, { slug, topic: next.topic, maxPrice });
    if (!checked.errors) break;
    messages.push({ role: 'assistant', content: JSON.stringify(written) },
      { role: 'user', content: `Fix these problems and return the whole JSON again: ${checked.errors.slice(0, 12).join('; ')}` });
  }
  if (checked.errors) return finish({ error: `checks failed: ${checked.errors.slice(0, 6).join('; ')}`, candidates: candidates.length });

  const status = doc.settings.auto_publish ? 'published' : 'draft';
  const list = {
    ...checked.list, status, source: next.source, model: MODEL(), created_at: run.at,
    ...(status === 'published' ? { published_at: run.at } : {}),
    preview_token: crypto.randomBytes(12).toString('hex'),
  };
  return finish({ list, slug, status, picks: list.picks.length, candidates: candidates.length, markDone: true });
}

/** Owner actions from admin. Returns the updated doc. */
async function applyAction(action, body = {}) {
  const doc = await readDoc();
  const find = () => doc.lists.find((l) => l.slug === String(body.slug || ''));
  const now = new Date().toISOString();
  if (action === 'publish' || action === 'unpublish' || action === 'reject') {
    const l = find();
    if (!l) throw new Error('No such list');
    l.status = action === 'publish' ? 'published' : action === 'unpublish' ? 'draft' : 'rejected';
    if (action === 'publish') l.published_at = now;
  } else if (action === 'delete') {
    doc.lists = doc.lists.filter((l) => l.slug !== String(body.slug || ''));
  } else if (action === 'queue') {
    const t = String(body.topic || '').trim().slice(0, 120);
    if (t.length < 4) throw new Error('Topic is too short');
    doc.topics.queued = [...doc.topics.queued.filter((q) => topicKey(typeof q === 'string' ? q : q.topic) !== topicKey(t)), { topic: t, added_at: now }];
    doc.topics.done = doc.topics.done.filter((d) => topicKey(d) !== topicKey(t));
  } else if (action === 'unqueue') {
    doc.topics.queued = doc.topics.queued.filter((q) => topicKey(typeof q === 'string' ? q : q.topic) !== topicKey(body.topic));
  } else if (action === 'settings') {
    if (typeof body.enabled === 'boolean') doc.settings.enabled = body.enabled;
    if (typeof body.auto_publish === 'boolean') doc.settings.auto_publish = body.auto_publish;
    if (Number(body.every_days) >= 1 && Number(body.every_days) <= 30) doc.settings.every_days = Math.round(Number(body.every_days));
  } else if (action === 'edit') {
    const l = find();
    if (!l) throw new Error('No such list');
    const i = Number(body.pick);
    if (Number.isInteger(i) && l.picks[i] && typeof body.note === 'string') l.picks[i].note = body.note.trim().slice(0, 320);
    else if (Number.isInteger(i) && l.picks[i] && typeof body.by === 'string') l.picks[i].by = body.by.trim().slice(0, 80);
    else if (Number.isInteger(i) && l.picks[i] && body.remove === true) l.picks.splice(i, 1);
    for (const k of ['title', 'h1', 'description', 'intro']) if (typeof body[k] === 'string' && body[k].trim()) l[k] = body[k].trim().slice(0, 600);
  } else {
    throw new Error('Unknown action');
  }
  await writeDoc(doc);
  return doc;
}

/** Due for a scheduled run? Counts only successful runs. */
function isDue(doc, now = Date.now()) {
  if (!doc.settings.enabled) return false;
  const last = doc.lists.reduce((m, l) => Math.max(m, Date.parse(l.created_at) || 0), 0);
  return now - last >= doc.settings.every_days * 86_400_000 - 3_600_000;
}

module.exports = {
  likeSubject, personName, cleanName,
  readDoc, writeDoc, generateOne, applyAction, isDue, nextTopic, cleanTitle, searchCandidates,
  validateWritten, slugFor, openaiJson, SEED_TOPICS, DEFAULT_SETTINGS, KEY,
};
