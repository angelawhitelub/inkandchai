'use strict';

/**
 * Release dates for pre-order titles (owner, 26 Oct 2026).
 *
 * There is no separate field: the "Published" box in Other details already
 * holds the date, and a FULL date in the future ("27 October 2026",
 * "2026-10-27", "27/10/2026") is what makes a listing a pre-order. A month or
 * a year alone ("March 2024", "Reprint 2019") is a publication note, never a
 * release date — there is no day to promise dispatch on.
 *
 * Server side only parses the date into ISO; the page itself (public/js/
 * release-date.js) decides at view time whether it is still upcoming, so a
 * cached page stops saying "pre-order" on release day by itself.
 */

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july',
  'august', 'september', 'october', 'november', 'december'];
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DAY_MS = 86400000;

function iso(y, m, d) {
  const y4 = Number(y), m2 = Number(m), d2 = Number(d);
  if (!(y4 >= 2000 && y4 <= 2100) || !(m2 >= 1 && m2 <= 12) || !(d2 >= 1 && d2 <= 31)) return null;
  const dt = new Date(Date.UTC(y4, m2 - 1, d2));
  // 31 February rolls over silently; refuse it rather than print a wrong day.
  if (dt.getUTCMonth() !== m2 - 1 || dt.getUTCDate() !== d2) return null;
  return `${y4}-${String(m2).padStart(2, '0')}-${String(d2).padStart(2, '0')}`;
}

/** 1-12 for a month name or its abbreviation ("Oct", "Sept"), else 0. */
function month(name) {
  const w = String(name || '').toLowerCase();
  return w.length >= 3 ? MONTHS.findIndex((m) => m.startsWith(w)) + 1 : 0;
}

/** 'YYYY-MM-DD' when the text names one exact day, else null. */
function parseReleaseDate(value) {
  const s = String(value == null ? '' : value).trim().replace(/\s+/g, ' ').replace(/(\d)(st|nd|rd|th)\b/gi, '$1');
  if (!s) return null;
  let m;
  if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s))) return iso(m[1], m[2], m[3]);
  // Day first, the Indian way: 27/10/2026, 27-10-2026, 27.10.2026.
  if ((m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s))) return iso(m[3], m[2], m[1]);
  // 27 October 2026 · 27 Oct, 2026
  if ((m = /^(\d{1,2})[ -]([A-Za-z]+)\.?,? (\d{4})$/.exec(s)) && month(m[2])) return iso(m[3], month(m[2]), m[1]);
  // October 27, 2026 · Oct 27 2026
  if ((m = /^([A-Za-z]+)\.? (\d{1,2}),? (\d{4})$/.exec(s)) && month(m[1])) return iso(m[3], month(m[1]), m[2]);
  return null;
}

/** Whole IST day number (days since the epoch) for an ISO date or for now. */
const dayNumber = (isoDate) => Date.UTC(+isoDate.slice(0, 4), +isoDate.slice(5, 7) - 1, +isoDate.slice(8, 10)) / DAY_MS;
const todayIST = (now = Date.now()) => Math.floor((now + IST_OFFSET_MS) / DAY_MS);

/** True while the release day is still ahead (in IST). */
function isUpcoming(isoDate, now = Date.now()) {
  return !!isoDate && dayNumber(isoDate) > todayIST(now);
}

/** The ISO release date when `published_on` is an upcoming full date, else null. */
function upcomingRelease(publishedOn, now = Date.now()) {
  const d = parseReleaseDate(publishedOn);
  return d && isUpcoming(d, now) ? d : null;
}

/** Tags the Worker appends to a page with an upcoming release. */
function releaseScriptTags(isoDate) {
  return `<script>window.__iacRelease=${JSON.stringify(isoDate)};</script><script src="/js/release-date.js?v=20261026b"></script>`;
}

// ── Which books are pre-orders right now ────────────────────────────────────
// The date lives in custom_products.published_on (admin-added books) and in
// catalog_content.published_on (catalogue books the admin edited). Both are
// free text, so the database can only narrow by year; the parse decides.
const TABLES = ['custom_products', 'catalog_content'];
const quiet = (error) => /published_on|catalog_content|does not exist|schema cache/i.test(String(error && error.message));

function collect(out, rows, now) {
  for (const row of rows || []) {
    const iso = upcomingRelease(row && row.published_on, now);
    const slug = String((row && row.slug) || '').trim().toLowerCase();
    // Two rows for one slug: the later release is the one to wait for.
    if (iso && slug && (!out[slug] || out[slug] < iso)) out[slug] = iso;
  }
}

/** { slug: 'YYYY-MM-DD' } for the pre-orders among `slugs`. Never throws. */
async function releasesFor(db, slugs, now = Date.now()) {
  const list = [...new Set((slugs || []).map((s) => String(s || '').trim().toLowerCase()).filter(Boolean))];
  const out = {};
  if (!db || !list.length) return out;
  const filter = list.map((s) => `slug.ilike.${s}`).join(',');
  await Promise.all(TABLES.map(async (table) => {
    try {
      const { data, error } = await db.from(table).select('slug,published_on').or(filter);
      if (error) { if (!quiet(error)) console.error(`[release-date] ${table}:`, error.message); return; }
      collect(out, data, now);
    } catch (e) { console.error(`[release-date] ${table}:`, e.message); }
  }));
  return out;
}

/** Every pre-order in the shop: { slug: 'YYYY-MM-DD' }. */
async function allReleases(db, now = Date.now()) {
  const year = new Date(now + IST_OFFSET_MS).getUTCFullYear();
  const years = [year, year + 1, year + 2].map((y) => `published_on.ilike.%${y}%`).join(',');
  const out = {};
  for (const table of TABLES) {
    for (let from = 0; from < 20000; from += 1000) {
      const { data, error } = await db.from(table).select('slug,published_on').or(years).order('slug').range(from, from + 999);
      if (error) { if (quiet(error)) break; throw new Error(error.message); }
      collect(out, data, now);
      if (!data || data.length < 1000) break;
    }
  }
  return out;
}

module.exports = {
  parseReleaseDate, isUpcoming, upcomingRelease, releaseScriptTags, todayIST, dayNumber, releasesFor, allReleases,
};
