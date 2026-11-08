// "You may also like" on product pages. The frequently-bought-together panel
// answers "what goes in the same parcel"; this answers "what should I read
// next", so it weighs things differently:
//
//   1. the same series (Harry Potter -> the other Harry Potters),
//   2. the same author (when we actually know the author),
//   3. books real customers bought alongside this one,
//   4. books about the same thing -- shared rare words in the title, tags and
//      description, weighted by how rare each word is in the whole catalogue
//      (TF-IDF), so "potter" counts for a lot and "life" for almost nothing,
//   5. the same category, then popularity among the related ones only.
//
// Hard rules on top: never another language edition unless this book is one,
// never colouring/activity books on a page that is not one, never another
// format of the very same book (the hardback on the paperback's page), and
// nothing unrelated just because it sells.
//
// Pure functions only; frequently-bought.js supplies products and signals.

const STOP = new Set([
  'the', 'and', 'with', 'for', 'book', 'books', 'edition', 'paperback', 'hardcover', 'hardback',
  'by', 'of', 'a', 'an', 'in', 'to', 'on', 'from', 'your', 'you', 'how', 'what', 'this', 'that',
  'english', 'new', 'best', 'selling', 'bestseller', 'bestselling', 'author', 'authors', 'novel',
  'set', 'combo', 'pack', 'box', 'boxset', 'collection', 'complete', 'series', 'vol', 'volume',
  'part', 'special', 'original', 'copy', 'version', 'print', 'printed', 'pages', 'page', 'read',
  'reading', 'readers', 'reader', 'world', 'will', 'have', 'has', 'are', 'was', 'his', 'her',
  'their', 'they', 'them', 'who', 'more', 'most', 'one', 'all', 'about', 'into', 'than', 'only',
  'also', 'but', 'not', 'can', 'its', 'our', 'out', 'when', 'which', 'been', 'over', 'every',
  'other', 'after', 'before', 'through', 'life', 'story', 'stories', 'time', 'year', 'years',
  'people', 'make', 'like', 'just', 'even', 'many', 'much', 'way', 'first', 'great', 'perfect',
  'gift', 'must', 'international', 'times', 'york', 'million', 'copies', 'sold', 'worldwide',
  // Shop boilerplate that combo and listing descriptions share.
  'trending', 'includes', 'including', 'include', 'included', 'bundle', 'value', 'offer', 'price',
  'delivery', 'quality', 'genuine', 'brand', 'paper', 'cover', 'covers', 'titles', 'title',
  'hindi', 'tamil', 'telugu', 'marathi', 'bengali', 'gujarati', 'kannada', 'malayalam', 'urdu',
  'preloved', 'pre', 'loved', 'owned', 'used', 'condition', 'second', 'hand', 'secondhand', 'good',
  'readable', 'minor', 'wear', 'marks', 'pristine', 'gently',
]);

// Shop buckets, not subjects: two books both on sale or both second-hand have
// nothing in common for a reader.
const BUCKET_CAT = /preloved|on sale|combo|boxset|box set|deals?|offers?|clearance|special|new arrivals|bestsellers?/i;

const LANGS = ['hindi', 'tamil', 'telugu', 'marathi', 'bengali', 'bangla', 'gujarati', 'kannada',
  'malayalam', 'urdu', 'punjabi', 'odia', 'assamese', 'sanskrit', 'russian', 'french', 'spanish',
  'german', 'japanese', 'chinese', 'korean', 'arabic'];
const LANG_RE = new RegExp(`\\b(${LANGS.join('|')})\\b`, 'i');

