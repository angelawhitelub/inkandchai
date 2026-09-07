/**
 * Netlify Function: generate-banner-copy
 * POST /.netlify/functions/generate-banner-copy
 *
 * Drafts a homepage hero banner for one or more selected books: the eyebrow,
 * the three-line headline with its italic gold accent, the sub-line, the two
 * calls to action and the three stats along the bottom.
 *
 * The output is not free-form HTML. The model fills a fixed set of short text
 * fields and this function assembles the slide, so what comes back is always
 * the same markup the hand-written slides use -- `.hero-left` with
 * `.hero-eyebrow` / `.hero-title` / `.hero-sub` / `.hero-ctas` / `.hero-stats`,
 * and `.hero-right` with a `.hero-cover-wall`. A model cannot invent a class
 * name, break the carousel, or inject a script, because it never writes markup.
 *
 * Prices, links and cover images come from the database, never from the model.
 * A hallucinated price on the homepage is a consumer-law problem, and a
 * hallucinated slug is a 404 in the most valuable slot on the site.
 *
 * Body:
 *   slugs   REQUIRED  1-6 product slugs, in the order they should appear
 *   angle   optional  "value" | "series" | "new" | "hindi" -- what to lead on
 *   brief   optional  free text from the admin: the occasion, the offer, the
 *                     thing the model has no way to know
 *
 * Returns { fields, books, html } -- fields for editing, html ready to paste.
 */

const { createClient } = require('@supabase/supabase-js');
const { requireAdmin } = require('./utils/admin-auth');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key, X-Admin-Token',
  'Content-Type': 'application/json',
};
const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });

const one = (v, max = 120) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);

// Everything the model produces is inserted as TEXT. Escaping here rather than
// trusting the model is the whole reason this can be dropped into the homepage.
const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const rupees = (n) => '₹' + Math.round(Number(n) || 0).toLocaleString('en-IN');

/**
 * The only shop promises that may appear on a banner, worded exactly as the
 * rest of the site words them.
 *
 * Left to write these freely the model produced "free delivery / on all
 * orders" on its first real run. Delivery is free over Rs 499, not on all
 * orders, and a false shipping promise on the homepage is a consumer-law
 * problem, not a copy nit. So the model picks an ID from this list and the
 * server supplies the wording -- it cannot invent a term we do not offer.
 */
const PROMISES = {
  free_shipping: { num: '₹499+',   label: 'free delivery' },
  cod:           { num: 'COD',     label: 'UPI available' },
  replacement:   { num: '7-day',   label: 'replacement support' },
  payments:      { num: 'UPI',     label: 'cards · net banking' },
  pan_india:     { num: 'Pan-India', label: 'delivery' },
};

const SYSTEM_PROMPT = `You write homepage banner copy for Ink & Chai, an Indian online bookstore.

The banner is a wide hero with a headline on the left and book covers on the right. You are filling short text fields, not writing HTML.

Return ONLY a JSON object with exactly these keys:
  eyebrow      2-5 words, a category or series label. Rendered in small gold capitals. No punctuation.
  title_line1  1-3 words. The first line of the headline.
  title_accent 1-3 words. The second line, shown in italic gold. This is the phrase that should catch the eye.
  title_line3  1-4 words, ending in a full stop. The line that closes the thought.
  subtitle     15-30 words. What the books are and who they are for. Plain, specific, no hype.
  cta_label    2-4 words. The main button. An action, e.g. "Shop the set".
  cta_secondary 2-3 words for a quieter second link, e.g. "More romance".
  stat         ONE object { "num": "...", "label": "..." } describing THE BOOKS
               themselves -- e.g. { "num": "5", "label": "books in one box" }.
               num is 1-2 words or a figure, label is 2-4 words, lowercase.
               Do NOT put a price or a discount here.
  promises     EXACTLY 2 ids from this list, whichever suit the banner:
               "free_shipping", "cod", "replacement", "payments", "pan_india"
               The wording is filled in for you. Never write a shipping,
               payment or returns promise yourself -- you do not know our terms.

Read together, title_line1 + title_accent + title_line3 must form one natural sentence or phrase. Example: "Off Campus" / "all 5 books" / "one order."

Write plainly for an Indian reader. No exclamation marks. Never claim a delivery time, a rating, a bestseller rank or a stock level. Never mention a price or a discount anywhere -- the real figures are added from the database.`;

async function draft(books, { angle, brief }, model) {
  const facts = books.map((b, i) =>
    `${i + 1}. "${b.title}"${b.author ? ` by ${b.author}` : ''}${b.category ? ` [${b.category}]` : ''}`
  ).join('\n');

  const ask = `Write the banner for ${books.length === 1 ? 'this book' : `these ${books.length} books`}.\n\n${facts}`
    + (angle ? `\n\nLead on: ${angle}` : '')
    // Admin-authored, fenced so it reads as material to work from rather than
    // as new instructions.
    + (brief ? `\n\nADMIN BRIEF -- work all of this in:\n"""\n${brief}\n"""` : '');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45000);
  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: ask }],
        response_format: { type: 'json_object' },
        temperature: 0.7,   // a regenerate that returns identical copy is useless
        max_tokens: 700,
      }),
      signal: controller.signal,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`OpenAI ${res.status}: ${body.error?.message || 'request failed'}`);
    return JSON.parse(body.choices?.[0]?.message?.content || '{}');
  } finally {
    clearTimeout(timer);
  }
}

