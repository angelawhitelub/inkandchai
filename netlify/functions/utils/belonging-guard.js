// "Belonging: A Journey of Love" (Sonia Gandhi) conversations in the WhatsApp bot.
//
// Owner rule, 2026-11-17: customers asking about this book, and customers who
// have ordered it, are never given the team's WhatsApp number 9217175546. The
// bot answers them itself: the product page clearly said it was the PAPERBACK
// edition (not hardcover), and the copy is an official HarperCollins India copy.
//
// The prompt tells the model; scrub() enforces it in code, because the default
// prompt shares that number in a dozen places and a model can still slip.

const TOPIC_RE = /\bbelonging\b|journey\s+of\s+love|sonia\s+gandhi/i;
const SLUG = 'belonging-a-journey-of-love-by-sonia-gandhi';

// The number in any spelling: 9217175546, 92171 75546, +91-92171-75546, 919217175546.
const D = '[\\s-]*';
const NUMBER_RE = new RegExp(`(?:\\+?${D}9${D}1${D})?${'9217175546'.split('').join(D)}`);
const LINK_RE = /(?:https?:\/\/)?(?:api\.)?wa\.me\/\S*/i;

// Owner, 25 Nov 2026: the number is never given to ANY customer; a person
// replies in this chat instead (utils/agent-queue).
const IN_CHAT = require('./agent-queue').WAIT_TEXT;

const PROMPT = `

📕 "BELONGING: A JOURNEY OF LOVE" (Sonia Gandhi) — OWNER RULE FOR THIS CONVERSATION. This overrides everything above.
This customer is asking about, or has ordered, "Belonging: A Journey of Love".
- NEVER share any phone number or wa.me link with them — not 9217175546, not any other — even if they ask for a number, a call, a manager or "a human". Wherever the guidance above says to share https://wa.me/919217175546, instead say our team will reply to them right here in this chat, and end your message with [ESCALATE].
- If they say they expected a HARDCOVER, or the binding is not what they wanted: apologise for the confusion, and politely explain that the product page clearly mentioned it is the PAPERBACK edition, not the hardcover.
- If they doubt the copy (fake, duplicate, pirated, print quality, "is it original?"): reassure them that it is an official copy published by HarperCollins India.
- Say these two points only when they fit what the customer said; do not volunteer them otherwise. Be warm and brief, never argue.
- Returns, replacements and order status still follow the normal rules above.`;

/** Does this text mention the book? */
function mentionsBook(text) {
  return TOPIC_RE.test(String(text || ''));
}

/** Does an order's cart contain the book? */
function orderHasBook(order) {
  const items = Array.isArray(order && order.cart_items) ? order.cart_items : [];
  return items.some((it) => it && (String(it.slug || '').includes(SLUG)
    || /journey\s+of\s+love/i.test(String(it.title || it.name || ''))
    || /^belonging\b/i.test(String(it.title || it.name || '').trim())));
}

/**
 * Has this phone ever ordered the book? Reads only cart_items, so the check is
 * cheap enough for every message. Any failure counts as "no": the prompt then
 * falls back to the message/history check, and scrub() still runs if that hits.
 */
async function hasOrderedBook(db, phone) {
  try {
    const ten = String(phone || '').replace(/\D/g, '').slice(-10);
    if (ten.length !== 10) return false;
    const { data, error } = await db.from('orders')
      .select('cart_items')
      .or(`customer_phone.eq.${ten},customer_phone.eq.91${ten},customer_phone.eq.+91${ten}`)
      .order('created_at', { ascending: false })
      .limit(50);
    if (error) { console.warn('[belonging] order check failed:', error.message); return false; }
    return (data || []).some(orderHasBook);
  } catch (e) {
    console.warn('[belonging] order check failed:', e.message);
    return false;
  }
}

/**
 * Is this conversation covered by the rule? The current message, the recent
 * history (both sides: the bot may have named the book), the order context
 * already attached, or any order of theirs containing the book.
 */
async function applies({ userMessage, history = [], extraContext = '', db = null, phone = '' }) {
  if (mentionsBook(userMessage)) return true;
  if (history.slice(-30).some((m) => mentionsBook(m && m.content))) return true;
  if (mentionsBook(extraContext)) return true;
  return db ? hasOrderedBook(db, phone) : false;
}

/**
 * Remove the number and any wa.me link from a reply. A sentence that carried
 * one is dropped whole (a bare "👉" left behind reads as broken), and the
 * customer is told the team will answer in this chat instead.
 */
function scrub(reply) {
  const original = String(reply || '');
  if (!NUMBER_RE.test(original) && !LINK_RE.test(original)) return original;
  // [ESCALATE] can sit in the same sentence as the link; keep it either way.
  const escalate = original.includes('[ESCALATE]');
  const text = original.replace(/\[ESCALATE\]/g, '').trim();
  let dropped = false;
  const lines = text.split('\n').map((line) => {
    if (!NUMBER_RE.test(line) && !LINK_RE.test(line)) return line;
    const kept = line.split(/(?<=[.!?])\s+/).filter((s) => {
      const bad = NUMBER_RE.test(s) || LINK_RE.test(s);
      if (bad) dropped = true;
      return !bad;
    });
    return kept.length ? kept.join(' ') : null;
  }).filter((l) => l !== null);
  let out = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  if (dropped && !/this chat|right here|talk to you here|next available agent/i.test(out)) out = `${out}\n\n${IN_CHAT}`.trim();
  // A reply that tried to send them to the team number needs a person: queue it.
  return escalate || dropped ? `${out} [ESCALATE]` : out;
}

module.exports = { PROMPT, IN_CHAT, mentionsBook, orderHasBook, hasOrderedBook, applies, scrub, NUMBER_RE, LINK_RE };
