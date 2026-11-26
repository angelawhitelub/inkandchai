'use strict';

/**
 * Title scout (owner, 26 Nov 2026): "find potential new book titles for me and
 * create listings for them". It widens the bestseller agent (utils/bestseller-
 * agent) from one source to four, and ranks the review queue by how likely a
 * book is to sell. It still only DRAFTS: the owner chose "review, but faster",
 * so nothing goes live without a tap in admin → 📈 Bestsellers.
 *
 * Sources, each stamped on the draft as `source`:
 *   amazon_bestseller   Amazon.in bestseller lists (the agent's own nightly run)
 *   amazon_new_release  Amazon.in "Hot New Releases" for the same genres
 *   customer_request    books customers asked for that we do not list
 *                       (website "Request a book" + WhatsApp order requests)
 *   author_followup     other books by authors who already sell well for us
 *
 * A request or an author is turned into an exact edition through Amazon.in's
 * own book search, which returns the Indian editions we can actually source
 * (Google Books' keyless quota is shared and was exhausted when tested).
 *
 * Score (0-100) = demand we have seen ourselves first, then the market:
 *   customers who asked     up to 45
 *   Amazon list rank        up to 30 (new releases count 70%)
 *   nights on the lists     up to 10 (one point per 3 nights), more lists up to 6
 *   the author sells here   up to 16
 *   not ready to approve    -10 no cover, -15 no M.R.P., -12 looks like a book we list
 * The reasons are stored with the score so the admin card can say why.
 */

const agent = require('./bestseller-agent');

const SOURCE_LABEL = {
  amazon_bestseller: 'Amazon bestseller',
  amazon_new_release: 'Amazon new release',
  customer_request: 'Customers asked',
  author_followup: 'Author sells here',
};

// How far a nightly scout run goes (each search or product page is one fetch).
const LIMITS = { requests: 15, authors: 3, perAuthor: 3, drafts: 20 };
const REQUEST_DAYS = 120;      // WhatsApp requests older than this are stale
const RETRY_DAYS = 14;         // an unmatched request or a scouted author waits this long
const STATE_KEY = 'title-scout-state';
const DIGEST_KEY = 'title-scout-digest';
const READY_SCORE = 40;        // the admin's "select ready" default

const MY_SEARCH = (q) => `https://www.amazon.in/s?k=${encodeURIComponent(q)}&i=stripbooks`;

// ── Amazon search page ─────────────────────────────────────────────────────

const PRINT = /^(paperback|hardcover|mass market paperback|board book|flexibound|spiral-bound)$/i;

/** Organic and sponsored results on an Amazon.in search page, in page order. */
function parseSearchPage(html) {
  const s = String(html || '');
  const starts = [...s.matchAll(/<div[^>]+data-asin="([A-Z0-9]{10})"[^>]*data-component-type="s-search-result"/g)];
  return starts.map((m, i) => {
    const seg = s.slice(m.index, i + 1 < starts.length ? starts[i + 1].index : m.index + 20000);
    const h2 = seg.match(/<h2[^>]*aria-label="([^"]+)"/) || seg.match(/<h2[^>]*>\s*(?:<a[^>]*>\s*)?<span[^>]*>([\s\S]*?)<\/span>/);
    const by = seg.match(/>by <\/span>([\s\S]{0,900}?)<\/div>/);
    const author = by ? agent.text(by[1]).split(/\s\|\s/)[0].replace(/\s*,\s*$/, '').trim() || null : null;
    const format = (seg.match(/>\s*(Paperback|Hardcover|Kindle Edition|Mass Market Paperback|Board book|Flexibound|Spiral-bound|Audible Audiobook|Audio CD)\s*</) || [])[1] || null;
    return {
      asin: m[1],
      title: h2 ? agent.text(h2[1]) : null,
      author,
      format,
      sponsored: /puis-sponsored|AdHolder|sp-sponsored-result|>Sponsored</.test(seg.slice(0, 6000)),
      position: i + 1,
    };
  });
}

