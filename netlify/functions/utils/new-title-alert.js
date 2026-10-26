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
  return '';   // "Fiction", "New arrivals", "Preloved"… too broad to call a taste
}

const normTitle = (t) => clean(t).toLowerCase().replace(/[^a-z0-9ऀ-ॿ]+/g, ' ').trim();

/**
 * Who should hear about `book`.
 *
 * @param {Map<string,{name:string, orders:object[]}>} customers  phone → orders
 * @param {{slug, title, author, category}} book
 * @param {(item) => {author?:string, category?:string}} metaOf  fills gaps in a cart line
 * @param {{match?: 'author'|'author_or_category'}} opts
 * @returns {{ recipients: {phone, name, reason}[], counts: object }}
 */
function matchCustomers(customers, book, metaOf, opts = {}) {
  const byCategory = opts.match === 'author_or_category';
  const wantAuthors = new Set(authorsOf(book.author));
  const wantShelf = shelfOf(book.category);
  const slug = clean(book.slug).toLowerCase();
  const title = normTitle(book.title);
  const displayAuthor = clean(book.author);
  const counts = { customers: customers.size, matched: 0, already_bought: 0 };
  const recipients = [];

  for (const [phone, info] of customers) {
    let authorHit = false, shelfHit = false, bought = false;
    for (const order of info.orders || []) {
      for (const item of Array.isArray(order.cart_items) ? order.cart_items : []) {
        if (!item) continue;
        const itemSlug = clean(String(item.url || item.id || '').match(/\/product\/([^/?#]+)/i)?.[1] || item.slug).toLowerCase();
        if ((slug && itemSlug === slug) || (title && normTitle(item.title) === title)) { bought = true; continue; }
        const meta = { ...(metaOf ? metaOf(item) || {} : {}), ...(item.author ? { author: item.author } : {}) };
        if (!authorHit && wantAuthors.size && authorsOf(meta.author).some((a) => wantAuthors.has(a))) authorHit = true;
        if (!shelfHit && byCategory && wantShelf && shelfOf(meta.category || item.category) === wantShelf) shelfHit = true;
      }
    }
    if (bought) { counts.already_bought++; continue; }
    if (!authorHit && !shelfHit) continue;
    counts.matched++;
    recipients.push({ phone, name: clean(info.name).split(' ')[0] || 'there', reason: authorHit ? displayAuthor : wantShelf });
  }
  return { recipients, counts };
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
  return [recipient.name, recipient.reason, clean(book.title).slice(0, 120), line];
}

module.exports = { CAMPAIGN_PREFIX, normAuthor, authorsOf, shelfOf, matchCustomers, templateParams };
