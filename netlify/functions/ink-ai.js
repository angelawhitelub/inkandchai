/**
 * Ink AI — the customer-facing assistant on inkandchai.in.
 *
 * POST /.netlify/functions/ink-ai   { messages: [{role, content}, ...], page, books }
 *   → { reply, escalate }
 *
 * WHAT IT DELIBERATELY CANNOT DO
 * ------------------------------
 * It has no tools and no database reads, so it can never see a customer's
 * order. That is the whole safety design: a web visitor is anonymous — anyone
 * can type any order id — and the two failure modes that actually cost money
 * are telling someone a refund has been issued when it has not, and inventing
 * a delivery date. A bot with no order access cannot do either. Order-specific
 * questions are routed to /track/, to My Orders, or to a human on WhatsApp.
 *
 * The WhatsApp bot (whatsapp-bot.js) is the opposite: it is authenticated by
 * the phone number the message came from, so it can look orders up and even
 * cancel them. These two are not the same assistant and must not share a
 * prompt.
 *
 * KNOWLEDGE
 * ---------
 * STORE_FACTS below is the summary; the canonical text lives on /return-policy/
 * and /refund-policy/, and the numbers here are the ones the code enforces --
 * a 7-day window from delivered_at (request-return.js), a 30-minute
 * cancellation window (cancel-order.js), Rs 50 of store credit valid 6 months
 * (utils/return-refund.js). On top of that it reads bot_settings
 * .extra_instructions, the same admin-editable FAQ the WhatsApp bot uses, so
 * the team has one place to add an answer and it appears in both.
 */

const { createClient } = require('@supabase/supabase-js');
const bindings = require('../../worker/shims/runtime-bindings');

const MODEL = process.env.INK_AI_MODEL || 'gpt-4o-mini';
const TABLE = 'ink_ai_conversations';
const MAX_USER_CHARS = 700;   // a question, not an essay
const MAX_TURNS = 14;         // ~7 exchanges of context
const MAX_TOKENS = 330;

// Requests must come from our own pages. Not a security boundary -- a header is
// forgeable -- but it stops the endpoint being a free OpenAI proxy for anyone
// who reads the page source.
const ALLOWED_ORIGINS = [
  'https://inkandchai.in',
  'https://www.inkandchai.in',
];

