'use strict';

/**
 * ✨ Draft with AI may replace a wrong author -- but only on a book database's
 * word, not the model's.
 *
 * The model confidently "knows" authors, including for books it has never seen,
 * so its suggestion alone would turn right authors into wrong ones on lesser-
 * known titles. A typed author is replaced only when Open Library (or Google
 * Books, when a key is set) lists the suggested author for this exact title and
 * does not list the typed one. Otherwise the typed author stays and the admin is
 * told what the model suggested.
 *
 * Found by the owner: "The Witch" saved as Ruth Ware is Freida McFadden's book.
 */

const { stripPromo } = require('./listing-title');

const fold = (s) => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
const norm = (s) => fold(s).replace(/&/g, ' and ').replace(/[^a-z0-9ऀ-ॿ]+/g, ' ').trim();

/** "The Witch" from "The Witch: The haunting new thriller ... by X". */
function coreTitle(title) {
  let t = stripPromo(title).replace(/\s+by\s+[^:|()[\]]+$/i, '');
  t = t.split(/\s*[:|([]\s*/)[0];
  return norm(t);
}

/** Same person written differently: "PAINTER LYNN", "Lynn Painter", "Freida Mcfadden". */
function samePerson(a, b) {
  const toks = (s) => norm(s).split(' ').filter(Boolean).sort().join(' ');
  return !!toks(a) && toks(a) === toks(b);
}

const surname = (name) => norm(name).split(' ').filter((w) => w.length > 1).pop() || '';

/** Does a book database list `author` for a book titled `title`? true / false / null (no answer). */
async function databaseLists(title, author, { fetchImpl = fetch, googleKey } = {}) {
  const want = coreTitle(title);
  const sn = surname(author);
  if (!want || !sn) return null;
  const hit = (docTitle, names) => coreTitle(docTitle) === want && (names || []).some((n) => surname(n) === sn);
  const get = async (url) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const res = await fetchImpl(url, { headers: { Accept: 'application/json' }, signal: controller.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  };
  const core = String(title).split(/\s*[:|([]\s*/)[0].replace(/\s+by\s+.+$/i, '').trim();
  const checks = [
    get(`https://openlibrary.org/search.json?${new URLSearchParams({ title: core, author, fields: 'title,author_name', limit: '10' })}`)
      .then((d) => (d.docs || []).some((x) => hit(x.title, x.author_name))),
  ];
  if (googleKey) {
    checks.push(get(`https://www.googleapis.com/books/v1/volumes?${new URLSearchParams({ q: `intitle:"${core}" inauthor:"${author}"`, maxResults: '10', key: googleKey })}`)
      .then((d) => (d.items || []).some((i) => hit((i.volumeInfo || {}).title, (i.volumeInfo || {}).authors))));
  }
  const results = await Promise.allSettled(checks);
  const answered = results.filter((r) => r.status === 'fulfilled');
  if (!answered.length) return null;
  return answered.some((r) => r.value === true);
}

/**
 * The author the draft should carry.
 * @returns {{ author: string, status: 'same'|'filled'|'corrected'|'kept'|'unconfirmed', note: string }}
 */
async function checkAuthor({ title, given, suggested }, opts = {}) {
  const g = String(given || '').replace(/\s+/g, ' ').trim();
  const s = String(suggested || '').replace(/\s+/g, ' ').trim();
  if (!s || (g && samePerson(g, s))) return { author: s || g, status: 'same', note: '' };
  if (!g) return { author: s, status: 'filled', note: '' };

  const [suggestedOk, givenOk] = await Promise.all([
    databaseLists(title, s, opts).catch(() => null),
    databaseLists(title, g, opts).catch(() => null),
  ]);
  if (suggestedOk === true && givenOk !== true) {
    return { author: s, status: 'corrected', note: `Author corrected: "${g}" → "${s}" (a book database lists ${s} for this title).` };
  }
  if (givenOk === true) {
    return { author: g, status: 'kept', note: `The AI suggested "${s}" as author, but a book database lists ${g} for this title, so it was kept.` };
  }
  return { author: g, status: 'unconfirmed', note: `The AI thinks the author is "${s}", not "${g}". No book database confirms it, so it was not changed — check the cover.` };
}

module.exports = { checkAuthor, databaseLists, samePerson, coreTitle };