/** Assemble the slide. Every value here is either escaped model text or DB data. */
function renderSlide(f, books) {
  const covers = books.map((b, i) => `
          <a class="hero-cover-card${i === 0 ? ' featured' : ''}" href="/product/${encodeURIComponent(b.slug)}/" data-label="${esc(b.title.slice(0, 40))}">
            <picture><img src="${esc(b.img)}" alt="${esc(b.title)}" loading="lazy"/></picture>
          </a>`).join('');

  const stats = (f.stats || []).slice(0, 3).map(s => `
        <div><div class="stat-num">${esc(s.num)}</div><div class="stat-label">${esc(s.label)}</div></div>`).join('');

  return `  <!-- Banner: ${esc(f.eyebrow)} -->
  <section class="hero promo-slide" style="padding:0;" aria-label="${esc(f.eyebrow)}">
    <div class="hero-left">
      <div class="hero-eyebrow">${esc(f.eyebrow)}</div>
      <h2 class="hero-title">${esc(f.title_line1)}<br/><em>${esc(f.title_accent)}</em><br/>${esc(f.title_line3)}</h2>
      <p class="hero-sub hero-sub-desktop">${esc(f.subtitle)}</p>
      <div class="hero-ctas">
        <a href="${esc(f.cta_href)}" class="btn-primary">${esc(f.cta_label)}${f.price_label ? ` — ${esc(f.price_label)}` : ''}</a>
        <a href="${esc(f.cta_secondary_href)}" class="btn-ghost">${esc(f.cta_secondary)}</a>
      </div>
      <div class="hero-stats">${stats}
      </div>
    </div>
    <div class="hero-right">
      <div class="hero-cover-wall" aria-label="${esc(f.eyebrow)} featured books">${covers}
      </div>
    </div>
  </section>`;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: 'Method Not Allowed' };
  const block = requireAdmin(event, CORS); if (block) return block;

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }

  const slugs = (Array.isArray(body.slugs) ? body.slugs : [])
    .map(s => one(s, 200)).filter(Boolean).slice(0, 6);
  if (!slugs.length) return json(400, { error: 'Pick at least one book first.' });

  if (!process.env.OPENAI_API_KEY) {
    return json(503, { error: 'OPENAI_API_KEY is not readable on this deploy, so banner drafting is unavailable. Set it with: npx wrangler secret put OPENAI_API_KEY' });
  }
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return json(500, { error: 'Supabase is not configured on this deploy.' });
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: rows, error } = await supabase
    .from('custom_products')
    .select('slug,title,author,category,price_inr,original_price_inr,image_url,is_active')
    .in('slug', slugs);
  if (error) return json(500, { error: `Could not load the books: ${error.message}` });

  // Keep the admin's chosen order; the first book is the featured cover.
  const bySlug = new Map((rows || []).map(r => [r.slug, r]));
  const books = slugs.map(s => bySlug.get(s)).filter(Boolean).map(r => ({
    slug: r.slug,
    title: one(r.title, 200),
    author: one(r.author, 120),
    category: one(r.category, 80),
    price: Number(r.price_inr) || 0,
    original_price: Number(r.original_price_inr) || 0,
    img: one(r.image_url, 600),
    is_active: r.is_active !== false,
  }));

  const missing = slugs.filter(s => !bySlug.has(s));
  if (!books.length) return json(400, { error: `None of those books were found: ${missing.join(', ')}` });

  let out;
  try {
    out = await draft(books, { angle: one(body.angle, 40), brief: one(body.brief, 1200) },
      process.env.OPENAI_BANNER_MODEL || process.env.OPENAI_MODEL || 'gpt-4o');
  } catch (err) {
    const msg = err.name === 'AbortError' ? 'The model took too long to respond. Try again.' : err.message;
    console.error('[generate-banner-copy]', msg);
    return json(502, { error: msg });
  }

  // Money and destinations are ours, not the model's.
  const total = books.reduce((sum, b) => sum + b.price, 0);
  const single = books.length === 1;
  const fields = {
    eyebrow: one(out.eyebrow, 60),
    title_line1: one(out.title_line1, 40),
    title_accent: one(out.title_accent, 40),
    title_line3: one(out.title_line3, 40),
    subtitle: one(out.subtitle, 260),
    cta_label: one(out.cta_label, 40) || 'Shop now',
    cta_href: single ? `/product/${books[0].slug}/` : '/book-combos/',
    cta_secondary: one(out.cta_secondary, 40) || 'Browse all books',
    cta_secondary_href: '/bestsellers/',
    price_label: rupees(total),
    stats: [],
  };

  // Stat 1 is the model's, about the books. Stats 2 and 3 are ours, chosen by
  // id from PROMISES -- an id we do not recognise is dropped rather than
  // guessed at, and the gaps are filled from the front of the list.
  const bookStat = out.stat && (out.stat.num || out.stat.label)
    ? { num: one(out.stat.num, 24), label: one(out.stat.label, 40) }
    : { num: String(books.length), label: books.length === 1 ? 'book' : 'books in one box' };
  fields.stats.push(bookStat);

  const picked = (Array.isArray(out.promises) ? out.promises : [])
    .map(id => PROMISES[String(id || '').toLowerCase()])
    .filter(Boolean);
  for (const p of ['free_shipping', 'cod', 'replacement']) {
    if (picked.length >= 2) break;
    const fill = PROMISES[p];
    if (!picked.some(x => x.num === fill.num)) picked.push(fill);
  }
  fields.stats.push(...picked.slice(0, 2).map(p => ({ ...p })));

  const inactive = books.filter(b => !b.is_active).map(b => b.slug);
  return json(200, {
    fields,
    books,
    html: renderSlide(fields, books),
    warnings: [
      ...(missing.length ? [`Not found, so left out: ${missing.join(', ')}`] : []),
      ...(inactive.length ? [`Not active on the storefront: ${inactive.join(', ')}`] : []),
      ...(books.some(b => !b.img) ? ['At least one book has no cover image.'] : []),
    ],
  });
};

module.exports.renderSlide = renderSlide;
module.exports._internals = { renderSlide, esc, PROMISES };