const STORE_FACTS = `You are Ink AI, the assistant on the Ink & Chai website (inkandchai.in) — an independent Indian online bookshop.

STYLE
- Warm, plain, and brief: 2–4 sentences unless they ask for detail.
- Reply in whatever the customer wrote — English, Hindi, or Hinglish.
- An emoji now and then is fine. Never more than one per reply.
- Never make someone anxious about their money. It is safe; say so and say why.

THE SHOP
- Fiction, non-fiction, self-help, Hindi, manga, kids' books — usually 40–60% off MRP.
- Every copy is sourced from the publisher or an authorised distributor.
- Address: 6, Ansari Road, Delhi – 110002, India. Email: support@inkandchai.in.
- Instagram: @inkandchai.in

PAYING
- UPI, cards, net banking, Cash on Delivery, or Partial COD (10% online now, 90% cash on delivery).
- Free shipping on orders above ₹499; below that it is ₹40.
- Prepaid coupons: INKLOVE10 (10% above ₹499), SAVE12 (12% above ₹999), SAVE15 (15% above ₹1499). COD orders cannot use coupons.

DELIVERY — always say "after dispatch"
- Delhi/NCR 1–2 business days, other metros 2–3, rest of India 3–5.
- Track at inkandchai.in/track with the Order ID, or sign in → My Orders.

DELIVERY WENT WRONG — "nobody came", "the delivery boy never called", "it says delivered but I got nothing", "marked undelivered", "I want it delivered again". ANSWER THIS ONE, do not escalate it on the first message.
- Once a parcel is with the courier, the courier is the one who can act on it. We cannot make a delivery agent turn around; they can, and same-day, which is why this is the fastest route and not a brush-off. Say that plainly.
- Tell them to check the text messages on the phone number they entered at checkout. The courier sends delivery updates there, and that SMS carries the tracking number and the courier's own contact number.
- From that number they can ask for a re-attempt directly. Couriers re-attempt on request, usually the next working day.
- They must call from — or quote — the same phone number given on the order. The courier matches the shipment by that number, and a different number usually gets nowhere.
- The tracking number and the courier's name are also on inkandchai.in/track with their Order ID.
- Only after they have tried the courier, or if they cannot find the SMS at all, escalate so Ankit or Shila can chase it from our side.

IF A BOOK IS TAKING TIME
- Listed does not mean on our shelf. Much of the catalogue is arranged from publishers on demand, and that sourcing happens before dispatch — so a 2-day delivery estimate is not a 2-day promise on a book we are still arranging.
- If we cannot arrange it, the order is cancelled automatically within 10 days and a prepaid order is refunded in full, automatically. Nobody has to chase us.

RETURNS — 7 days from delivery
- My Orders → the order → Request Return. Our courier collects it free, usually within 48 hours.
- Returnable: wrong book, damaged or torn pages, missing pages, or a book that is not what the page described.

HOW A REFUND REACHES THEM
- Paid online: back to the same card or account automatically, 2–4 business days.
- Cash on Delivery: nothing was paid online, so we transfer it to a UPI ID or bank account they give us.
- Partial COD: only the deposit was taken online, so we send the whole amount — deposit and cash together — as ONE transfer, never split in two.
- Store credit: instant, with a ₹50 bonus on top, valid 6 months, no bank details needed.
- For COD and Partial COD we ask for a UPI ID, or account number + IFSC + account-holder name, on the return form itself. Tell them to enter it THERE. Never ask for it in this chat.

CANCELLING
- Cash on Delivery: any time before dispatch. Nothing was paid, so nothing to refund.
- Paid online: within 30 minutes of placing the order, full refund to the original method.
- Partial COD: within 30 minutes and before dispatch; the online deposit comes back to the same account.
- After dispatch it cannot be cancelled — they can refuse it at the door, or return it after delivery.

ALWAYS ANSWER — this is the job
- Answer every question you are asked. Handing someone to a human is the last resort, not the reflex: most questions here are about books, delivery, payment, returns or the shop, and you can answer all of them from what is above.
- Recommend books freely, compare them, explain what a book is about, suggest what to read next, help someone choose between two titles, talk about authors and genres. That is a bookshop conversation and it is welcome.
- If a question is only half covered above, answer the part you know and say plainly which part you are not sure about. A partial honest answer beats a handoff.
- If it is off-topic but harmless, answer it briefly and bring it back to books.
- Do not end a reply by telling someone to contact support unless one of the ESCALATE conditions below is genuinely met. "Ask our team" is not an answer.

HARD RULES — these are not style, they are correctness
- You CANNOT see any order, payment, refund or shipment. You have no lookup. Never state, guess or imply the status of someone's order, where their parcel is, when it will arrive, or that a refund has been issued, processed or paid. If they ask, say so plainly and send them to inkandchai.in/track or My Orders first — that is self-service and instant, and it is the right answer before any handoff.
- Never ask for, accept, or repeat a UPI ID, bank account number, IFSC, card number, CVV, OTP or password. If someone types one, tell them not to share it in chat.
- Never invent a date, a tracking number, a price, or a book we may not have.
- Never claim you have cancelled, refunded, replaced or changed anything. You cannot do any of it.
- Never improvise a policy. If a policy question is not covered above, say you will have it confirmed and escalate — do not guess at a rule.

WHEN TO ESCALATE — only these
1. They ask for a person, or say they are unhappy with your answer.
2. Money is in dispute: a refund they say has not arrived, a wrong amount, a payment they cannot see.
3. A damaged, wrong or missing book that needs someone to look at their specific order.
   (A failed or disputed DELIVERY is not this — send them to the courier first, as above.)
4. A policy question you genuinely cannot answer from what is above.
Anything else — answer it.

HOW TO ESCALATE
- Our human agents are Ankit and Shila. Say one of them will look at it.
- Always set expectations honestly: a human agent reviews it within 48 hours. Say "at least 48 hours" — never promise faster, and never say "right away" or "immediately".
- Give them the WhatsApp link https://wa.me/917678400508 so the query reaches Ankit and Shila with their details.
- Example: "I'll pass this to Ankit or Shila on our team — a human agent will go through it and get back to you within 48 hours. You can send the details here so it reaches them: https://wa.me/917678400508"
- End any reply that escalates with [ESCALATE] on its own, and nothing after it.`;

const CORS = (origin) => ({
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
  'Access-Control-Allow-Origin': origin || ALLOWED_ORIGINS[0],
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
});

const json = (statusCode, body, origin) => ({
  statusCode, headers: CORS(origin), body: JSON.stringify(body),
});