/** Share of the wanted title's words that appear in the found title (0-1). */
function titleRecall(wanted, found) {
  const want = new Set(agent.tokens(agent.coreTitle(wanted)));
  if (!want.size) return 0;
  const got = new Set(agent.tokens(agent.coreTitle(found)));
  let common = 0;
  for (const t of want) if (got.has(t)) common += 1;
  return common / want.size;
}

const normName = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-zऀ-ॿ ]+/g, ' ').replace(/\s+/g, ' ').trim();

/** The first author's name, normalised ("Colleen Hoover, X" → "colleen hoover"). */
const firstAuthor = (a) => normName(String(a || '').split(/,|&| and /i)[0]);

/**
 * The search result that is the book asked for: organic, print, the title's
 * words present, and the author's surname when the customer gave one (always
 * for a one- or two-word title, which collides across authors).
 */
function pickSearchHit(results, { title, author }) {
  const sn = agent.surname(author);
  const short = agent.tokens(agent.coreTitle(title)).length <= 2;
  for (const r of results || []) {
    if (r.sponsored || !r.title) continue;
    if (r.format && !PRINT.test(r.format)) continue;
    if (titleRecall(title, r.title) < 0.8) continue;
    if (sn && !normName(r.author).includes(sn)) continue;
    if (short && !sn) continue;
    return r;
  }
  return null;
}

/** Results that are other print books by this author. */
function authorHits(results, author) {
  const want = firstAuthor(author);
  if (!want) return [];
  return (results || []).filter((r) => !r.sponsored && r.title && (!r.format || PRINT.test(r.format))
    && firstAuthor(r.author) === want);
}

// ── what customers asked for ───────────────────────────────────────────────

/** "Can't Hurt Me (Hindi) by David Goggins" → { title, author }. */
function parseTitleAuthor(line) {
  const s = String(line || '').replace(/\s+/g, ' ').trim();
  const m = s.match(/^(.*\S)\s+by\s+(\S.*)$/i);
  return m ? { title: m[1].trim(), author: m[2].split(/\s[|–—]\s|:/)[0].trim() } : { title: s, author: '' };
}

/** A WhatsApp request's free-text books field → one entry per book. */
function splitBooks(text) {
  return String(text || '')
    // Not on " | " or " + ": both occur inside real titles ("Vol 1 + Vol 2 | An Insider's Guide").
    .split(/\r?\n|;|(?:^|\s)\d{1,2}[.)]\s+/)
    .map((x) => x.replace(/^[\s,•*-]+|[\s,]+$/g, '').replace(/^\d{1,2}[.)]\s+/, ''))
    .filter((x) => x.length >= 3 && /[a-zA-Zऀ-ॿ]{3}/.test(x))
    .map(parseTitleAuthor);
}

const keyOf = (title) => agent.tokens(agent.coreTitle(title)).join(' ');

/**
 * Open demand by book: website requests not yet closed, and WhatsApp order
 * requests from the last REQUEST_DAYS. Customers are counted once per book.
 * → [{ key, title, author, customers, requests, sources: [], last_at }]
 */
