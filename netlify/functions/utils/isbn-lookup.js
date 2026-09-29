'use strict';

/**
 * Find a book's ISBN for "Draft with AI".
 *
 * A language model on its own is the wrong tool for this: ISBNs are exactly
 * the kind of long, arbitrary number models recall wrongly while sounding sure,
 * and the ISBN becomes the product's GTIN in Merchant Center (utils/gtin.js) --
 * a wrong one files the listing under somebody else's book. So:
 *
 *   1. Book databases give the real ISBNs for this title (Open Library, keyless;
 *      Google Books when GOOGLE_BOOKS_API_KEY is set).
 *   2. The model, with web search, picks the edition this listing actually is
 *      (Indian paperback first) from those, or finds one on the web and cites
 *      where.
 *   3. decideIsbn() only lets an ISBN through to the form when it is checksum-
 *      valid AND a database lists it for this title. A web-only answer is shown
 *      to the admin with its source but never auto-filled.
 *
 * Every step fails soft: no network, no key, a slow API -- the copy draft still
 * comes back, with a note saying why no ISBN was found.
 */

const { isbnToGtin } = require('./gtin');

const UA = 'InkAndChai-admin/1.0 (+https://inkandchai.in)';
const MAX_CANDIDATES = 40;

const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/&/g, ' and ').replace(/[^a-z0-9ऀ-ॿ]+/g, ' ').trim();
const STOP = new Set(['the', 'a', 'an', 'of', 'and', 'by', 'in', 'on', 'to', 'for', 'with', 'edition', 'paperback', 'hardcover', 'book']);

/**
 * Catalogue titles often carry the author ("The Love Hypothesis by Ali
 * Hazelwood") and a subtitle; the databases want them apart.
 */
function splitTitleAuthor(title, author) {
  let t = String(title || '').replace(/\s+/g, ' ').trim();
  let a = String(author || '').replace(/\s+/g, ' ').trim();
  const by = t.match(/^(.*?)\s+by\s+([^:|()[\]]+?)\s*(?:[:|([].*)?$/i);
  if (by) { t = by[1]; if (!a) a = by[2]; }
  t = t.split(/\s*[:|([]\s*/)[0].trim() || t;
  return { title: t, author: a };
}

/** Every significant word of the wanted title appears in the candidate's title. */
function titleMatches(wanted, candidate) {
  const words = norm(wanted).split(' ').filter((w) => w && !STOP.has(w));
  const have = new Set(norm(candidate).split(' '));
  return words.length > 0 && words.every((w) => have.has(w));
}

async function getJson(url, ms, fetchImpl = fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetchImpl(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (e) {
    throw new Error(e.name === 'AbortError' ? 'timed out' : e.message);
  } finally {
    clearTimeout(timer);
  }
}

/** Open Library groups editions by work; each matching work lists its ISBNs. */
async function openLibraryCandidates({ title, author }, fetchImpl) {
  const q = new URLSearchParams({ title, limit: '5', fields: 'title,author_name,isbn,publisher,first_publish_year' });
  if (author) q.set('author', author);
  const data = await getJson(`https://openlibrary.org/search.json?${q}`, 12000, fetchImpl);
  const out = [];
  for (const d of data.docs || []) {
    if (!titleMatches(title, d.title)) continue;
    for (const raw of d.isbn || []) {
      const isbn = isbnToGtin(raw);
      if (isbn) out.push({ isbn, title: d.title, publisher: (d.publisher || []).slice(0, 3).join(' / '), source: 'Open Library' });
    }
  }
  return out;
}

/** Google Books is per edition: publisher, year and page count come with the ISBN. */
async function googleBooksCandidates({ title, author }, key, fetchImpl) {
  const q = `intitle:${title}${author ? ` inauthor:${author}` : ''}`;
  const url = `https://www.googleapis.com/books/v1/volumes?${new URLSearchParams({ q, maxResults: '10', country: 'IN', key })}`;
  const data = await getJson(url, 10000, fetchImpl);
  const out = [];
  for (const it of data.items || []) {
    const v = it.volumeInfo || {};
    if (!titleMatches(title, v.title)) continue;
    const ids = v.industryIdentifiers || [];
    const raw = (ids.find((i) => i.type === 'ISBN_13') || ids.find((i) => i.type === 'ISBN_10') || {}).identifier;
    const isbn = isbnToGtin(raw);
    if (isbn) {
      out.push({
        isbn, title: v.title, publisher: v.publisher || '', year: String(v.publishedDate || '').slice(0, 4),
        pages: v.pageCount || null, source: 'Google Books',
      });
    }
  }
  return out;
}

function dedupe(list) {
  const seen = new Map();
  for (const c of list) {
    const was = seen.get(c.isbn);
    if (!was) seen.set(c.isbn, c);
    else if (!was.year && c.year) seen.set(c.isbn, { ...c, source: `${was.source} + ${c.source}` });
  }
  return [...seen.values()];
}

/**
 * Ask the model (with web search) which edition this listing is. Returns
 * { isbn, publisher, source_url, reason } or throws.
 */
async function aiPickIsbn({ title, author, publisher, language, candidates }, env, fetchImpl = fetch) {
  const list = candidates.slice(0, MAX_CANDIDATES)
    .map((c) => `- ${c.isbn}${c.publisher ? ` | ${c.publisher}` : ''}${c.year ? ` | ${c.year}` : ''}${c.pages ? ` | ${c.pages} pp` : ''} (${c.source})`)
    .join('\n');
  const prompt = `Find the ISBN-13 of this book as sold by an Indian online bookstore.

Title: ${title}
Author: ${author || 'unknown'}
${publisher ? `Publisher on the listing: ${publisher}\n` : ''}${language ? `Language: ${language}\n` : ''}
${list ? `ISBNs that book databases list for this title:\n${list}\n\nPrefer one of these.` : 'No book database returned ISBNs for it.'}
Prefer the paperback edition sold in India (Indian publisher or India-market imprint); otherwise the most common paperback edition. Use web search to confirm.

Answer in exactly this format and nothing else:
ISBN13: <13 digits, or NONE if you are not certain>
PUBLISHER: <publisher of that edition, or blank>
SOURCE: <URL of the page that shows this ISBN, or blank>
REASON: <one short sentence>`;

  const model = env.OPENAI_ISBN_MODEL || 'gpt-4.1-mini';
  const call = async (tool) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 40000);
    try {
      const res = await fetchImpl('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
        // No temperature: reasoning models reject it, and the answer is a lookup.
        body: JSON.stringify({ model, tools: [{ type: tool }], input: prompt }),
        signal: controller.signal,
      });
      const data = await res.json().catch(() => ({}));
      return { ok: res.ok, status: res.status, data };
    } catch (e) {
      throw new Error(e.name === 'AbortError' ? 'web search timed out' : e.message);
    } finally {
      clearTimeout(timer);
    }
  };
  // The tool's name changed when it left preview; accept either.
  let r = await call('web_search');
  if (!r.ok && r.status === 400) r = await call('web_search_preview');
  if (!r.ok) throw new Error(`OpenAI ${r.status}: ${r.data?.error?.message || 'request failed'}`);
  return parseAiAnswer(responseText(r.data));
}

/** The Responses API's text, from the raw REST shape (output_text is SDK-only). */
function responseText(data) {
  if (data && typeof data.output_text === 'string') return data.output_text;
  const parts = [];
  for (const item of (data && data.output) || []) {
    for (const c of item.content || []) if (typeof c.text === 'string') parts.push(c.text);
  }
  return parts.join('\n');
}

function parseAiAnswer(text) {
  const line = (k) => {
    const m = String(text || '').match(new RegExp(`^\\s*\\**${k}\\**\\s*:\\s*(.*)$`, 'im'));
    return m ? m[1].replace(/\*+/g, '').trim() : '';
  };
  const url = (line('SOURCE').match(/https?:\/\/[^\s)>\]]+/) || [''])[0];
  return {
    isbn: isbnToGtin(line('ISBN13')),
    publisher: line('PUBLISHER').slice(0, 160),
    source_url: url,
    reason: line('REASON').slice(0, 300),
  };
}