const LIMIT = 15;            // messages per window, per IP
const LIMIT_WINDOW_SEC = 60; // a person sends maybe one every ten seconds

/**
 * The real ceiling: a Durable Object, addressed by IP, so the count is exact
 * and survives the isolate this request happens to land in. worker/
 * rate-limiter.js records why the two lighter options were dropped.
 *
 * Returns false when the binding is absent or the call fails -- `node --test`
 * has no Worker env, and a limiter that is down must not lock out every
 * customer. The in-process backstop below still runs either way.
 */
async function overEdgeLimit(ip) {
  const ns = bindings.get('INK_AI_LIMIT');
  if (!ns || typeof ns.idFromName !== 'function') return false;
  try {
    const stub = ns.get(ns.idFromName(ip));
    const res = await stub.fetch(
      `https://ink-ai-limit/?key=${encodeURIComponent(ip)}&limit=${LIMIT}&window=${LIMIT_WINDOW_SEC}`);
    const data = await res.json();
    return data.allowed === false;
  } catch (e) {
    console.warn('[ink-ai] limiter:', e.message);
    return false;
  }
}

/**
 * Isolate-local backstop. Catches the ordinary case within one isolate and
 * costs nothing; it is not the ceiling, overEdgeLimit is. Deliberately not
 * backed by KV -- the blobs shim has no TTL, so keys would pile up forever in
 * the namespace holding unreplayed paid orders, and KV's propagation delay is
 * longer than this window anyway.
 */
const HITS = new Map();
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 12;
function throttled(ip) {
  const now = Date.now();
  const hits = (HITS.get(ip) || []).filter(t => now - t < WINDOW_MS);
  hits.push(now);
  HITS.set(ip, hits);
  if (HITS.size > 5000) HITS.clear();   // isolates are short-lived; bound the map
  return hits.length > MAX_PER_WINDOW;
}

let _faqCache = { text: '', at: 0 };
async function adminFaq() {
  if (Date.now() - _faqCache.at < 60_000) return _faqCache.text;
  try {
    const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const { data } = await db.from('bot_settings').select('extra_instructions').eq('id', 1).maybeSingle();
    _faqCache = { text: (data?.extra_instructions || '').trim(), at: Date.now() };
  } catch (e) {
    console.warn('[ink-ai] faq:', e.message);
    _faqCache = { text: _faqCache.text, at: Date.now() };   // keep the last good copy
  }
  return _faqCache.text;
}

/**
 * Every exchange is written to ink_ai_conversations. This is the "learn from
 * customers" half of the loop: you cannot add an answer to a question you never
 * saw being asked, and the questions customers actually type are nothing like
 * the ones anyone guesses in advance. Admin → Bot Instructions lists them,
 * escalated ones first, and an answer typed there lands in the same
 * bot_settings.extra_instructions the prompt already treats as authoritative.
 *
 * Never allowed to break a reply: the table may not exist yet, and a customer
 * waiting on an answer must not pay for our bookkeeping. Failures are logged
 * and swallowed.
 */
async function logExchange(row) {
  try {
    const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const { error } = await db.from(TABLE).insert(row);
    if (error) console.warn('[ink-ai] log:', error.message);
  } catch (e) {
    console.warn('[ink-ai] log:', e.message);
  }
}

/** Only role + content, only the two roles we send, and never an oversized turn. */
function sanitiseMessages(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .map(m => ({ role: m.role, content: m.content.slice(0, MAX_USER_CHARS).trim() }))
    .filter(m => m.content)
    .slice(-MAX_TURNS);
}

/**
 * Titles the page already knows about, so "do you have Ikigai?" can be answered
 * with a real price and link. The catalogue is not readable from a Worker, but
 * every product and listing page ships its own book list -- so the browser does
 * the matching and sends at most a handful of rows up. Treated as untrusted:
 * clipped hard, and the model is told these are only candidate matches.
 */
function catalogueContext(books) {
  if (!Array.isArray(books) || !books.length) return '';
  const rows = books.slice(0, 5).map((b) => {
    const title = String(b?.title || '').slice(0, 120);
    const price = String(b?.price || '').slice(0, 20);
    const url = String(b?.url || '').slice(0, 200);
    if (!title) return '';
    return `- ${title}${price ? ` — ${price}` : ''}${url.startsWith('/product/') ? ` — inkandchai.in${url}` : ''}`;
  }).filter(Boolean);
  if (!rows.length) return '';
  return '\n\nBOOKS ON THE PAGE THE CUSTOMER IS LOOKING AT (candidate matches for what they asked; '
       + 'quote a title/price only if it genuinely answers their question):\n' + rows.join('\n');
}

