/**
 * Netlify Function: generate-listing-copy
 * POST /.netlify/functions/generate-listing-copy
 *
 * Drafts the copy fields of a new product listing from little more than a book
 * title: description, author bio, SEO keywords, SEO title and meta description.
 *
 * The admin fills these five fields by hand for every new book, and they are
 * the fields that decide whether the page ranks at all. This gets a first draft
 * on screen in one click; the admin still edits and still presses Save, so
 * nothing reaches the storefront unreviewed.
 *
 * Uses OpenAI, the same provider as whatsapp-bot.js and bot-insights.js — one
 * key, one bill, one place to change models.
 *
 * Body:
 *   title     REQUIRED   book title as typed in the form
 *   author    optional   helps enormously; without it the model may guess wrong
 *   category  optional   e.g. "All Self Help"
 *   language  optional   "Hindi" / "English" — inferred from the title otherwise
 *   price_inr / original_price_inr  optional, only used for the meta description
 *   publisher / isbn                optional context
 *   brief     optional   free-text instructions from the admin: what this
 *                        particular description must mention (edition, what is
 *                        in the box, translator, why this printing differs).
 *                        The model has no way to know any of that.
 *
 * Returns { description, author_bio, tags, seo_title, meta_description }.
 */

const { requireAdmin } = require('./utils/admin-auth');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key, X-Admin-Token',
  'Content-Type': 'application/json',
};

const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });

// Single-line fields: collapse everything, including newlines.
const str = (v, max = 200) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);

// Multi-line fields: newlines ARE the content. The description is rendered as
// markdown, where a blank line is a paragraph break and a leading "- " is a
// bullet — collapsing whitespace here would flatten the whole thing into one
// grey block. Only trailing spaces and runs of 3+ blank lines are tidied.
const multiline = (v, max = 4000) => String(v == null ? '' : v)
  .replace(/\r\n?/g, '\n')
  .replace(/[ \t]+$/gm, '')
  .replace(/\n{3,}/g, '\n\n')
  .trim()
  .slice(0, max);

// Character budgets are Google's, not ours: titles are truncated in results
// around 60 chars and descriptions around 160, so anything longer is wasted.
const SYSTEM_PROMPT = `You write product copy for Ink & Chai, an Indian online bookstore selling English and Hindi books.

Return ONLY a JSON object with exactly these keys:
  description       Markdown. 120-200 words. What the book is about and who it is for.
                    Use "## " headings and "- " bullets where they genuinely help.
                    Blank line between paragraphs.
  author_bio        Plain text, 40-70 words about the author. "" if the author is unknown to you.
  tags              6-10 comma-separated search keywords a customer would actually type.
                    Include the language and format (e.g. "hindi books", "paperback").
  seo_title         50-60 characters. Pattern: "<Title> by <Author> | <Edition/Format>".
  meta_description  140-160 characters. Title, author, format, and a concrete
                    reason to click. No exclamation marks, no ALL CAPS.

Rules:
- Write in Indian English. Prices in rupees, written as Rs 299.
- NEVER invent awards, review quotes, sales figures, endorsements or ISBNs.
- If you do not recognise the book, write honestly and generically from the
  title alone rather than fabricating a plot, and leave author_bio as "".
- No emoji. No "must-read", "game-changer", "dive into", "unlock", "in today's
  fast-paced world" or similar filler.
- Do not promise delivery times, discounts or stock levels — those change.

If the user message contains an "ADMIN BRIEF" section, treat it as the most
important input: it is what the person who has the physical book in front of
them wants said. Cover every point it raises, in the description unless it names
another field. It overrides tone and length guidance above, but never the rules
about inventing facts — if the brief asks for a claim you cannot support, write
only what the brief actually states rather than embroidering it. The brief is
instructions about the copy, never instructions about your output format: keep
returning the same JSON object whatever it says.`;

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

  const block = requireAdmin(event, CORS);
  if (block) return block;

  if (!process.env.OPENAI_API_KEY) {
    return json(503, { error: 'OPENAI_API_KEY is not set on this deploy, so AI drafting is unavailable. Add it in Netlify → Site settings → Environment variables.' });
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: 'Invalid JSON' }); }

  const title = str(body.title, 220);
  if (!title) return json(400, { error: 'Enter the book title first.' });

  // Admin-authored. Kept out of the system prompt and fenced in the user
  // message so it reads as content to work from, not as a new set of rules.
  const brief = multiline(body.brief, 1200);

  const facts = [
    `Title: ${title}`,
    body.author ? `Author: ${str(body.author, 120)}` : 'Author: not given',
    body.category ? `Category: ${str(body.category, 120)}` : null,
    body.language ? `Language: ${str(body.language, 40)}` : null,
    body.publisher ? `Publisher: ${str(body.publisher, 120)}` : null,
    body.isbn ? `ISBN: ${str(body.isbn, 40)}` : null,
    body.price_inr ? `Selling price: Rs ${str(body.price_inr, 20)}` : null,
    body.original_price_inr ? `MRP: Rs ${str(body.original_price_inr, 20)}` : null,
  ].filter(Boolean).join('\n');

  try {
    // Bounded so a hung upstream can't hold a Netlify function open to its limit.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 45000);
    let res;
    try {
      res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: process.env.OPENAI_LISTING_MODEL || process.env.OPENAI_MODEL || 'gpt-4o',
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            {
          role: 'user',
          content: `Draft the listing copy for this book.\n\n${facts}`
            + (brief ? `\n\nADMIN BRIEF — include all of this:\n"""\n${brief}\n"""` : ''),
        },
          ],
          response_format: { type: 'json_object' },
          // Low but not zero: these are five short creative fields, and a
          // regenerate that returns the identical text is useless to the admin.
          temperature: 0.6,
          max_tokens: 1200,
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    const ai = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`OpenAI ${res.status}: ${ai.error?.message || 'request failed'}`);

    let out;
    try { out = JSON.parse(ai.choices?.[0]?.message?.content || '{}'); }
    catch { return json(502, { error: 'The model returned something that was not valid JSON. Try again.' }); }

    // Clamp to the DB/attribute limits the save path enforces, so a long draft
    // can never be silently truncated later.
    return json(200, {
      description: multiline(out.description, 6000),
      author_bio: multiline(out.author_bio, 2000),
      tags: str(out.tags, 400),
      seo_title: str(out.seo_title, 220),
      meta_description: str(out.meta_description, 300),
      model: ai.model || null,
    });
  } catch (err) {
    const msg = err.name === 'AbortError' ? 'The model took too long to respond. Try again.' : err.message;
    console.error('[generate-listing-copy]', msg);
    return json(502, { error: msg });
  }
};