async function requestDemand(supabase, { now = Date.now(), days = REQUEST_DAYS } = {}) {
  const by = new Map();
  const add = (title, author, who, n, source, at) => {
    const key = keyOf(title);
    if (!key) return;
    const d = by.get(key) || { key, title, author: author || '', who: new Set(), requests: 0, sources: new Set(), last_at: at || null };
    if (!d.author && author) d.author = author;
    d.who.add(who || `${source}:${d.who.size}`);
    d.requests += Math.max(1, Number(n) || 1);
    d.sources.add(source);
    if (at && (!d.last_at || at > d.last_at)) d.last_at = at;
    by.set(key, d);
  };

  const { data: site, error: siteErr } = await supabase.from('site_book_requests')
    .select('title, author, contact_key, phone, email, request_count, status, created_at, updated_at')
    .in('status', ['new', 'sourcing']).limit(2000);
  if (siteErr) console.warn('[title-scout] site_book_requests:', siteErr.message);
  for (const r of site || []) {
    // Customers type "Belonging ... By Sonia Gandhi" into the title box too.
    const t = parseTitleAuthor(r.title);
    add(t.title, r.author || t.author, r.contact_key || r.phone || r.email, r.request_count, 'website', r.updated_at || r.created_at);
  }

  const since = new Date(now - days * 86400e3).toISOString();
  const { data: wa, error: waErr } = await supabase.from('bot_order_requests')
    .select('books, customer_phone, created_at').gte('created_at', since).limit(3000);
  if (waErr) console.warn('[title-scout] bot_order_requests:', waErr.message);
  for (const r of wa || []) {
    for (const b of splitBooks(r.books)) add(b.title, b.author, r.customer_phone, 1, 'whatsapp', r.created_at);
  }

  return [...by.values()]
    .map((d) => ({ key: d.key, title: d.title, author: d.author, customers: d.who.size, requests: d.requests, sources: [...d.sources], last_at: d.last_at }))
    .sort((a, b) => b.customers - a.customers || b.requests - a.requests || String(b.last_at || '').localeCompare(String(a.last_at || '')));
}

/** The requests that are about this book (same title words, and the author when both name one). */
function demandFor(book, demand) {
  const key = keyOf(book.title || book.amazon_title);
  if (!key) return null;
  const sn = agent.surname(book.author);
  const hits = (demand || []).filter((d) => {
    if (d.key !== key && titleRecall(d.title, book.amazon_title || book.title) < 0.85) return false;
    const dsn = agent.surname(d.author);
    return !dsn || !sn || dsn === sn;
  });
  if (!hits.length) return null;
  return {
    customers: hits.reduce((n, d) => n + d.customers, 0),
    requests: hits.reduce((n, d) => n + d.requests, 0),
    sources: [...new Set(hits.flatMap((d) => d.sources))],
    asked_as: hits.slice(0, 3).map((d) => d.title),
    last_at: hits.map((d) => d.last_at).filter(Boolean).sort().pop() || null,
  };
}

// ── authors who sell for us ────────────────────────────────────────────────

/**
 * Lifetime units by first author, from the hourly lifetime-sales document
 * (doc.counts by slug) and the authors we know for those slugs: admin-created
 * books (custom_products) and the ranked cards (doc.bsr.info).
 */
function authorUnits(doc, catalogue) {
  const authorBySlug = new Map();
  for (const e of catalogue || []) if (e.slug && e.author) authorBySlug.set(String(e.slug).toLowerCase(), e.author);
  for (const [slug, info] of Object.entries((doc && doc.bsr && doc.bsr.info) || {})) {
    if (info && info.author && !authorBySlug.has(slug)) authorBySlug.set(slug, info.author);
  }
  const units = new Map();
  for (const [slug, n] of Object.entries((doc && doc.counts) || {})) {
    const a = firstAuthor(authorBySlug.get(String(slug).toLowerCase()));
    if (!a || a.length < 4 || /^(various|unknown|anonymous|na|n a)$/.test(a)) continue;
    units.set(a, (units.get(a) || 0) + (Number(n) || 0));
  }
  return units;
}

// ── score ──────────────────────────────────────────────────────────────────