const ACTIVITY_RE = /\b(colou?ring|activity|activities|sticker|flash ?cards?|wipe|tracing|board book|my first|puzzles?|workbook|writing practice|alphabet|abc|phonics|rhymes?)\b/i;
const KIDS_RE = /\b(kids?|children'?s?|toddlers?|preschool|nursery|baby|ages? \d)\b/i;

function text(v) { return String(v == null ? '' : v); }

function tokens(value) {
  return text(value)
    .toLowerCase()
    .replace(/&[a-z]+;/g, ' ')
    .replace(/#[a-z]+/g, ' ')
    .replace(/[^a-z0-9ऀ-ॿ]+/g, ' ')
    .split(/\s+/)
    // Words only: tags carry shelf codes ("r6s4") that every preloved book shares.
    .filter((w) => w.length > 2 && !STOP.has(w) && !/\d/.test(w));
}

// Which language edition this is. Devanagari in the title, or a language named
// in the title/category/tags ("(Tamil) The Psychology of Money", "Hindi Books").
function langOf(p) {
  const hay = `${text(p.title)} ${text(p.category)} ${text(p.tags)}`;
  if (/[ऀ-ॿ]/.test(text(p.title))) return 'hindi';
  const m = hay.match(LANG_RE);
  if (!m) return 'english';
  const l = m[1].toLowerCase();
  return l === 'bangla' ? 'bengali' : l;
}

function kindOf(p) {
  const hay = `${text(p.title)} ${text(p.category)} ${text(p.tags)}`;
  if (ACTIVITY_RE.test(hay)) return 'activity';
  if (KIDS_RE.test(hay)) return 'kids';
  return 'book';
}

// The book itself, without its format, edition or marketing tail, so the
// hardback and paperback of one title compare equal.
function coreTitle(title) {
  return text(title)
    .toLowerCase()
    .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
    .replace(/\b(paperback|hardcover|hardback|hard cover|hb|pb|edition|english|hindi)\b/g, ' ')
    .split(/\s*[:|–—]\s+|\s+-\s+|\s+by\s+/)[0]
    .replace(/[^a-z0-9ऀ-ॿ]+/g, ' ')
    .replace(/\b(the|a|an)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function realAuthor(a) {
  const s = text(a).trim().toLowerCase();
  if (!s || /^(various|unknown|n\/?a|anonymous|na|-)$/.test(s)) return '';
  // A publisher in the author field ("Prakash Books") is not an author.
  if (/\b(books?|publications?|publishers?|publishing|press|prakashan|house|media|editors?)$/.test(s)) return '';
  return s.replace(/[^a-zऀ-ॿ]+/g, ' ').trim();
}

// The author, or the one named in the title ("... by J.K. Rowling") when the
// author field is blank -- most of the catalogue still says "Various".
function authorOf(p) {
  const a = realAuthor(p && p.author);
  if (a) return a;
  const m = text(p && p.title).match(/\bby\s+([A-Z][A-Za-z.'’\- ]{2,40}?)\s*(?:[(\[|,].*)?$/);
  return m ? realAuthor(m[1]) : '';
}

// Document frequencies across the loaded catalogue. Built once per product
// list; a word missing from it (a book loaded later) counts as rare.
function buildIndex(products) {
  const df = new Map();
  const cache = new WeakMap();
  for (const p of products) {
    const seen = new Set([...tokens(p.title), ...tokens(p.tags), ...tokens(p.description).slice(0, 220)]);
    for (const w of seen) df.set(w, (df.get(w) || 0) + 1);
  }
  const n = Math.max(products.length, 1);
  const idf = (w) => Math.log((n + 1) / ((df.get(w) || 0) + 1)) + 1;
  function profile(p) {
    let hit = cache.get(p);
    if (hit) return hit;
    const title = new Set(tokens(p.title));
    const body = new Set([...tokens(p.tags), ...tokens(p.description).slice(0, 220)]);
    let norm = 0;
    for (const w of new Set([...title, ...body])) norm += idf(w) ** 2;
    hit = {
      title, body, norm: Math.sqrt(norm) || 1,
      lang: langOf(p), kind: kindOf(p), core: coreTitle(p.title), author: authorOf(p),
      cat: text(p.category).toLowerCase(),
    };
    cache.set(p, hit);
    return hit;
  }
  return { idf, profile, size: n };
}

// The distinctive words of a title, rarest first -- what a series shares.
function seriesWords(p, index) {
  return [...index.profile(p).title]
    .filter((w) => w.length > 3)
    .sort((a, b) => index.idf(b) - index.idf(a));
}

function scoreRelated(base, cand, ctx) {
  const { index, together = 0, sold = 0 } = ctx;
  const b = index.profile(base);
  const c = index.profile(cand);
  if (!c.core || c.core === b.core) return -Infinity; // another format of this very book

  // Language and kind are filters, not nudges: a Tamil edition is no use to
  // someone reading the English page, and a colouring book is not "like" a novel.
  if (b.lang !== c.lang) return -Infinity;
  if (c.kind === 'activity' && b.kind !== 'activity') return -Infinity;
  if (c.kind === 'kids' && b.kind === 'book') return -Infinity;

  let score = 0;
  const why = [];

  // Shared rare title words: "harry potter", "atomic", "ikigai". Two of them
  // is a series; one very rare one is often the same theme.
  let titleIdf = 0;
  let titleHits = 0;
  for (const w of b.title) if (c.title.has(w) && w.length > 3) { titleIdf += index.idf(w); titleHits++; }
  if (titleHits >= 2 && titleIdf >= 9) { score += 260; why.push('series'); }
  score += Math.min(Math.round(titleIdf * 9), titleHits >= 2 ? 140 : 60);

  if (b.author && c.author && b.author === c.author) { score += 230; why.push('author'); }

  if (together > 0) { score += 180 + Math.round(Math.log2(together + 1) * 50); why.push('bought'); }

  // AI similarity (utils/ai-related.js): books close in meaning even when they
  // share no words. A close one counts as related on its own.
  const near = ctx.ai;
  if (near && near.sim > 0) {
    score += ctx.aiBonus ? ctx.aiBonus(near.sim, near.rank) : 0;
    if (near.sim >= 0.5 || (near.rank < 12 && near.sim >= 0.42)) why.push('ai');
  }

  // Cosine over IDF-weighted word sets (title + tags + description).
  let dot = 0;
  const bAll = new Set([...b.title, ...b.body]);
  const cAll = new Set([...c.title, ...c.body]);
  for (const w of bAll) if (cAll.has(w)) dot += index.idf(w) ** 2;
  const cosine = dot / (b.norm * c.norm);
  score += Math.round(Math.min(cosine, 0.6) * 300);

  const sameCat = b.cat && c.cat && b.cat === c.cat && !BUCKET_CAT.test(b.cat);
  if (sameCat) score += 45;

  // One shared title word ("silent", "alex") is not enough on its own.
  const related = why.length > 0 || cosine >= 0.1 || (titleHits >= 2 && titleIdf >= 6);
  if (!related && !sameCat) return -Infinity;
  if (related) why.push('similar');

  if (sold > 0) score += Math.min(Math.round(Math.log2(sold + 1) * 14), related ? 110 : 30);

  const diff = Math.abs((base.price || 0) - (cand.price || 0));
  if (diff <= 150) score += 8;
  else if (diff > 600) score -= 15;

  // Combos are fine to show, but a single book is the better "next read".
  if (/\b(combo|set of|box ?set|\d+\s*books)\b/i.test(text(cand.title)) && !/\b(combo|set|box)\b/i.test(text(base.title))) score -= 25;

  return { score, why, related };
}

// Rank candidates for one product. `extra` lets the caller add books found by
// a targeted lookup (same author / series) that are not in the shared pool.
function rankRelated(base, pool, ctx) {
  const rows = [];
  const popular = [];
  const seenCore = new Set([ctx.index.profile(base).core]);
  for (const cand of pool) {
    if (!cand || cand.slug === base.slug || ctx.exclude.has(cand.slug)) continue;
    if (!cand.img || !(cand.price > 0)) continue;
    const r = scoreRelated(base, cand, {
      index: ctx.index,
      ai: ctx.ai ? ctx.ai(cand) : null,
      aiBonus: ctx.aiBonus,
      together: ctx.coBuy ? ctx.coBuy(cand) : 0,
      sold: ctx.unitsSold ? ctx.unitsSold(cand) : 0,
    });
    if (r === -Infinity) {
      // Kept aside as a last resort: same language and kind, ranked by sales.
      if (ctx.unitsSold && ctx.index.profile(cand).lang === ctx.index.profile(base).lang
        && ctx.index.profile(cand).kind === ctx.index.profile(base).kind) {
        const sold = ctx.unitsSold(cand);
        if (sold > 0) popular.push({ product: cand, score: sold, why: ['popular'], related: false });
      }
      continue;
    }
    rows.push({ product: cand, score: r.score + (ctx.hash ? ctx.hash(cand) % 7 : 0), why: r.why, related: r.related });
  }
  rows.sort((a, b) => b.score - a.score);
  const out = [];
  // Same-category books with nothing else in common only top a short shelf up
  // to six; they never push the shelf past that.
  const fillTo = Math.min(ctx.limit, 6);
  for (const row of rows) {
    const core = ctx.index.profile(row.product).core;
    if (seenCore.has(core)) continue; // one copy of each book
    if (!row.related && out.length >= fillTo) continue;
    seenCore.add(core);
    out.push(row);
    if (out.length >= ctx.limit) break;
  }
  // A book we know nothing about (no author, a one-line description) would
  // otherwise get an empty shelf. Top it up with what sells in its language.
  if (out.length < fillTo) {
    popular.sort((a, b) => b.score - a.score);
    for (const row of popular) {
      const core = ctx.index.profile(row.product).core;
      if (seenCore.has(core)) continue;
      seenCore.add(core);
      out.push(row);
      if (out.length >= fillTo) break;
    }
  }
  return out;
}

// Shopify deleted many catalogue covers in Oct 2026; the baked pages use R2
// copies named by hash (utils/bestseller-rank.js catalogueCover), so the
// shelf uses the same ones. Admin-added covers are already on our own hosts.
const { catalogueCover } = require('./bestseller-rank');
function coverFor(img) {
  const u = text(img);
  return /^https?:\/\/cdn\.shopify\.com\//i.test(u) ? (catalogueCover(u) || u) : u;
}

// What the client needs to draw a card -- not the whole description.
function slim(p, why) {
  return {
    slug: p.slug, url: p.url, id: p.id, title: p.title, author: realAuthor(p.author) ? text(p.author).trim() : '',
    category: p.category || '', price: p.price, priceText: p.priceText,
    originalPrice: p.originalPrice || 0, originalPriceText: p.originalPriceText || '',
    img: coverFor(p.img), why: why || [],
  };
}

// The shelf heading. "More by X" only when the shelf really is mostly X.
function shelfHeading(base, rows) {
  const a = authorOf(base);
  const byAuthor = a ? rows.filter((r) => authorOf(r.product || r) === a).length : 0;
  if (a && byAuthor >= 3 && byAuthor >= rows.length / 2) {
    const named = realAuthor(base.author) ? text(base.author).trim()
      : (text(base.title).match(/\bby\s+([A-Z][A-Za-z.'’\- ]{2,40}?)\s*(?:[(\[|,].*)?$/) || [])[1] || '';
    return { kind: 'author', author: named.trim() };
  }
  return { kind: 'similar' };
}

module.exports = {
  tokens, langOf, kindOf, coreTitle, realAuthor, authorOf, buildIndex, seriesWords,
  scoreRelated, rankRelated, slim, shelfHeading,
};
