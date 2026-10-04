'use strict';

/**
 * Bestseller agent: finds books that are selling well elsewhere and that Ink &
 * Chai does not list yet, and drafts a listing for each one into a REVIEW
 * QUEUE (bestseller_candidates). Nothing here publishes: a person approves each
 * draft in the admin "Bestsellers" tab, and only then does it become a product.
 *
 * Why a queue and not auto-publish: a book being popular says nothing about
 * whether we can source it. A listing we cannot fulfil turns into cancelled
 * prepaid orders and unpaid COD parcels coming back.
 *
 * Where the data comes from (all verified reachable from Cloudflare, 30 Sep 2026):
 *   - Amazon.in bestseller LIST pages, one per category. 30 titles are rendered;
 *     all 50 ASINs are in the grid's data-client-recs-list attribute.
 *   - The Amazon.in product page per new book: ISBN-13, publisher, language,
 *     pages, weight, dimensions, reading age, format and the M.R.P.
 *   - Crossword (Shopify) search by ISBN: a second M.R.P. and a cover image.
 *   - Open Library / Google Books by ISBN: cover images.
 * Amazon's own cover images and description text are never stored.
 *
 * Price rule: M.R.P. minus 40%, rounded to the rupee (PRICE_FACTOR).
 */

const { isbn10Valid, isbn13Valid, isbnToGtin } = require('./gtin');

const PRICE_FACTOR = 0.6;          // MRP − 40%
const DEFAULT_LIMIT = 30;           // new books drafted per scheduled run
const FETCH_TIMEOUT_MS = 20000;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';

/**
 * Every Amazon.in Books bestseller list (the left-hand genre menu, read 5 Oct
 * 2026), plus the overall Books list. `category` is ours, not Amazon's, and is
 * only the fallback: a book's own breadcrumb wins (categoryFor).
 *
 * `nightly` lists are the ones the 03:30 run reads -- what the store sells.
 * Exam prep, school books and textbooks dominate the overall list and are not
 * our trade, so they, and every other genre, run only when the admin picks
 * them in the Bestsellers tab.
 */
const LISTS = [
  { id: '1318157031', name: 'Literature & Fiction', category: 'Fiction', nightly: true },
  { id: '1318168031', name: 'Romance', category: 'All Romance Books', nightly: true },
  { id: '1318161031', name: 'Crime, Thriller & Mystery', category: 'Fiction', nightly: true },
  { id: '1402038031', name: 'Fantasy, Horror & Science Fiction', category: 'Fiction', nightly: true },
  { id: '64619754031', name: 'Teen & Young Adult', category: 'Fiction', nightly: true },
  { id: '1318128031', name: 'Health, Family & Personal Development', category: 'All Self Help', nightly: true },
  { id: '1318068031', name: 'Business & Economics', category: 'Business and Finance', nightly: true },
  { id: '1318064031', name: 'Biographies, Diaries & True Accounts', category: 'Biography and Autobiography', nightly: true },
  { id: '64619755031', name: "Children's Books", category: 'Kids Book', nightly: true },
  { id: '1318104031', name: 'Comics & Mangas', category: 'Manga', nightly: true },
  { id: '1318188031', name: 'Religion', category: 'Best of Spirituality and Mythology', nightly: true },
  // On demand only.
  { id: 'all', name: 'Books (overall)', category: 'Non-Fiction' },
  { id: '1318158031', name: 'Action & Adventure', category: 'Fiction' },
  { id: '1318052031', name: 'Arts, Film & Photography', category: 'Non-Fiction' },
  { id: '1318105031', name: 'Computing, Internet & Digital Media', category: 'Non-Fiction' },
  { id: '1318118031', name: 'Crafts, Home & Lifestyle', category: 'Non-Fiction' },
  { id: '22960344031', name: 'Engineering', category: 'Non-Fiction' },
  { id: '4149751031', name: 'Exam Preparation', category: 'Non-Fiction' },
  { id: '23033693031', name: 'Health, Fitness & Nutrition', category: 'Health & Fitness' },
  { id: '4149418031', name: 'Higher Education Textbooks', category: 'Non-Fiction' },
  { id: '1318164031', name: 'Historical Fiction', category: 'Fiction' },
  { id: '4149493031', name: 'History', category: 'Non-Fiction' },
  { id: '1318143031', name: 'Humour', category: 'Non-Fiction' },
  { id: '1318144031', name: 'Language, Linguistics & Writing', category: 'Non-Fiction' },
  { id: '4149542031', name: 'Law', category: 'Non-Fiction' },
  { id: '1318298031', name: 'Maps & Atlases', category: 'Non-Fiction' },
  { id: '4149549031', name: 'Medicine & Health Sciences', category: 'Non-Fiction' },
  { id: '1318176031', name: 'Politics', category: 'Non-Fiction' },
  { id: '1318185031', name: 'Reference', category: 'Non-Fiction' },
  { id: '4149807031', name: 'School Books', category: 'Non-Fiction' },
  { id: '4149708031', name: 'Science & Mathematics', category: 'Science' },
  { id: '1318203031', name: 'Sciences, Technology & Medicine', category: 'Science' },
  { id: '1318216031', name: 'Society & Social Sciences', category: 'Non-Fiction' },
  { id: '1318224031', name: 'Sports', category: 'Non-Fiction' },
  { id: '15417300031', name: 'Textbooks & Study Guides', category: 'Non-Fiction' },
  { id: '1318295031', name: 'Travel', category: 'Non-Fiction' },
];
const NIGHTLY_LISTS = LISTS.filter((l) => l.nightly);