function scoreCandidate(c, { demand = null, units = new Map() } = {}) {
  const reasons = [];
  let score = 0;

  const d = demand || c.demand;
  if (d && d.customers > 0) {
    const pts = Math.min(45, 25 + 10 * (d.customers - 1));
    score += pts;
    reasons.push(`${d.customers} customer${d.customers === 1 ? '' : 's'} asked (${(d.sources || []).join(' + ') || 'requests'})`);
  }

  const rank = Number(c.best_rank);
  if (rank > 0 && c.source !== 'customer_request' && c.source !== 'author_followup') {
    const weight = c.source === 'amazon_new_release' ? 0.7 : 1;
    score += Math.round(30 * weight * Math.max(0, 1 - (rank - 1) / 100));
    reasons.push(`#${rank} on Amazon ${c.source === 'amazon_new_release' ? 'new releases' : 'bestsellers'}${c.source_list ? ` (${c.source_list})` : ''}`);
  }
  const lists = Array.isArray(c.lists) ? c.lists.length : 0;
  if (lists > 1) { score += Math.min(6, 2 * (lists - 1)); reasons.push(`on ${lists} lists`); }
  const nights = Number(c.times_seen) || 0;
  if (nights > 1 && c.source !== 'customer_request') { score += Math.min(10, Math.round((nights - 1) / 3)); reasons.push(`${nights} nights on the lists`); }

  const sold = units.get(firstAuthor(c.author)) || 0;
  if (sold > 0) {
    score += Math.min(16, Math.round(4 * Math.log2(1 + sold)));
    reasons.push(`author has sold ${sold} here`);
  }

  if (!c.image_url) { score -= 10; reasons.push('no cover yet'); }
  if (!(Number(c.mrp_inr) > 0) || !(Number(c.price_inr) > 0)) { score -= 15; reasons.push('no M.R.P./price yet'); }
  if (c.possible_duplicate) { score -= 12; reasons.push('looks like a book we list'); }

  return { score: Math.max(0, Math.min(100, score)), reasons };
}

/** Ready for a one-tap approve: priced, has a cover, and not a possible duplicate. */
const isReady = (c) => !!c.image_url && Number(c.price_inr) > 0 && Number(c.mrp_inr) > 0 && !c.possible_duplicate;

/**
 * Re-score every pending draft against today's requests and sales.
 * Writes only rows whose score or reasons changed.
 */
