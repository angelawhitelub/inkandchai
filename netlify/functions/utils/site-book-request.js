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
 * Admin view: how many different customers asked for each book, so the most
 * wanted titles can be sourced first. rows: site_book_requests rows.
 */
function demandByTitle(rows) {
  const by = new Map();
  for (const r of rows || []) {
    const d = by.get(r.title_key) || { title_key: r.title_key, title: r.title, customers: 0, open: 0, last_at: r.created_at };
    d.customers += 1;
    if (r.status === 'new' || r.status === 'sourcing') d.open += 1;
    if (r.updated_at && r.updated_at > d.last_at) d.last_at = r.updated_at;
    by.set(r.title_key, d);
  }
  return [...by.values()].sort((a, b) => b.customers - a.customers || (b.last_at > a.last_at ? 1 : -1));
}

module.exports = { parseRequest, titleKey, demandByTitle, STATUSES, SOURCES };