// ── small helpers ───────────────────────────────────────────────────────────

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"', ndash: '–', mdash: '—', hellip: '…', lrm: '', rlm: '', zwj: '', zwnj: '' };
const ACCENTS = { acute: '\u0301', grave: '\u0300', uml: '\u0308', circ: '\u0302', tilde: '\u0303', cedil: '\u0327', ring: '\u030a' };
function decodeEntities(s) {
  return String(s || '')
    .replace(/&([a-zA-Z])(acute|grave|uml|circ|tilde|cedil|ring);/g, (_, ch, mark) => (ch + ACCENTS[mark]).normalize('NFC'))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, name) => (name.toLowerCase() in ENTITIES ? ENTITIES[name.toLowerCase()] : m));
}

/** Tag-stripped, entity-decoded, whitespace-collapsed text. Drops Amazon's LRM/RLM marks. */
function text(html) {
  return decodeEntities(String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' '))
    .replace(/[‎‏​]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function rupees(raw) {
  const n = Number(String(raw || '').replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function priceFromMrp(mrp) {
  const n = Number(mrp);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.max(1, Math.round(n * PRICE_FACTOR));
}

/** ISBN-13 for an Amazon book ASIN when the ASIN is itself an ISBN-10. */
function isbn13FromAsin(asin) {
  const a = String(asin || '').toUpperCase();
  return isbn10Valid(a) ? isbnToGtin(a) : '';
}

// ── Amazon list page ────────────────────────────────────────────────────────

/**
 * Every ranked ASIN on a bestseller list page, with whatever the server
 * rendered for it (title, author, price) -- only ranks 1-30 of each page are
 * rendered; the rest come from data-client-recs-list with an ASIN alone.
 */
function parseListPage(html) {
  const s = String(html || '');
  const byAsin = new Map();

  const recs = s.match(/data-client-recs-list="([^"]+)"/);
  if (recs) {
    try {
      for (const it of JSON.parse(decodeEntities(recs[1]))) {
        const rank = Number(it && it.metadataMap && it.metadataMap['render.zg.rank']);
        if (it && it.id && rank) byAsin.set(it.id, { asin: it.id, rank });
      }
    } catch { /* fall through to the rendered grid */ }
  }

  for (const block of s.split('id="gridItemRoot"').slice(1)) {
    const chunk = block.slice(0, 12000);
    const asin = (chunk.match(/\/dp\/([A-Z0-9]{10})/) || [])[1];
    if (!asin) continue;
    const rank = Number((chunk.match(/>#(\d+)</) || [])[1]) || (byAsin.get(asin) || {}).rank || null;
    const title = (chunk.match(/_cDEzb_p13n-sc-css-line-clamp[^"]*"[^>]*>([\s\S]*?)<\/div>/) || [])[1];
    const author = (chunk.match(/class="a-size-small a-link-child"[^>]*>([\s\S]*?)<\/(?:a|div|span)>/) || [])[1];
    const price = (chunk.match(/₹\s?([\d,]+(?:\.\d+)?)/) || [])[1];
    byAsin.set(asin, {
      asin,
      rank,
      title: title ? text(title) : null,
      author: author ? text(author) : null,
      price: rupees(price),
    });
  }

  return [...byAsin.values()].filter((e) => e.rank).sort((a, b) => a.rank - b.rank);
}

// ── Amazon product page ─────────────────────────────────────────────────────

/** "Publisher : Penguin" style rows from the Product details list. */
function detailRows(html) {
  const s = String(html || '');
  const rows = {};
  const start = s.indexOf('id="detailBullets_feature_div"');
  if (start >= 0) {
    const end = s.indexOf('</ul>', start);
    const region = s.slice(start, end > start ? end : start + 20000);
    for (const li of region.split(/<li[\s>]/).slice(1)) {
      const t = text('<' + li);
      const i = t.indexOf(':');
      if (i <= 0) continue;
      const key = t.slice(0, i).trim().toLowerCase();
      const value = t.slice(i + 1).trim();
      if (key && value && !(key in rows)) rows[key] = value;
    }
  }
  return rows;
}

/**
 * The facts on a product page. Returns { ok:false, reason } when the page is
 * not a print book we can list (a bot wall, a Kindle edition, no ISBN).
 */
function parseProductPage(html, asin) {
  const s = String(html || '');
  if (s.length < 20000 || /captcha|Robot Check|Type the characters you see/i.test(s.slice(0, 20000))) {
    return { ok: false, reason: 'blocked', asin };
  }

  const title = text((s.match(/id="productTitle"[^>]*>([\s\S]*?)<\/span>/) || [])[1]);
  const rows = detailRows(s);

  const byline = (() => {
    const i = s.indexOf('id="bylineInfo"');
    return i >= 0 ? s.slice(i, i + 6000) : '';
  })();
  const contributors = [];
  for (const m of byline.matchAll(/<span class="author[^"]*"[^>]*>([\s\S]*?)<\/span>\s*<\/span>/g)) {
    const name = text((m[1].match(/<a[^>]*>([\s\S]*?)<\/a>/) || [])[1]);
    const role = text((m[1].match(/class="contribution"[^>]*>([\s\S]*)/) || [])[1]).replace(/[(),]/g, ' ').trim();
    if (name) contributors.push({ name, role });
  }
  const authors = contributors.filter((c) => /author/i.test(c.role)).map((c) => c.name);
  const author = (authors.length ? authors : contributors.map((c) => c.name)).slice(0, 3).join(', ') || null;
  const format = text((byline.match(/Format:\s*<\/span>\s*<span[^>]*>([\s\S]*?)<\/span>/) || [])[1]) || null;

  const isbn13 = isbnToGtin(rows['isbn-13'] || '') || isbnToGtin(rows['isbn-10'] || '') || isbn13FromAsin(asin);
  if (!isbn13 || /kindle/i.test(format || '')) {
    return { ok: false, reason: /kindle/i.test(format || '') ? 'kindle edition' : 'no ISBN (not a print book)', asin, title };
  }

  // The buy box. Other M.R.P.s on the page belong to "customers also bought".
  let mrp = null;
  let price = null;
  const core = s.indexOf('id="corePriceDisplay_desktop_feature_div"');
  const apex = s.indexOf('id="apex_desktop"');
  const boxStart = core >= 0 ? core : apex;
  if (boxStart >= 0) {
    const box = s.slice(boxStart, boxStart + 9000);
    const at = box.search(/M\.R\.P/);
    if (at >= 0) mrp = rupees((box.slice(at).match(/₹\s?([\d,]+(?:\.\d+)?)/) || [])[1]);
    price = rupees((box.match(/priceToPay[\s\S]{0,400}?a-offscreen">\s*₹\s?([\d,]+(?:\.\d+)?)/) || [])[1])
      || rupees((box.match(/class="a-price-whole">([\d,]+)/) || [])[1]);
  }

  const crumbs = (() => {
    const i = s.indexOf('id="wayfinding-breadcrumbs_feature_div"');
    if (i < 0) return [];
    const region = s.slice(i, s.indexOf('</ul>', i) > i ? s.indexOf('</ul>', i) : i + 6000);
    return [...region.matchAll(/<a[^>]*>([\s\S]*?)<\/a>/g)].map((m) => text(m[1])).filter(Boolean);
  })();

  const blurb = (() => {
    const i = s.indexOf('id="bookDescription_feature_div"');
    if (i < 0) return '';
    const region = s.slice(i, i + 12000);
    const inner = region.match(/<div[^>]*a-expander-content[^>]*>([\s\S]*?)<\/div>/);
    return text(inner ? inner[1] : region).slice(0, 2500);
  })();

  const pages = Number(((rows['print length'] || rows.paperback || rows.hardcover || '').match(/(\d{2,5})\s*pages/i) || [])[1]) || null;
  const grams = (() => {
    const w = rows['item weight'] || '';
    const g = w.match(/([\d.]+)\s*g\b/i);
    const kg = w.match(/([\d.]+)\s*kg/i);
    if (kg) return Math.round(Number(kg[1]) * 1000) || null;
    return g ? Math.round(Number(g[1])) || null : null;
  })();

  return {
    ok: true,
    asin,
    isbn13,
    title: title || null,
    author,
    format,
    publisher: (rows.publisher || '').replace(/;.*$/, '').replace(/\s*\(.*\)\s*$/, '').trim() || null,
    published_on: rows['publication date'] || null,
    language: rows.language || null,
    pages,
    weight_grams: grams,
    dimensions: rows.dimensions || null,
    reading_age: (rows['reading age'] || '').replace(/^customer suggested age:\s*/i, '') || null,
    mrp,
    price,
    breadcrumbs: crumbs,
    blurb,
  };
}

/**
 * The title to list under. Amazon appends marketing after " | " ("Inspirational
 * Zen book on motivation…") and format in brackets; the catalogue convention is
 * "Title by Author".
 */
function listingTitle(rawTitle, author) {
  let t = decodeEntities(String(rawTitle || '')).split(/\s+\|\s+/)[0];
  // Trailing bracketed trade tags: "(Paperback)", "(EXPORT) (A FORMAT)", "[English Edition]".
  const TAG = /\s*[([][^)\]]*\b(paperback|hardcover|hardback|english|hindi|export|format|edition)\b[^)\]]*[)\]]\s*$/i;
  for (let i = 0; i < 4 && TAG.test(t); i += 1) t = t.replace(TAG, '');
  t = t.replace(/\s+/g, ' ').trim();
  // Shouted titles read as spam on a product page.
  if (t.length > 4 && t === t.toUpperCase() && /[A-Z]{4}/.test(t)) {
    t = t.toLowerCase().replace(/(^|[\s:(-])([a-z])/g, (m, pre, ch) => pre + ch.toUpperCase());
  }
  if (t.length > 120) t = t.split(':')[0].trim();
  const first = String(author || '').split(',')[0].trim();
  return first && !t.toLowerCase().includes(first.toLowerCase()) ? `${t} by ${first}` : t;
}

/**
 * Our category for a book: its own Amazon category (the breadcrumb) when that
 * is one we map, else the list it was found on. A Panchatantra kids' book tops
 * the Comics list; it still belongs under Kids Book.
 */
const CRUMB_CATEGORY = [
  [/children/i, 'Kids Book'],
  [/comics|manga/i, (crumbs) => (crumbs.slice(2).some((c) => /manga/i.test(c)) ? 'Manga' : 'Comics')],
  [/romance/i, 'All Romance Books'],
  [/health, family|personal development|self-help/i, 'All Self Help'],
  [/business|economics/i, 'Business and Finance'],
  [/biograph/i, 'Biography and Autobiography'],
  [/religion|spirituality/i, 'Best of Spirituality and Mythology'],
  [/literature|fiction|crime|thriller|fantasy|teen|young adult|action|adventure/i, 'Fiction'],
  [/fitness|nutrition/i, 'Health & Fitness'],
  [/science|mathematics/i, 'Science'],
];
function categoryFor(list, crumbs) {
  const top = (crumbs || [])[1] || '';
  for (const [re, cat] of CRUMB_CATEGORY) {
    if (re.test(top)) return typeof cat === 'function' ? cat(crumbs) : cat;
  }
  return list.category;
}

// ── matching against what we already sell ──────────────────────────────────

const STOP = new Set(['the', 'a', 'an', 'of', 'and', 'in', 'on', 'to', 'for', 'with', 'by']);
const NOISE = /\b(paperback|hardcover|hardback|board book|edition|revised|updated|new|latest|special|deluxe|collectors?|box ?set|boxset|set of \d+ books?|books?|novel|combo|english|hindi|preloved)\b/g;

/**
 * The part of a title that identifies the book. Amazon titles carry a
 * subtitle, series, format and marketing after ":", "|", "(" or " - "; our
 * catalogue titles carry " by Author". Both reduce to the same key.
 */
function coreTitle(raw) {
  let s = decodeEntities(String(raw || '')).toLowerCase();
  s = s.split(/\s[|–—-]\s|[|:([]/)[0];
  s = s.replace(/\s+by\s+.+$/, '');
  s = s.replace(/[’']/g, '').replace(/&/g, ' and ');
  s = s.replace(NOISE, ' ');
  return s.replace(/[^a-z0-9ऀ-ॿ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function tokens(key) {
  return key.split(' ').filter((t) => t && !STOP.has(t));
}

function surname(author) {
  const first = String(author || '').split(/,|&| and /i)[0].trim().toLowerCase();
  const parts = first.replace(/[^a-zऀ-ॿ ]/g, ' ').split(/\s+/).filter(Boolean);
  return parts[parts.length - 1] || '';
}

/**
 * entries: [{ title, author?, slug, source, isbn?, weak? }]
 */
function buildCatalogueIndex(entries) {
  const byCore = new Map();
  const byIsbn = new Map();
  const list = [];
  for (const e of entries || []) {
    const core = coreTitle(e.title);
    if (!core) continue;
    const toks = tokens(core);
    // Keyed without stop words: "The Psychology of Money" and "Psychology of
    // Money" are one book.
    const key = toks.join(' ') || core;
    const item = { ...e, core, key, toks, lower: String(e.title || '').toLowerCase() };
    list.push(item);
    if (!byCore.has(key)) byCore.set(key, []);
    byCore.get(key).push(item);
    const isbn = isbnToGtin(e.isbn || '');
    if (isbn) byIsbn.set(isbn, item);
  }
  return { byCore, byIsbn, list };
}

/**
 * { kind: 'exact' | 'near' | null, match }
 *   exact: we already sell this book -- skip it.
 *   near:  looks like something we sell -- draft it, but show the admin what
 *          it resembles so they can reject a duplicate.
 * A weak entry (a preloved copy, a switched-off listing) never counts as
 * "we already sell it"; it can only make a draft "near".
 */
function matchCatalogue(index, { title, author, isbn13 }) {
  const isbnHit = isbn13 && index.byIsbn.get(isbn13);
  if (isbnHit && !isbnHit.weak) return { kind: 'exact', match: isbnHit };

  const core = coreTitle(title);
  if (!core) return { kind: null, match: null };
  const sn = surname(author);
  const toks = tokens(core);

  const same = (index.byCore.get(toks.join(' ') || core) || []);
  const newCopy = same.filter((e) => !e.weak);
  if (newCopy.length) {
    // A one- or two-word title ("Verity", "It Ends With Us" is fine) collides
    // across authors; demand the author too when both sides name one.
    const short = toks.length <= 2;
    const confirmed = newCopy.find((e) => !short || !sn || e.lower.includes(sn) || (e.author && surname(e.author) === sn));
    if (confirmed) return { kind: 'exact', match: confirmed };
    return { kind: 'near', match: newCopy[0] };
  }
  if (same.length) return { kind: 'near', match: same[0] };

  if (toks.length >= 2) {
    const want = new Set(toks);
    let best = null;
    let bestScore = 0;
    for (const e of index.list) {
      if (!e.toks.length) continue;
      let common = 0;
      for (const t of e.toks) if (want.has(t)) common += 1;
      const score = common / Math.max(want.size, e.toks.length);
      if (score > bestScore) { bestScore = score; best = e; }
    }
    if (best && bestScore >= 0.75) return { kind: 'near', match: best };
  }
  return { kind: null, match: null };
}

// ── M.R.P. ─────────────────────────────────────────────────────────────────

/**
 * Which M.R.P. to price from, and how sure we are.
 *   Amazon shows "M.R.P." only when it discounts. With no M.R.P. line, the
 *   price it charges is the M.R.P. (selling above M.R.P. is illegal in India),
 *   but that is an inference, so it is marked as such.
 */
function decideMrp({ amazonMrp, amazonPrice, crosswordMrp }) {
  const warnings = [];
  let mrp = null;
  let source = null;
  if (amazonMrp) { mrp = amazonMrp; source = 'amazon'; }
  else if (crosswordMrp) { mrp = crosswordMrp; source = 'crossword'; }
  else if (amazonPrice) { mrp = amazonPrice; source = 'amazon-price'; warnings.push('No M.R.P. shown on Amazon; used its selling price. Check the printed M.R.P.'); }
  if (amazonMrp && crosswordMrp && Math.abs(amazonMrp - crosswordMrp) >= 1) {
    warnings.push(`M.R.P. differs: Amazon ₹${amazonMrp}, Crossword ₹${crosswordMrp}. Check the printed M.R.P.`);
  }
  if (!mrp) warnings.push('No M.R.P. found. Enter the price before approving.');
  return { mrp, source, warnings };
}

// ── network ────────────────────────────────────────────────────────────────

async function fetchText(url, { fetchImpl = fetch, accept = 'text/html', timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      headers: { 'User-Agent': UA, Accept: accept, 'Accept-Language': 'en-IN,en;q=0.9' },
      signal: controller.signal,
      redirect: 'follow',
    });
    const body = await res.text();
    return { status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchList(list, { fetchImpl, page = 1 } = {}) {
  const path = list.id === 'all' ? '' : list.id;
  const url = `https://www.amazon.in/gp/bestsellers/books/${path}${page > 1 ? `?pg=${page}` : ''}`;
  const { status, body } = await fetchText(url, { fetchImpl });
  if (status !== 200) throw new Error(`HTTP ${status}`);
  const entries = parseListPage(body);
  if (!entries.length) throw new Error(/captcha/i.test(body) ? 'blocked by Amazon' : 'no titles found on the page');
  return entries;
}

async function crosswordLookup(isbn13, { fetchImpl } = {}) {
  try {
    const url = `https://www.crossword.in/search/suggest.json?q=${encodeURIComponent(isbn13)}&resources%5Btype%5D=product&resources%5Blimit%5D=3`;
    const { status, body } = await fetchText(url, { fetchImpl, accept: 'application/json', timeoutMs: 10000 });
    if (status !== 200) return null;
    const products = JSON.parse(body)?.resources?.results?.products || [];
    // The suggest endpoint is a search, not a lookup: only trust a hit whose
    // page mentions this ISBN (Crossword puts it in the body text).
    const p = products.find((x) => String(x.body || '').includes(isbn13) || String(x.handle || '').includes(isbn13)) || (products.length === 1 ? products[0] : null);
    if (!p) return null;
    return {
      mrp: rupees(p.compare_at_price_max) || rupees(p.price_max),
      price: rupees(p.price_max),
      available: p.available !== false,
      image: (p.featured_image && p.featured_image.url) || p.image || null,
      url: p.url ? `https://www.crossword.in${String(p.url).split('?')[0]}` : null,
    };
  } catch {
    return null;
  }
}

/** A cover we are allowed to keep a copy of. Never Amazon's. */
async function findCover(isbn13, crossword, { fetchImpl = fetch } = {}) {
  try {
    const url = `https://covers.openlibrary.org/b/isbn/${isbn13}-L.jpg?default=false`;
    const res = await fetchImpl(url, { method: 'HEAD', redirect: 'follow' });
    const len = Number(res.headers.get('content-length') || 0);
    if (res.ok && (!len || len > 2000)) return { url: `https://covers.openlibrary.org/b/isbn/${isbn13}-L.jpg`, source: 'openlibrary' };
  } catch { /* next */ }
  try {
    const key = typeof process !== 'undefined' && process.env && process.env.GOOGLE_BOOKS_API_KEY;
    const { status, body } = await fetchText(`https://www.googleapis.com/books/v1/volumes?q=isbn:${isbn13}${key ? `&key=${key}` : ''}`,
      { fetchImpl, accept: 'application/json', timeoutMs: 10000 });
    if (status === 200) {
      const links = JSON.parse(body)?.items?.[0]?.volumeInfo?.imageLinks;
      const link = links && (links.large || links.medium || links.thumbnail);
      if (link) return { url: link.replace(/^http:/, 'https:').replace(/&edge=curl/, '').replace(/zoom=1/, 'zoom=2'), source: 'googlebooks' };
    }
  } catch { /* next */ }
  if (crossword && crossword.image) return { url: crossword.image, source: 'crossword' };
  return { url: null, source: null };
}

// ── listing copy ───────────────────────────────────────────────────────────

const COPY_PROMPT = `You write product copy for Ink & Chai, an Indian online bookstore selling English and Hindi books.

Return ONLY a JSON object with exactly these keys:
  description       Markdown. 120-200 words. What the book is about and who it is for.
                    Use "## " headings and "- " bullets where they genuinely help.
  author_bio        Plain text, 40-70 words about the author. "" if the author is unknown to you.
  tags              6-10 comma-separated search keywords a customer would actually type.
  seo_title         50-60 characters. Pattern: "<Title> by <Author> | <Format>".
  meta_description  140-160 characters. Title, author, format, and a concrete reason to click.

Rules:
- Write ORIGINAL copy in Indian English. The publisher's blurb is given only as
  facts to work from: never copy its sentences.
- NEVER invent awards, review quotes, sales figures, endorsements or ISBNs.
- No emoji. No "must-read", "game-changer", "dive into", "unlock" or similar filler.
- Do not promise delivery times, discounts or stock levels.`;

async function draftCopy(book, { fetchImpl = fetch, apiKey, model } = {}) {
  if (!apiKey) return { skipped: 'OPENAI_API_KEY not set' };
  const facts = [
    `Title: ${book.title}`,
    `Author: ${book.author || 'not given'}`,
    book.format ? `Format: ${book.format}` : null,
    book.language ? `Language: ${book.language}` : null,
    book.publisher ? `Publisher: ${book.publisher}` : null,
    book.pages ? `Pages: ${book.pages}` : null,
    book.category ? `Category: ${book.category}` : null,
    book.blurb ? `Publisher's blurb (facts only, do not copy):\n"""\n${book.blurb.slice(0, 2000)}\n"""` : null,
  ].filter(Boolean).join('\n');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45000);
  try {
    const res = await fetchImpl('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: model || 'gpt-4.1-mini',
        messages: [{ role: 'system', content: COPY_PROMPT }, { role: 'user', content: `Draft the listing copy for this book.\n\n${facts}` }],
        response_format: { type: 'json_object' },
        temperature: 0.5,
        max_tokens: 1100,
      }),
      signal: controller.signal,
    });
    const ai = await res.json().catch(() => ({}));
    if (!res.ok) return { error: `OpenAI ${res.status}: ${ai.error?.message || 'request failed'}` };
    const out = JSON.parse(ai.choices?.[0]?.message?.content || '{}');
    const clip = (v, n) => String(v == null ? '' : v).trim().slice(0, n) || null;
    return {
      description: clip(out.description, 5000),
      author_bio: clip(out.author_bio, 2000),
      tags: clip(out.tags, 600),
      seo_title: clip(out.seo_title, 220),
      meta_description: clip(out.meta_description, 300),
    };
  } catch (e) {
    return { error: e.name === 'AbortError' ? 'OpenAI timed out' : e.message };
  } finally {
    clearTimeout(timer);
  }
}

// ── the run ────────────────────────────────────────────────────────────────

/** Merge list entries across categories: one row per ASIN, best rank wins. */
function mergeLists(perList) {
  const byAsin = new Map();
  for (const { list, entries } of perList) {
    for (const e of entries) {
      const seen = { list: list.name, rank: e.rank };
      const cur = byAsin.get(e.asin);
      if (!cur) {
        byAsin.set(e.asin, { ...e, bestRank: e.rank, list, lists: [seen] });
      } else {
        cur.lists.push(seen);
        if (!cur.title && e.title) Object.assign(cur, { title: e.title, author: e.author, price: e.price });
        if (e.rank < cur.bestRank) { cur.bestRank = e.rank; cur.list = list; }
      }
    }
  }
  return [...byAsin.values()].sort((a, b) => a.bestRank - b.bestRank || a.lists.length - b.lists.length);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One pass. Idempotent: every ASIN it has looked at is remembered in
 * bestseller_candidates (pending, skipped, rejected, approved), so the next run
 * only spends requests on titles it has never seen.
 *
 * deps: { supabase, catalogue: [{title, slug, source, isbn?, weak?}],
 *         fetchImpl?, openaiKey?, openaiModel?, pauseMs? }
 * opts: { limit, dryRun, lists (ids; default the nightly ones), pages (1-2:
 *         top 50 or top 100 of each list), log }
 */
async function runAgent(deps, opts = {}) {
  const { supabase, fetchImpl = fetch } = deps;
  const limit = Math.max(0, Math.min(200, Number(opts.limit ?? DEFAULT_LIMIT)));
  const dryRun = !!opts.dryRun;
  const pauseMs = deps.pauseMs ?? 700;
  const log = opts.log || (() => {});
  const lists = opts.lists && opts.lists.length ? LISTS.filter((l) => opts.lists.includes(l.id)) : NIGHTLY_LISTS;
  const pages = Math.max(1, Math.min(2, Number(opts.pages) || 1));

  const summary = {
    started_at: new Date().toISOString(), dry_run: dryRun, lists: [], ranked: 0,
    already_known: 0, refreshed: 0, in_catalogue: 0, drafted: 0, skipped: 0, failed: 0,
    remaining: 0, drafts: [], skips: [], errors: [],
  };

  // 1. The lists.
  const perList = [];
  for (const list of lists) {
    try {
      const entries = await fetchList(list, { fetchImpl });
      for (let page = 2; page <= pages; page++) {
        await sleep(pauseMs);
        // Page 2 is ranks 51-100. Losing it still leaves the top 50.
        try { entries.push(...await fetchList(list, { fetchImpl, page })); } catch (e) { summary.errors.push(`${list.name} page ${page}: ${e.message}`); }
      }
      perList.push({ list, entries });
      summary.lists.push({ list: list.name, titles: entries.length });
    } catch (e) {
      summary.lists.push({ list: list.name, error: e.message });
      summary.errors.push(`${list.name}: ${e.message}`);
    }
    await sleep(pauseMs);
  }
  const ranked = mergeLists(perList);
  summary.ranked = ranked.length;
  if (!ranked.length) { summary.finished_at = new Date().toISOString(); return summary; }

  // 2. What we have already seen.
  const known = new Map();
  const asins = ranked.map((r) => r.asin);
  for (let i = 0; i < asins.length; i += 150) {
    const { data, error } = await supabase.from('bestseller_candidates')
      .select('id, asin, status, best_rank, times_seen, lists').in('asin', asins.slice(i, i + 150));
    if (error) throw new Error(`bestseller_candidates: ${error.message}`);
    for (const row of data || []) known.set(row.asin, row);
  }

  const index = buildCatalogueIndex(deps.catalogue || []);
  const nowIso = new Date().toISOString();
  const fresh = [];
  for (const r of ranked) {
    const row = known.get(r.asin);
    if (row) {
      summary.already_known += 1;
      // Keep a pending draft's rank current, so the queue sorts by today's list.
      if (!dryRun && row.status === 'pending') {
        const { error } = await supabase.from('bestseller_candidates').update({
          best_rank: r.bestRank, source_list: r.list.name, lists: r.lists,
          times_seen: (row.times_seen || 1) + 1, last_seen_at: nowIso, updated_at: nowIso,
        }).eq('id', row.id);
        if (!error) summary.refreshed += 1;
      }
      continue;
    }
    // Cheap pre-check on the rendered title, before spending a product-page fetch.
    if (r.title) {
      const hit = matchCatalogue(index, { title: r.title, author: r.author, isbn13: isbn13FromAsin(r.asin) });
      if (hit.kind === 'exact') {
        summary.in_catalogue += 1;
        if (!dryRun) await remember(supabase, r, { status: 'in_catalogue', status_reason: `Already listed: ${hit.match.title}`, title: r.title, author: r.author });
        continue;
      }
    }
    fresh.push(r);
  }

  // 3. Draft the best-ranked new titles, up to the limit.
  const batch = fresh.slice(0, limit);
  summary.remaining = Math.max(0, fresh.length - batch.length);
  for (const r of batch) {
    try {
      const { status, body } = await fetchText(`https://www.amazon.in/dp/${r.asin}`, { fetchImpl });
      const page = status === 200 ? parseProductPage(body, r.asin) : { ok: false, reason: `HTTP ${status}` };
      if (!page.ok) {
        if (page.reason === 'blocked' || /^HTTP 5/.test(page.reason)) {
          // Temporary: try again next run rather than remembering a failure.
          summary.failed += 1;
          summary.errors.push(`${r.asin}: ${page.reason}`);
          if (page.reason === 'blocked') break;   // no point hammering a wall
          continue;
        }
        summary.skipped += 1;
        summary.skips.push({ asin: r.asin, title: page.title || r.title, reason: page.reason });
        if (!dryRun) await remember(supabase, r, { status: 'skipped', status_reason: page.reason, title: page.title || r.title || r.asin, author: r.author });
        continue;
      }

      const hit = matchCatalogue(index, page);
      if (hit.kind === 'exact') {
        summary.in_catalogue += 1;
        if (!dryRun) await remember(supabase, r, { status: 'in_catalogue', status_reason: `Already listed: ${hit.match.title}`, title: page.title, author: page.author, isbn13: page.isbn13 });
        continue;
      }
      // A second ASIN for an ISBN we already queued (hardcover vs paperback).
      if (!dryRun) {
        const { data: dup } = await supabase.from('bestseller_candidates').select('id').eq('isbn13', page.isbn13).limit(1);
        if (dup && dup.length) {
          summary.skipped += 1;
          await remember(supabase, r, { status: 'skipped', status_reason: 'Same ISBN as another queued ASIN', title: page.title, author: page.author });
          continue;
        }
      }

      const crossword = await crosswordLookup(page.isbn13, { fetchImpl });
      const money = decideMrp({ amazonMrp: page.mrp, amazonPrice: page.price, crosswordMrp: crossword && crossword.mrp });
      const cover = await findCover(page.isbn13, crossword, { fetchImpl });
      const category = categoryFor(r.list, page.breadcrumbs);
      const book = { ...page, category };
      const copy = await draftCopy(book, { fetchImpl, apiKey: deps.openaiKey, model: deps.openaiModel });

      const warnings = [...money.warnings];
      if (!cover.url) warnings.push('No cover image found. Upload one before approving.');
      if (copy.error) warnings.push(`Description not drafted: ${copy.error}`);
      if (crossword && crossword.available === false) warnings.push('Out of stock at Crossword.');

      const draft = {
        asin: r.asin,
        isbn13: page.isbn13,
        title: listingTitle(page.title, page.author),
        amazon_title: page.title,
        author: page.author,
        publisher: page.publisher,
        language: page.language,
        format: page.format,
        pages: page.pages,
        published_on: page.published_on,
        weight_grams: page.weight_grams,
        dimensions: page.dimensions,
        reading_age: page.reading_age,
        category,
        source_list: r.list.name,
        best_rank: r.bestRank,
        lists: r.lists,
        mrp_inr: money.mrp,
        mrp_source: money.source,
        crossword_mrp_inr: crossword ? crossword.mrp : null,
        amazon_price_inr: page.price,
        price_inr: priceFromMrp(money.mrp),
        image_url: cover.url,
        image_source: cover.source,
        description: copy.description || null,
        author_bio: copy.author_bio || null,
        tags: copy.tags || null,
        seo_title: copy.seo_title || null,
        meta_description: copy.meta_description || null,
        possible_duplicate: hit.kind === 'near' ? { title: hit.match.title, slug: hit.match.slug, source: hit.match.source } : null,
        warnings,
        status: 'pending',
      };
      summary.drafted += 1;
      summary.drafts.push({ asin: r.asin, title: draft.title, author: draft.author, list: r.list.name, rank: r.bestRank, mrp: draft.mrp_inr, price: draft.price_inr, cover: draft.image_source, warnings, possible_duplicate: draft.possible_duplicate });
      if (!dryRun) {
        const { error } = await supabase.from('bestseller_candidates').insert(draft);
        if (error) throw new Error(`insert: ${error.message}`);
      }
      log(`drafted ${r.asin} ${draft.title}`);
    } catch (e) {
      summary.failed += 1;
      summary.errors.push(`${r.asin}: ${e.message}`);
    }
    await sleep(pauseMs);
  }

  summary.finished_at = new Date().toISOString();
  return summary;
}

/** Remember an ASIN we decided not to draft, so it is not fetched again. */
async function remember(supabase, r, fields) {
  const nowIso = new Date().toISOString();
  const { error } = await supabase.from('bestseller_candidates').upsert({
    asin: r.asin,
    title: fields.title || r.title || r.asin,
    author: fields.author || r.author || null,
    isbn13: fields.isbn13 || null,
    source_list: r.list.name,
    best_rank: r.bestRank,
    lists: r.lists,
    status: fields.status,
    status_reason: fields.status_reason,
    last_seen_at: nowIso,
    updated_at: nowIso,
  }, { onConflict: 'asin' });
  if (error) throw new Error(`remember: ${error.message}`);
}

module.exports = {
  LISTS,
  NIGHTLY_LISTS,
  PRICE_FACTOR,
  DEFAULT_LIMIT,
  priceFromMrp,
  isbn13FromAsin,
  parseListPage,
  parseProductPage,
  coreTitle,
  listingTitle,
  categoryFor,
  buildCatalogueIndex,
  matchCatalogue,
  decideMrp,
  mergeLists,
  crosswordLookup,
  findCover,
  draftCopy,
  runAgent,
  isbn13Valid,
};