async function rescorePending(supabase, { demand = [], units = new Map(), now = new Date(), catalogue = null } = {}) {
  const rows = [];
  for (let from = 0; from < 5000; from += 1000) {
    const { data, error } = await supabase.from('bestseller_candidates').select('*')
      .eq('status', 'pending').order('id').range(from, from + 999);
    if (error) throw new Error(`bestseller_candidates: ${error.message}`);
    rows.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  // Before sql/bestseller_candidates_scout.sql there is nowhere to keep a score;
  // the duplicate sweep below still runs.
  const canScore = !rows.length || 'score' in rows[0];
  const at = now.toISOString();

  // The catalogue moves on after a draft is made (books get listed by hand): a
  // draft that is now listed leaves the queue, one that resembles a listing is
  // flagged, so "Select ready" can never approve a duplicate.
  const index = catalogue ? agent.buildCatalogueIndex(catalogue) : null;
  const patches = [];
  let nowListed = 0;
  const scored = [];
  for (const c of rows) {
    const patch = {};
    if (index) {
      const hit = agent.matchCatalogue(index, { title: c.amazon_title || c.title, author: c.author, isbn13: c.isbn13 });
      if (hit.kind === 'exact') {
        patches.push({ c, patch: { status: 'in_catalogue', status_reason: `Listed since this draft was made: ${hit.match.title}`, updated_at: at } });
        nowListed += 1;
        continue;
      }
      if (hit.kind === 'near' && !c.possible_duplicate) {
        c.possible_duplicate = patch.possible_duplicate = { title: hit.match.title, slug: hit.match.slug, source: hit.match.source };
      }
    }
    if (canScore) {
      const d = demandFor(c, demand);
      const { score, reasons } = scoreCandidate(c, { demand: d, units });
      const dem = d || c.demand || null;
      scored.push({ ...c, score, score_reasons: reasons, demand: dem });
      const same = c.score === score && JSON.stringify(c.score_reasons || []) === JSON.stringify(reasons)
        && JSON.stringify(c.demand || null) === JSON.stringify(dem);
      if (!same) Object.assign(patch, { score, score_reasons: reasons, demand: dem, scored_at: at });
    }
    if (Object.keys(patch).length) patches.push({ c, patch });
  }
  const written = await writePatches(supabase, patches);
  scored.sort((a, b) => b.score - a.score);
  return {
    pending: rows.length - nowListed, changed: written, now_listed: nowListed, top: scored.slice(0, 10),
    skipped: canScore ? undefined : 'not scored: run sql/bestseller_candidates_scout.sql',
  };
}

/**
 * Write many row patches in a few requests: an upsert on id of 200 rows at a
 * time (a Worker run may make only 1000 subrequests, and the first re-score
 * touches every pending draft). asin and title ride along because they are
 * NOT NULL. Falls back to one update per row if the batch is refused.
 */
async function writePatches(supabase, patches) {
  // One batch per patch shape: in a bulk upsert supabase-js sends the union of
  // the rows' keys and a key missing from a row is written as NULL, which would
  // wipe a score or a duplicate flag that patch never meant to touch.
  const groups = new Map();
  for (const p of patches) {
    const shape = Object.keys(p.patch).sort().join(',');
    if (!groups.has(shape)) groups.set(shape, []);
    groups.get(shape).push(p);
  }
  let written = 0;
  for (const group of groups.values()) written += await writeGroup(supabase, group);
  return written;
}

async function writeGroup(supabase, patches) {
  let written = 0;
  for (let i = 0; i < patches.length; i += 200) {
    const chunk = patches.slice(i, i + 200);
    const rows = chunk.map(({ c, patch }) => ({ id: c.id, asin: c.asin, title: c.title, ...patch }));
    const { error } = await supabase.from('bestseller_candidates').upsert(rows, { onConflict: 'id' });
    if (!error) { written += chunk.length; continue; }
    console.warn('[title-scout] batch write refused, writing one by one:', error.message);
    for (const { c, patch } of chunk) {
      const res = await supabase.from('bestseller_candidates').update(patch).eq('id', c.id);
      if (!res.error) written += 1;
    }
  }
  return written;
}

// ── finding books ──────────────────────────────────────────────────────────

async function searchAmazon(q, { fetchImpl } = {}) {
  const { status, body } = await agent.fetchText(MY_SEARCH(q), { fetchImpl });
  // 503/429 is Amazon pushing back: stop for the night rather than keep asking.
  if (status === 503 || status === 429) throw new Error(`blocked by Amazon (HTTP ${status})`);
  if (status !== 200) throw new Error(`search HTTP ${status}`);
  if (/captcha|Robot Check/i.test(body.slice(0, 20000))) throw new Error('blocked by Amazon');
  return parseSearchPage(body);
}

const REQUEST_LIST = { id: 'requests', name: 'Customer requests', category: 'Books' };

/**
 * Do we list the book a customer asked for? 'listed' (active), 'switched_off'
 * (we have a listing but it is off), or null. Beyond the agent's own match, a
 * listing whose title holds EVERY word of the request counts ("System Design
 * Interview" → "System Design Interview Vol 1 + Vol 2 – …"), with the surname
 * checked when both sides name an author.
 */
function listedAs(index, d) {
  const hit = agent.matchCatalogue(index, { title: d.title, author: d.author });
  if (hit.kind === 'exact') return { state: 'listed', title: hit.match.title };
  const want = agent.tokens(agent.coreTitle(d.title));
  if (!want.length) return null;
  const sn = agent.surname(d.author);
  // Every word of each listing's full title, worked out once per catalogue.
  if (!index.words) index.words = index.list.map((e) => new Set(agent.tokens(titleWords(e.title))));
  // A preloved copy is weak too, but it is not "switched off": a new copy may still be drafted.
  let off = hit.kind === 'near' && hit.match.inactive && hit.match.key === want.join(' ') ? hit.match : null;
  index.list.forEach((e, i) => {
    if (off && off.listed) return;
    if (want.length < 2 && e.key !== want.join(' ')) return;
    if (!want.every((t) => index.words[i].has(t))) return;
    if (sn && e.author && agent.surname(e.author) !== sn && !e.lower.includes(sn)) return;
    if (!e.weak) off = { ...e, listed: true };
    else if (e.inactive && !off) off = e;
  });
  if (off && off.listed) return { state: 'listed', title: off.title };
  return off ? { state: 'switched_off', title: off.title } : null;
}

const titleWords = (t) => String(t || '').toLowerCase().replace(/[’']/g, '').replace(/&/g, ' and ')
  .replace(/[^a-z0-9ऀ-ॿ]+/g, ' ').trim();
const AUTHOR_LIST = { id: 'authors', name: 'Authors who sell here', category: 'Books' };

/**
 * Seeds for runAgent: an exact edition for each open request we do not list,
 * and a few new books by authors who sell here. Remembers what it tried in KV
 * (STATE_KEY) so the same request or author is not searched every night.
 */
async function findSeeds({ supabase, catalogue, demand, units, store, fetchImpl = fetch, now = Date.now(), limits = LIMITS, pauseMs = 700, log = () => {} }) {
  const state = (await store.get(STATE_KEY, { type: 'json' }).catch(() => null)) || { requests: {}, authors: {} };
  state.requests = state.requests || {};
  state.authors = state.authors || {};
  const fresh = (at) => at && now - Date.parse(at) < RETRY_DAYS * 86400e3;
  const index = agent.buildCatalogueIndex(catalogue);
  const seeds = [];
  const out = { searched: 0, matched: 0, unmatched: 0, listed: 0, switched_off: [], authors: [], errors: [] };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // 1. Customer requests, most-asked first.
  for (const d of demand) {
    if (out.searched >= limits.requests) break;
    if (fresh(state.requests[d.key])) continue;
    const have = listedAs(index, d);
    if (have && have.state === 'listed') { out.listed += 1; continue; }
    if (have && have.state === 'switched_off') {
      // Not drafted again: we have a listing, it is switched off. The owner is told instead.
      const same = out.switched_off.find((x) => x.listing === have.title);
      if (same) same.customers += d.customers;
      else if (out.switched_off.length < 10) out.switched_off.push({ asked: d.title, customers: d.customers, listing: have.title });
      continue;
    }
    out.searched += 1;
    state.requests[d.key] = new Date(now).toISOString();
    try {
      const hit = pickSearchHit(await searchAmazon([d.title, d.author].filter(Boolean).join(' '), { fetchImpl }), d);
      if (!hit) { out.unmatched += 1; log(`no edition for "${d.title}"`); }
      else {
        out.matched += 1;
        seeds.push({
          asin: hit.asin, title: hit.title, author: hit.author, bestRank: null, list: REQUEST_LIST, lists: [], seed: true,
          source: 'customer_request',
          demand: { customers: d.customers, requests: d.requests, sources: d.sources, asked_as: [d.title], last_at: d.last_at },
        });
      }
    } catch (e) {
      out.errors.push(`request "${d.title}": ${e.message}`);
      delete state.requests[d.key];   // try again tomorrow
      if (/blocked/.test(e.message)) break;
    }
    await sleep(pauseMs);
  }

  // 2. Authors who sell here, best-selling first.
  const authors = [...units.entries()].filter(([, n]) => n >= 5).sort((a, b) => b[1] - a[1]);
  let scouted = 0;
  for (const [name, sold] of authors) {
    if (scouted >= limits.authors) break;
    if (fresh(state.authors[name])) continue;
    scouted += 1;
    state.authors[name] = new Date(now).toISOString();
    try {
      const hits = authorHits(await searchAmazon(name, { fetchImpl }), name)
        .filter((r) => agent.matchCatalogue(index, { title: r.title, author: r.author }).kind !== 'exact')
        .slice(0, limits.perAuthor);
      out.authors.push({ author: name, sold, new_titles: hits.length });
      for (const h of hits) {
        seeds.push({ asin: h.asin, title: h.title, author: h.author, bestRank: null, list: AUTHOR_LIST, lists: [], seed: true, source: 'author_followup', demand: null });
      }
    } catch (e) {
      out.errors.push(`author ${name}: ${e.message}`);
      delete state.authors[name];
      if (/blocked/.test(e.message)) break;
    }
    await sleep(pauseMs);
  }

  // Forget entries old enough to retry, so the document stays small.
  for (const bag of [state.requests, state.authors]) {
    for (const [k, at] of Object.entries(bag)) if (!fresh(at)) delete bag[k];
  }
  await store.setJSON(STATE_KEY, state).catch((e) => out.errors.push(`state: ${e.message}`));
  return { seeds, ...out };
}

// ── the owner's daily email ────────────────────────────────────────────────

function digestHtml({ top, pending, drafted, adminUrl, switchedOff = [] }) {
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  const rows = top.map((c) => `<tr>
    <td style="padding:6px 8px;border-bottom:1px solid #eee;vertical-align:top;">${c.image_url ? `<img src="${esc(c.image_url)}" width="42" style="border-radius:3px">` : ''}</td>
    <td style="padding:6px 8px;border-bottom:1px solid #eee;vertical-align:top;"><strong>${esc(c.title)}</strong><br>
      <span style="color:#6b5a48;font-size:12px;">${esc(SOURCE_LABEL[c.source] || 'Amazon bestseller')} · ${esc((c.score_reasons || []).slice(0, 3).join(' · '))}</span></td>
    <td style="padding:6px 8px;border-bottom:1px solid #eee;vertical-align:top;white-space:nowrap;">${c.price_inr ? `₹${esc(c.price_inr)}` : '—'}${c.mrp_inr ? `<br><span style="color:#6b5a48;font-size:11px;">M.R.P. ₹${esc(c.mrp_inr)}</span>` : ''}</td>
    <td style="padding:6px 8px;border-bottom:1px solid #eee;vertical-align:top;font-weight:bold;">${esc(c.score)}${isReady(c) ? '' : '<br><span style="color:#b45309;font-size:11px;font-weight:normal;">needs a look</span>'}</td>
  </tr>`).join('');
  return `<div style="font-family:Arial,sans-serif;font-size:14px;color:#2b2118;max-width:640px;">
  <p><strong>${drafted} new book${drafted === 1 ? '' : 's'} drafted last night.</strong> ${pending} are waiting for review. The best ones:</p>
  <table style="border-collapse:collapse;width:100%;font-size:13px;">${rows}</table>
  ${switchedOff.length ? `<p style="margin-top:14px;"><strong>Asked for, but switched off on the site:</strong></p><ul style="margin-top:0;">${switchedOff.map((x) => `<li>${esc(x.listing)} — ${esc(x.customers)} customer${x.customers === 1 ? '' : 's'} asked</li>`).join('')}</ul>` : ''}
  <p><a href="${esc(adminUrl)}" style="display:inline-block;background:#2b2118;color:#fff;padding:9px 16px;border-radius:6px;text-decoration:none;">Review in admin → 📈 Bestsellers</a></p>
  <p style="color:#6b5a48;font-size:12px;">Nothing is listed until you approve it. "Select ready" there ticks every draft that has a cover and a price, at score ${READY_SCORE} or more.</p>
</div>`;
}

module.exports = {
  SOURCE_LABEL, LIMITS, STATE_KEY, DIGEST_KEY, READY_SCORE,
  parseSearchPage, titleRecall, pickSearchHit, authorHits, firstAuthor,
  parseTitleAuthor, splitBooks, keyOf, requestDemand, demandFor,
  authorUnits, scoreCandidate, isReady, rescorePending, findSeeds, searchAmazon, digestHtml, listedAs,
};
