'use strict';

/**
 * New-title alerts (owner, 26 Oct 2026): one book, sent by WhatsApp to the past
 * buyers most likely to want it -- people who bought the same author before,
 * or (when asked) the same kind of book.
 *
 * The owner chose ALL matching past buyers, not only those who ticked the
 * marketing box at checkout, so the regular broadcast's 100-message pilot cap
 * does not apply here. What protects the number instead:
 *   - the admin presses Send per book, after a dry run showing the count;
 *   - a per-send limit;
 *   - nobody gets the same book twice (ledger key new-title:<slug>);
 *   - a cooldown after ANY marketing message (default 7 days);
 *   - STOP / unsubscribed customers are always removed, and the send refuses
 *     to run at all if either list cannot be read.
 *
 * Pure matching lives here; admin-new-title-alert.js does the I/O.
 */

const CAMPAIGN_PREFIX = 'new-title:';

const normTitle = (t) => String(t == null ? '' : t).toLowerCase().replace(/[.'’]/g, '').replace(/[^a-z0-9ऀ-ॿ]+/g, ' ').trim();

const clean = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();

/** "Sarah J. Maas" and "sarah j maas" are the same writer. */
function normAuthor(name) {
  return clean(name).toLowerCase().replace(/[.'’]/g, '').replace(/[^a-z0-9ऀ-ॿ ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

const NOT_AN_AUTHOR = new Set(['', 'various', 'various authors', 'multiple authors', 'unknown', 'anonymous', 'ink & chai', 'ink and chai', 'na', 'n a']);

/** Every author named in an author field ("A & B", "A, B and C"). */
function authorsOf(name) {
  return clean(name).split(/\s*(?:&|,|\/|\band\b|\+)\s*/i)
    .map(normAuthor).filter((a) => a.length > 2 && !NOT_AN_AUTHOR.has(a));
}

/** Every shelf a raw category is on: romance, fantasy and thrillers are fiction too. */
function shelvesOf(rawCategory) {
  const c = clean(rawCategory).toLowerCase();
  const out = new Set();
  const main = shelfOf(c);
  if (main) out.add(main);
  if (['romance', 'fantasy', 'thrillers'].includes(main) || /fiction|novel|romance|fantasy|thriller|mystery/.test(c)) out.add('fiction');
  return out;
}

/** The broad shelf a raw category belongs to, or '' when there is none. */
function shelfOf(rawCategory) {
  const c = clean(rawCategory).toLowerCase();
  if (!c) return '';
  if (c.includes('hindi')) return 'Hindi books';
  if (/marathi|tamil|bengali|gujarati|telugu|kannada|malayalam|other lang/.test(c)) return 'books in Indian languages';
  if (c.includes('self')) return 'self-help';
  if (c.includes('romance')) return 'romance';
  if (c.includes('thriller') || c.includes('mystery')) return 'thrillers';
  if (c.includes('manga')) return 'manga';
  if (c.includes('comic')) return 'comics';
  if (c.includes('kids') || c.includes('child')) return 'children\'s books';
  if (c.includes('biograph') || c.includes('memoir')) return 'biographies';
  if (c.includes('business') || c.includes('finance')) return 'business books';
  if (c.includes('fantasy')) return 'fantasy';
  if (/fiction|novel/.test(c)) return 'fiction';
  return '';   // "New arrivals", "Preloved", "Boxsets"… not a taste
}

/** orders.cart_items is jsonb on newer rows and JSON text on older ones. */
function cartItemsOf(order) {
  const raw = order && order.cart_items;
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') { try { const p = JSON.parse(raw); return Array.isArray(p) ? p : []; } catch { return []; } }
  return [];
}

/** Series names / phrases a past title may contain ("Court of Thorns, Throne of Glass"). */
function keywordsOf(list) {
  const arr = Array.isArray(list) ? list : String(list || '').split(/[,\n]/);
  return [...new Set(arr.map(normTitle).filter((k) => k.length >= 4))].slice(0, 20);
}


/**
 * Who should hear about `book`.
 *
 * @param {Map<string,{name:string, orders:object[]}>} customers  phone → orders
 * @param {{slug, title, author, category}} book
 * @param {(item) => {author?:string, category?:string}} metaOf  fills gaps in a cart line
 * @param {{match?: 'author'|'author_or_category', keywords?: string|string[]}} opts
 *   keywords: series names a past title may contain; the author's own name
 *   always counts too, because most catalogue books have a blank author and
 *   carry it only in the title ("… Box Set by Sarah J. Maas").
 * @returns {{ recipients: {phone, name, reason, via}[], counts: object }}
 */
function matchCustomers(customers, book, metaOf, opts = {}) {
  const byCategory = opts.match === 'author_or_category';
  const wantAuthors = new Set(authorsOf(book.author));
  const keywords = keywordsOf([...authorsOf(book.author), ...keywordsOf(opts.keywords)]);
  // A fiction title reaches romance/fantasy/thriller readers too; a romance
  // title reaches romance readers only.
  const shelfLabel = shelfOf(book.category);
  const slug = clean(book.slug).toLowerCase();
  const title = normTitle(bareTitle(book.title, book.author));
  const displayAuthor = clean(book.author);
  const counts = { customers: customers.size, matched: 0, already_bought: 0, by_author: 0, by_title: 0, by_category: 0 };
  const recipients = [];

  for (const [phone, info] of customers) {
    let via = '', keyword = '', bought = false;
    for (const order of info.orders || []) {
      for (const item of cartItemsOf(order)) {
        if (!item) continue;
        const itemSlug = clean(String(item.url || item.id || '').match(/\/product\/([^/?#]+)/i)?.[1] || item.slug).toLowerCase();
        const itemTitle = normTitle(item.title || item.name);
        if ((slug && itemSlug === slug) || (title && (itemTitle === title || itemTitle.startsWith(title + ' by ')))) { bought = true; continue; }
        if (via === 'author') continue;
        const meta = { ...(metaOf ? metaOf(item) || {} : {}), ...(item.author ? { author: item.author } : {}) };
        if (wantAuthors.size && authorsOf(meta.author).some((a) => wantAuthors.has(a))) { via = 'author'; continue; }
        if (via === 'title') continue;
        const k = keywords.find((kw) => (' ' + itemTitle + ' ').includes(' ' + kw + ' '));
        if (k) { via = 'title'; keyword = k; continue; }
        if (!via && byCategory && shelfLabel && shelvesOf(meta.category || item.category).has(shelfLabel)) via = 'category';
      }
    }
    if (bought) { counts.already_bought++; continue; }
    if (!via) continue;
    counts.matched++;
    counts['by_' + via]++;
    const reason = via === 'category' ? (shelfLabel || 'books like this') : (displayAuthor || keyword);
    recipients.push({ phone, name: clean(info.name).split(' ')[0] || 'there', email: info.email || '', reason, via });
  }
  return { recipients, counts };
}

/**
 * Who ordered one of `targets` (the books the admin picked), and has not
 * bought `book` itself. reason = the picked book they ordered, so the message
 * reads "Since you ordered <that book>".
 * @param {{slug:string, title:string, author?:string}[]} targets
 */
function matchBuyersOf(customers, book, targets) {
  const slug = clean(book.slug).toLowerCase();
  const title = normTitle(bareTitle(book.title, book.author));
  const want = (targets || []).map((t) => ({
    slug: clean(t.slug).toLowerCase(),
    title: normTitle(bareTitle(t.title, t.author)),
    label: bareTitle(clean(t.title), t.author).slice(0, 80),
  })).filter((t) => t.slug || t.title);
  const counts = { customers: customers.size, matched: 0, already_bought: 0, by_book: 0 };
  const recipients = [];
  for (const [phone, info] of customers) {
    let hit = null, bought = false;
    for (const order of info.orders || []) {
      for (const item of cartItemsOf(order)) {
        if (!item) continue;
        const itemSlug = clean(String(item.url || item.id || '').match(/\/product\/([^/?#]+)/i)?.[1] || item.slug).toLowerCase();
        const itemTitle = normTitle(item.title || item.name);
        if ((slug && itemSlug === slug) || (title && (itemTitle === title || itemTitle.startsWith(title + ' by ')))) { bought = true; continue; }
        if (hit) continue;
        hit = want.find((t) => (t.slug && itemSlug === t.slug) || (t.title && (itemTitle === t.title || itemTitle.startsWith(t.title + ' by ')))) || null;
      }
    }
    if (bought) { counts.already_bought++; continue; }
    if (!hit) continue;
    counts.matched++;
    counts.by_book++;
    recipients.push({ phone, name: clean(info.name).split(' ')[0] || 'there', email: info.email || '', reason: hit.label, via: 'book' });
  }
  return { recipients, counts };
}

/** The new-title email: cover on top, "Exclusive" headline, why they got it, price, button. */
function emailHtml(recipient, book, { coverUrl = '', productUrl = '', unsubscribeUrl = '' } = {}) {
  const e = (v) => String(v == null ? '' : v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const [, why, title, priceLine] = templateParams(recipient, book);
  const author = clean(book.author);
  return `<div style="background:#f7f3ec;padding:24px 12px;font-family:Georgia,serif;color:#2b2118;">
  <div style="max-width:520px;margin:0 auto;background:#fff;border:1px solid #e6dccb;border-radius:14px;overflow:hidden;">
    ${coverUrl ? `<a href="${e(productUrl)}" style="display:block;background:#efe6d6;text-align:center;padding:24px 0;"><img src="${e(coverUrl)}" alt="${e(title)}" width="220" style="width:220px;max-width:70%;height:auto;border-radius:6px;box-shadow:0 6px 18px rgba(0,0,0,.18);"></a>` : ''}
    <div style="padding:24px 26px;">
      <div style="font:700 12px/1 Arial,sans-serif;letter-spacing:.18em;text-transform:uppercase;color:#b0412e;">Exclusive!</div>
      <h1 style="font-weight:400;font-size:24px;line-height:1.25;margin:10px 0 4px;">${e(title)}</h1>
      ${author ? `<div style="color:#6b5a48;font-size:15px;margin-bottom:14px;">by ${e(author)}</div>` : '<div style="margin-bottom:14px;"></div>'}
      <p style="font-size:16px;line-height:1.6;margin:0 0 12px;">Hi ${e(recipient.name || 'there')},</p>
      <p style="font-size:16px;line-height:1.6;margin:0 0 12px;">Since you ordered <b>${e(why)}</b>, we think you may like this one. It's now available at Ink &amp; Chai.</p>
      <p style="font-size:17px;margin:0 0 20px;"><b>${e(priceLine)}</b></p>
      <a href="${e(productUrl)}" style="display:inline-block;background:#2b2118;color:#fff;text-decoration:none;padding:12px 24px;border-radius:10px;font:600 15px Arial,sans-serif;">See the book</a>
    </div>
  </div>
  <p style="max-width:520px;margin:14px auto 0;font:12px/1.6 Arial,sans-serif;color:#8a7b6a;text-align:center;">
    You're getting this because you ordered from Ink &amp; Chai.${unsubscribeUrl ? ` <a href="${e(unsubscribeUrl)}" style="color:#8a7b6a;">Unsubscribe from new-book emails</a>.` : ''}
  </p>
</div>`;
}

/** Body parameters for the template: {{1}} name, {{2}} why, {{3}} title, {{4}} price line. */
function templateParams(recipient, book) {
  const price = Number(book.price) || 0;
  const mrp = Number(book.mrp) || 0;
  const off = mrp > price && price > 0 ? Math.round((mrp - price) * 100 / mrp) : 0;
  let line = price ? `₹${Math.round(price)}${off ? ` (${off}% off MRP)` : ''}` : 'now in stock';
  if (book.release) {
    const [y, m, d] = book.release.split('-').map(Number);
    const when = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(Date.UTC(y, m - 1, d)));
    line = `pre-order now at ${line} — releases ${when}`;
  }
  return [recipient.name, recipient.reason, bareTitle(book.title, book.author).slice(0, 120), line];
}

/** "Title by Author" → "Title": the message already names the author. */
function bareTitle(title, author) {
  const t = clean(title);
  const m = t.match(/^(.+?)\s+by\s+(.+)$/i);
  if (!m) return t;
  const named = authorsOf(m[2]);
  const want = new Set(authorsOf(author));
  return named.length && named.every((a) => want.has(a)) ? m[1] : t;
}

const EMAIL_PREFIX = 'new-title-email:';

module.exports = { CAMPAIGN_PREFIX, EMAIL_PREFIX, normAuthor, authorsOf, shelfOf, shelvesOf, cartItemsOf, keywordsOf, matchCustomers, matchBuyersOf, emailHtml, templateParams, bareTitle };