/**
 * The one place that decides whether an ISBN reaches the form.
 *   verified    model's pick is on a database's list for this title -> fill
 *   database    model found nothing, one database edition only    -> fill
 *   unverified  model cites a web page no database confirms         -> show, do not fill
 *   none        nothing usable
 */
function decideIsbn({ candidates = [], ai = null }) {
  const byIsbn = new Map(candidates.map((c) => [c.isbn, c]));
  if (ai && ai.isbn && byIsbn.has(ai.isbn)) {
    const c = byIsbn.get(ai.isbn);
    return { isbn: ai.isbn, status: 'verified', fill: true, publisher: ai.publisher || c.publisher || '', source: c.source, source_url: ai.source_url || '', reason: ai.reason || '' };
  }
  if (ai && ai.isbn) {
    return { isbn: ai.isbn, status: 'unverified', fill: false, publisher: ai.publisher || '', source: 'web search', source_url: ai.source_url || '', reason: ai.reason || '' };
  }
  // Without the model's judgement, only an unambiguous single edition is safe.
  const editions = candidates.filter((c) => c.source.includes('Google Books'));
  if (editions.length === 1) {
    const c = editions[0];
    return { isbn: c.isbn, status: 'database', fill: true, publisher: c.publisher || '', source: c.source, source_url: '', reason: 'Only edition Google Books lists for this title.' };
  }
  return { isbn: '', status: 'none', fill: false, publisher: '', source: '', source_url: '', reason: '' };
}

/**
 * Whole lookup. Never throws; `notes` says what each source did so the admin
 * can tell "no ISBN exists" from "a source was down".
 */
async function findIsbn(input, env = process.env, fetchImpl = fetch) {
  const who = splitTitleAuthor(input.title, input.author);
  const notes = [];
  const lookups = [
    openLibraryCandidates(who, fetchImpl).then((c) => { notes.push(`Open Library: ${c.length} ISBN(s)`); return c; },
      (e) => { notes.push(`Open Library: ${e.message}`); return []; }),
  ];
  if (env.GOOGLE_BOOKS_API_KEY) {
    lookups.push(googleBooksCandidates(who, env.GOOGLE_BOOKS_API_KEY, fetchImpl).then((c) => { notes.push(`Google Books: ${c.length} edition(s)`); return c; },
      (e) => { notes.push(`Google Books: ${e.message}`); return []; }));
  }
  const candidates = dedupe((await Promise.all(lookups)).flat());

  let ai = null;
  if (env.OPENAI_API_KEY) {
    try { ai = await aiPickIsbn({ ...who, publisher: input.publisher, language: input.language, candidates }, env, fetchImpl); }
    catch (e) { notes.push(`AI search: ${e.message}`); }
  }
  return { ...decideIsbn({ candidates, ai }), candidates: candidates.length, notes };
}

module.exports = {
  findIsbn, decideIsbn, parseAiAnswer, responseText, splitTitleAuthor, titleMatches,
  openLibraryCandidates, googleBooksCandidates,
};