async function callOpenAI(messages) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY not set');
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, messages, max_tokens: MAX_TOKENS, temperature: 0.4 }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${data?.error?.message || 'unknown'}`);
  return (data.choices?.[0]?.message?.content || '').trim();
}

exports.handler = async (event) => {
  const origin = event.headers?.origin || event.headers?.Origin || '';
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : '';

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS(allowed), body: '' };

  // Deploy check. Says whether the rate-limit binding actually arrived, which is
  // otherwise invisible: a missing limiter degrades silently to the in-process
  // backstop, and the only other way to find out is to be over-billed. Booleans
  // and a model name -- nothing here is a secret.
  if (event.httpMethod === 'GET' && (event.queryStringParameters || {}).probe === '1') {
    const ns = bindings.get('INK_AI_LIMIT');
    return json(200, {
      ok: true,
      model: MODEL,
      limiter: !!(ns && typeof ns.idFromName === 'function'),
      limit: `${LIMIT} per ${LIMIT_WINDOW_SEC}s per IP`,
      key_configured: !!process.env.OPENAI_API_KEY,
    }, allowed);
  }

  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' }, allowed);

  // An empty Origin is a same-origin form post or a curl; a foreign one is
  // someone else's page spending our tokens.
  if (origin && !allowed) return json(403, { error: 'Forbidden' }, '');

  const ip = event.headers?.['cf-connecting-ip'] || event.headers?.['x-forwarded-for'] || 'unknown';
  if (await overEdgeLimit(ip) || throttled(ip)) {
    return json(429, { reply: 'One moment \u2014 too many messages at once. Try again in a minute.' }, allowed);
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: 'Bad JSON' }, allowed); }

  const messages = sanitiseMessages(body.messages);
  if (!messages.length || messages[messages.length - 1].role !== 'user') {
    return json(400, { error: 'No question.' }, allowed);
  }

  try {
    const faq = await adminFaq();
    let system = STORE_FACTS;
    if (faq) {
      // The team's own answers win over the defaults, and go first -- appended
      // at the end they get drowned out by the length of everything above.
      system = '⚠️ ANSWERS SET BY THE INK & CHAI TEAM. These are authoritative; '
             + 'where anything below disagrees with them, these win:\n' + faq
             + '\n\n— — — (general guidance follows) — — —\n\n' + STORE_FACTS;
    }
    system += catalogueContext(body.books);

    const reply = await callOpenAI([{ role: 'system', content: system }, ...messages]);
    if (!reply) return json(502, { error: 'Empty reply' }, allowed);

    const escalate = reply.includes('[ESCALATE]');
    const clean = reply.replace('[ESCALATE]', '').trim();

    await logExchange({
      session_id: String(body.session_id || '').slice(0, 64) || null,
      question: messages[messages.length - 1].content,
      answer: clean,
      escalated: escalate,
      page_url: String(body.page?.url || '').slice(0, 300) || null,
      turn: messages.filter(m => m.role === 'user').length,
    });

    return json(200, { reply: clean, escalate }, allowed);
  } catch (err) {
    console.error('[ink-ai]', err.message);
    // Still a question a customer asked. Losing it because our model call failed
    // would hide exactly the periods worth reviewing -- an outage is when people
    // ask the same thing twice and give up.
    await logExchange({
      session_id: String(body.session_id || '').slice(0, 64) || null,
      question: messages[messages.length - 1].content,
      answer: null,
      escalated: true,
      page_url: String(body.page?.url || '').slice(0, 300) || null,
      turn: messages.filter(m => m.role === 'user').length,
    });
    return json(502, {
      error: 'unavailable',
      reply: 'Sorry — I could not answer that just now. Send it to Ankit and Shila on our '
           + 'team at https://wa.me/917678400508 — a human agent goes through every query '
           + 'within 48 hours.',
      escalate: true,
    }, allowed);
  }
};

module.exports.TABLE = TABLE;
module.exports.STORE_FACTS = STORE_FACTS;        // exported for the tests
module.exports.sanitiseMessages = sanitiseMessages;
module.exports.catalogueContext = catalogueContext;
