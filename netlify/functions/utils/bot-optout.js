/**
 * WhatsApp opt-out ("STOP") handling.
 *
 * STOP is the universal opt-out keyword on WhatsApp. 18 customers had sent it
 * and the bot answered every one of them with a cheerful greeting — which is
 * both wrong to the person asking to be left alone, and a quality-rating risk
 * on the number the whole order flow depends on.
 *
 * WHY NO NEW COLUMN
 *   Opt-out state is DERIVED from bot_messages, which already stores every
 *   inbound message: whichever came last, an opt-out keyword or an opt-in one,
 *   wins. That means no migration to forget to run (sql/refund_tracking.sql's
 *   last line is still unapplied months later), no second source of truth to
 *   drift, and it works retroactively for the 18 people who already said STOP.
 *
 * WHAT IT DOES AND DOESN'T SILENCE
 *   Silenced: the AI assistant, and marketing broadcasts.
 *   NOT silenced: transactional notices about an order they actually placed —
 *   shipped, out for delivery, refund issued. Someone who opts out of a chatbot
 *   has not asked to stop being told where their parcel is, and withholding
 *   that would cause more harm than the opt-out prevents.
 */

// Whole-message matches only. A customer writing "please stop sending me the
// wrong book" is complaining, not unsubscribing, and silencing them would be
// the worst possible outcome — so substring matching is deliberately avoided.
const OPT_OUT = new Set([
  'stop', 'stop all', 'stopall', 'unsubscribe', 'unsub',
  'opt out', 'optout', 'opt-out', 'cancel subscription',
  'do not message', "don't message", 'dont message',
  'do not message me', "don't message me", 'dont message me',
  'remove me', 'block', 'leave me alone',
  'band karo', 'message mat bhejo', 'mat bhejo',
]);

const OPT_IN = new Set([
  'start', 'unstop', 'resume', 'subscribe', 'opt in', 'optin', 'opt-in',
  'start again', 'continue',
]);

/** Strip punctuation/emoji and fold case, so "STOP." and "stop!" both match. */
function normalizeKeyword(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[\p{P}\p{S}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const isOptOutKeyword = (text) => OPT_OUT.has(normalizeKeyword(text));
const isOptInKeyword = (text) => OPT_IN.has(normalizeKeyword(text));

/**
 * Latest intent wins. Returns 'out', 'in', or null when neither appears.
 * `messages` must be newest-first.
 */
function optStateFromHistory(messages) {
  for (const m of Array.isArray(messages) ? messages : []) {
    const text = typeof m === 'string' ? m : m?.message;
    if (isOptOutKeyword(text)) return 'out';
    if (isOptInKeyword(text)) return 'in';
  }
  return null;
}

/**
 * Is this number currently opted out?
 *
 * Fails OPEN (false) on any database error: a lookup failure must not silence
 * a customer who never asked for silence. The opposite failure — one extra
 * reply to someone who opted out — is the lesser harm and self-corrects the
 * moment the query works again.
 */
async function isOptedOut(db, phone) {
  if (!db || !phone) return false;
  try {
    const { data, error } = await db
      .from('bot_messages')
      .select('message')
      .eq('customer_phone', phone)
      .eq('role', 'user')
      .order('created_at', { ascending: false })
      .limit(40);
    if (error) throw error;
    return optStateFromHistory(data) === 'out';
  } catch (e) {
    console.error('[optout] lookup failed, treating as opted IN:', e.message);
    return false;
  }
}

/** Last 10 digits — bot_messages stores 919XXXXXXXXX, broadcasts may not. */
const phoneKey = (p) => String(p || '').replace(/\D/g, '').slice(-10);

/**
 * Every phone currently opted out, as a Set of 10-digit keys — for broadcasts,
 * where asking per-recipient would be thousands of queries.
 *
 * SQL narrows with a substring match; the exact whole-message rule is applied
 * in JS afterwards, so "please stop sending the wrong book" is fetched and then
 * correctly ignored.
 *
 * Fails CLOSED-ish on error: returns an empty set, i.e. nobody is filtered.
 * That matches isOptedOut()'s fail-open stance — but a broadcast caller should
 * treat a thrown error as a reason not to send at all.
 */
async function optedOutPhoneSet(db) {
  const out = new Set();
  if (!db) return out;
  const LIKE = ['stop', 'unsub', 'subscribe', 'opt', 'start', 'resume', 'continue',
    'block', 'remove me', 'leave me alone', 'mat bhejo', 'band karo', 'message']
    .map(k => `message.ilike.%${k}%`).join(',');
  const { data, error } = await db
    .from('bot_messages')
    .select('customer_phone,message,created_at')
    .eq('role', 'user')
    .or(LIKE)
    .order('created_at', { ascending: false })
    .limit(5000);
  if (error) throw new Error(`opt-out lookup failed: ${error.message}`);

  const decided = new Set();
  for (const row of data || []) {
    const key = phoneKey(row.customer_phone);
    if (!key || decided.has(key)) continue;   // newest-first: first hit wins
    if (isOptOutKeyword(row.message)) { decided.add(key); out.add(key); }
    else if (isOptInKeyword(row.message)) { decided.add(key); }
  }
  return out;
}

// Sent exactly once, on the message that opts them out. Silence with no
// acknowledgement reads as a broken bot and generates a support ticket; the
// single confirmation is the standard, and it names the way back.
const OPT_OUT_CONFIRMATION =
  "You've been unsubscribed. Our assistant won't message you again.\n\n"
  + "You'll still get updates about orders you've placed (dispatch, delivery, refunds).\n\n"
  + 'Reply START any time to turn the assistant back on.';

const OPT_IN_CONFIRMATION =
  "You're subscribed again — our assistant is back. How can we help? 📚";

module.exports = {
  isOptOutKeyword, isOptInKeyword, optStateFromHistory, isOptedOut,
  optedOutPhoneSet, phoneKey,
  normalizeKeyword, OPT_OUT_CONFIRMATION, OPT_IN_CONFIRMATION, OPT_OUT, OPT_IN,
};
