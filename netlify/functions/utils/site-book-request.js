/**
 * "Request a book we don't have" — the form under the website search
 * (public/js/search-suggest.js), saved by site-book-request.js into
 * site_book_requests (sql/site_book_requests.sql).
 *
 * A request needs the book's title and a way to reach the customer: an Indian
 * mobile (WhatsApp) or an email. One row per customer per book; asking again
 * bumps request_count, so the admin sees demand without duplicates.
 */
'use strict';

const { isValidIndianMobile, isValidEmail, normalizeIndianPhone } = require('./spam-filter');

const STATUSES = ['new', 'sourcing', 'added', 'unavailable', 'closed'];
const SOURCES = ['overlay', 'books', 'product', 'home', 'other'];

const clean = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

/** Same book whatever the spelling of case, punctuation or spacing. */
const titleKey = (title) => String(title || '').normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** → { row } or { error } (a message fit to show the customer). */
function parseRequest(body = {}) {
  // Bots fill every field; people never see this one.
  if (clean(body.website, 200)) return { error: 'spam' };

  const title = clean(body.title, 200);
  if (titleKey(title).length < 2) return { error: 'Please enter the book’s title.' };

  const rawPhone = clean(body.phone, 20);
  const email = clean(body.email, 120).toLowerCase();
  const phone = rawPhone ? normalizeIndianPhone(rawPhone) : '';
  if (rawPhone && !isValidIndianMobile(rawPhone)) return { error: 'Please enter a valid 10-digit mobile number.' };
  if (email && !isValidEmail(email)) return { error: 'Please enter a valid email address.' };
  if (!phone && !email) return { error: 'Please add your WhatsApp number or email so we can tell you when we have it.' };

  let pageUrl = clean(body.page_url, 300);
  if (!/^\/[^\s]*$/.test(pageUrl)) pageUrl = '';

  return {
    row: {
      title,
      title_key: titleKey(title),
      author: clean(body.author, 120) || null,
      customer_name: clean(body.name, 80) || null,
      phone: phone || null,
      email: email || null,
      contact_key: phone ? `p:${phone}` : `e:${email}`,
      note: clean(body.note, 500) || null,
      search_query: clean(body.q, 120) || null,
      source: SOURCES.includes(body.source) ? body.source : 'other',
      page_url: pageUrl || null,
    },
  };
}

/**
 * Admin view: demand per book, so the most wanted titles are sourced first.
 * rows: site_book_requests rows (one per customer per book).
 *   requests  — every time anyone asked (a customer asking again counts again)
 *   customers — different customers who asked
 *   open      — of those, still new or sourcing
 * Most requests first, then most customers, then the latest asked.
 */
const asked = (r) => Math.max(1, parseInt(r && r.request_count, 10) || 1);
function demandByTitle(rows) {
  const by = new Map();
  for (const r of rows || []) {
    const key = r.title_key || titleKey(r.title);
    const d = by.get(key) || { title_key: key, title: r.title, author: r.author || '', requests: 0, customers: 0, open: 0, first_at: r.created_at, last_at: r.updated_at || r.created_at };
    d.requests += asked(r);
    d.customers += 1;
    if (r.status === 'new' || r.status === 'sourcing') d.open += 1;
    if (!d.author && r.author) d.author = r.author;
    if (r.created_at && r.created_at < d.first_at) d.first_at = r.created_at;
    const last = r.updated_at || r.created_at;
    if (last && last > d.last_at) d.last_at = last;
    by.set(key, d);
  }
  return [...by.values()].sort((a, b) => b.requests - a.requests || b.customers - a.customers
    || String(b.last_at || '').localeCompare(String(a.last_at || '')));
}

/** Requests ordered for print: most-requested book first, newest ask first within a book. */
function groupByBook(rows) {
  const demand = demandByTitle(rows);
  const byKey = new Map(demand.map((d) => [d.title_key, { ...d, rows: [] }]));
  for (const r of rows || []) byKey.get(r.title_key || titleKey(r.title)).rows.push(r);
  for (const b of byKey.values()) {
    b.rows.sort((x, y) => asked(y) - asked(x) || String(y.created_at || '').localeCompare(String(x.created_at || '')));
  }
  return demand.map((d) => byKey.get(d.title_key));
}

module.exports = { parseRequest, titleKey, demandByTitle, groupByBook, asked, STATUSES, SOURCES };
