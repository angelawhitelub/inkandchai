/**
 * When the courier reports a failed delivery, ask the customer on WhatsApp what
 * they want, and keep the answers for the owner (owner's request, 5 Nov 2026).
 *
 *   Template  "Do you still want this order, or would you like to cancel it?"
 *     Cancel → recorded. Nothing is cancelled or refunded here: the parcel is
 *              with the courier, and that decision stays with the owner.
 *     Want   → "Why was the delivery missed?"
 *       I requested future delivery → asks which date, recorded.
 *       Nobody came for delivery    → asks for an alternate number, recorded.
 *
 * Decided in code, like the RTO re-ship offer: the model never records an answer.
 * Each order is asked once, however many attempts fail.
 *
 * Everything lives on the order row (sql/orders_delivery_failed_ask.sql):
 *   delivery_failed_asked_at     when the template went out (the once-only claim)
 *   delivery_failed_state        asked → reason → date | number → closed
 *                                ('backlog' = already failed when this went live)
 *   delivery_failed_choice       want | cancel
 *   delivery_failed_reason       future_delivery | nobody_came
 *   delivery_failed_alt_phone    the alternate number, 10 digits
 *   delivery_failed_future_date  YYYY-MM-DD, or their own words ("next week")
 *   delivery_failed_answered_at  their first answer
 *
 * Nothing is sent until WHATSAPP_DELIVERY_FAILED_TEMPLATE names an approved
 * template: an image header, {{1}} first name, {{2}} order id, {{3}} books, with the
 * two quick-reply buttons below, worded exactly.
 *
 * An image-header template cannot go out without an image, and Meta fetches it
 * after accepting the send, so a bad one loses the message. The first book's cover
 * is checked first; no cover, or any doubt, sends the store image instead.
 */

const { booksLine } = require('./rto-reship');
const { whatsappCoverUrl, isJpeg } = require('./order-cover');

const FALLBACK_IMAGE = 'https://inkandchai.in/images/og-default.jpg';

const WANT_BUTTON = 'I want this order';
const CANCEL_BUTTON = 'Cancel this order';
const FUTURE_BUTTON = 'Future delivery';
const NOBODY_BUTTON = 'Nobody came';
const OWN_BUTTONS = new Set([WANT_BUTTON, CANCEL_BUTTON, FUTURE_BUTTON, NOBODY_BUTTON].map((b) => b.toLowerCase()));

const OPEN_STATES = ['asked', 'reason', 'date', 'number'];
// An answer days later is about something else.
const OPEN_MS = 7 * 86400000;
const MAX_ORDER_AGE_DAYS = 30;

const FAILED = /exception|undelivered|ndr|failed/;

const last10 = (p) => String(p || '').replace(/\D/g, '').slice(-10);
const idOf = (o) => o.razorpay_order_id || o.id;

function askTemplate() {
  return String(process.env.WHATSAPP_DELIVERY_FAILED_TEMPLATE || '').trim();
}

function missingColumn(error) {
  return !!error && /delivery_failed_/.test(String(error.message || error));
}

/** Our own button labels, so "Cancel this order" never reaches the COD confirm handler. */
function isOwnButton(label) {
  return OWN_BUTTONS.has(String(label || '').trim().toLowerCase());
}

/** Same meaning as isDeliveryFailed in admin, narrowed to orders that were out for delivery. */
function askEligible(order) {
  const courier = String(order?.last_courier_status || '').toLowerCase().trim();
  if (String(order?.status || '') !== 'out_for_delivery') return { ok: false, reason: `status ${order?.status}` };
  if (courier.startsWith('lookup failed') || !FAILED.test(courier)) return { ok: false, reason: `courier says ${courier || 'nothing'}` };
  if (order.delivery_failed_asked_at) return { ok: false, reason: 'already asked' };
  if (order.cancellation_requested_at || order.late_cancel_at) return { ok: false, reason: 'customer already asked to cancel' };
  if (last10(order.customer_phone).length < 10) return { ok: false, reason: 'no phone' };
  return { ok: true };
}

function askParams(order) {
  const first = String(order.customer_name || '').trim().split(/\s+/)[0] || 'there';
  return [first, String(idOf(order)), booksLine(order, 60)];
}

function askedText(params) {
  return `Hi ${params[0]}, the courier could not deliver your order ${params[1]} (${params[2]}). Do you still want this order, or would you like to cancel it?`;
}

async function headerImageFor(order, isJpegFn = isJpeg) {
  const cover = whatsappCoverUrl(order.cart_items);
  return cover && await isJpegFn(cover) ? cover : FALLBACK_IMAGE;
}

/**
 * Asks every eligible order not asked yet.
 * deps { supabase, send({to, template, params}), isOptedOut(db, phone), logMessage?, now }
 */
async function sendAsks(deps, opts = {}) {
  const { supabase } = deps;
  const now = deps.now ? deps.now() : Date.now();
  const template = opts.template != null ? opts.template : askTemplate();
  const dryRun = !!opts.dryRun;
  const max = opts.max || 40;
  const summary = { dry_run: dryRun, enabled: !!template, sent: [], would_send: [], skipped: [], failed: [] };
  if (!template && !dryRun) return summary;

  const { data, error } = await supabase.from('orders')
    .select('*')
    .eq('status', 'out_for_delivery')
    .is('delivery_failed_asked_at', null)
    .or('last_courier_status.ilike.%exception%,last_courier_status.ilike.%undelivered%,last_courier_status.ilike.%ndr%,last_courier_status.ilike.%failed%')
    .gte('created_at', new Date(now - MAX_ORDER_AGE_DAYS * 86400000).toISOString())
    .order('created_at', { ascending: true })
    .limit(300);
  if (error) {
    if (missingColumn(error)) { summary.error = 'run sql/orders_delivery_failed_ask.sql first'; return summary; }
    throw new Error(error.message);
  }

  for (const order of data || []) {
    const id = idOf(order);
    const elig = askEligible(order);
    if (!elig.ok) { summary.skipped.push({ order_id: id, reason: elig.reason }); continue; }
    if (deps.isOptedOut && await deps.isOptedOut(supabase, order.customer_phone)) {
      summary.skipped.push({ order_id: id, reason: 'customer opted out of WhatsApp' });
      continue;
    }
    const params = askParams(order);
    if (dryRun) { summary.would_send.push({ order_id: id, params, image: whatsappCoverUrl(order.cart_items) || FALLBACK_IMAGE }); continue; }
    if (summary.sent.length + summary.failed.length >= max) { summary.skipped.push({ order_id: id, reason: 'per-run cap; next run' }); continue; }

    // Claim first: two overlapping runs cannot both message the customer.
    const { data: claimed, error: claimErr } = await supabase.from('orders')
      .update({ delivery_failed_asked_at: new Date(now).toISOString(), delivery_failed_state: 'asked' })
      .eq('id', order.id).eq('status', 'out_for_delivery').is('delivery_failed_asked_at', null)
      .select('id');
    if (claimErr || !claimed || !claimed.length) {
      summary.skipped.push({ order_id: id, reason: claimErr ? `claim failed: ${claimErr.message}` : 'changed since it was read' });
      continue;
    }
    const headerImageUrl = await headerImageFor(order, deps.isJpeg);
    const res = await deps.send({ to: order.customer_phone, template, params, headerImageUrl });
    if (res && res.ok) {
      summary.sent.push({ order_id: id });
      if (deps.logMessage) await deps.logMessage(order.customer_phone, askedText(params)).catch(() => {});
    } else {
      // Not delivered: release the claim, and the next run tries again.
      summary.failed.push({ order_id: id, error: String((res && (res.data?.error?.message || res.error || res.status)) || 'send failed').slice(0, 160) });
      await supabase.from('orders')
        .update({ delivery_failed_asked_at: null, delivery_failed_state: null })
        .eq('id', order.id).eq('delivery_failed_state', 'asked')
        .then(() => {}, () => {});
    }
  }
  return summary;
}

// ── Reading the answers ──────────────────────────────────────────────────────
// A bare "no" only means cancel as the answer to "do you still want it?": on its
// own line, so "no one came" and "no courier came" are not read as cancelling.
const BARE_NO = /^(no|n|nope|nah|nahi|nahin|nhi|mat|no thanks|❌|👎)[.!]*$/;
const SAYS_CANCEL = /\bcancel\b|\bdon'?t (want|need)\b|\bdo not (want|need)\b|\bnot? (needed|required)\b|\bno need\b|\bnahi chahiye\b|\bnhi chahiye\b|\bnahin chahiye\b/;

function choiceOf(text) {
  const t = String(text || '').trim().toLowerCase();
  if (!t || t.length > 80) return null;
  if (SAYS_CANCEL.test(t) || BARE_NO.test(t)) return 'cancel';
  if (/\bi (still )?(want|need)\b|\bwant (it|this|the order)\b|\bchahiye\b|\bdeliver (it|again)\b|^(yes|y|yeah|yup|yep|ok|okay|sure|haan|haanji|han|ha|ji|✅|👍)(\s|[.!,]|$)/.test(t)) return 'want';
  return null;
}

function reasonOf(text) {
  const t = String(text || '').trim().toLowerCase();
  if (!t || t.length > 120) return null;
  if (t === '2' || /\bno ?(one|body)\b|\bnobody\b|\bkoi nahi\b|\bkoi nhi\b|\bkoi nahin\b|\bnot (come|came)\b|\b(didn'?t|did not) (come|visit|call)\b|\bnahi aay|\bnhi aay|\bnahin aay/.test(t)) return 'nobody_came';
  if (t === '1' || /\bfuture\b|\blater\b|\banother (day|date)\b|\bnext (day|week)\b|\bbaad me|\breschedul|\bdate\b|\brequested\b/.test(t)) return 'future_delivery';
  return null;
}

/** A 10-digit Indian mobile anywhere in the message, or ''. */
function numberOf(text) {
  const m = String(text || '').match(/(?:\+?91[\s-]*)?\b([6-9]\d{4})[\s-]?(\d{5})\b/);
  return m ? `${m[1]}${m[2]}` : '';
}

function noNumber(text) {
  const t = String(text || '').trim().toLowerCase();
  return t.length <= 40 && /^(no|nope|nah|na|nahi|nahin|nhi|none|nil|same|this)\b|\bsame number\b|\bno (other|alternate|another)\b/.test(t);
}

// ── The date they want it delivered ──────────────────────────────────────────
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const WEEKDAYS = [
  /\b(sunday|sun|ravivar|raviwar|itwar|etwar)\b/, /\b(monday|mon|somvar|somwar)\b/, /\b(tuesday|tue|tues|mangalvar|mangalwar|mangal)\b/,
  /\b(wednesday|wed|budhvar|budhwar|budh)\b/, /\b(thursday|thu|thurs|guruvar|guruwar|brihaspativar)\b/,
  /\b(friday|fri|shukravar|shukrawar|shukra)\b/, /\b(saturday|sat|shanivar|shaniwar|shani)\b/,
];
const FUTURE_DATE_DAYS = 90;
const DAY_MS = 86400000;
// A time they gave in words: worth keeping as they said it, not a date to work out.
const VAGUE_TIME = /\bnext (week|month|weekend)\b|\bthis (week|weekend|month)\b|\bweekend\b|\bafter \d+ (days?|weeks?)\b|\b\d+ (din|days?|weeks?) (baad|bad|later|after)\b|\bagle (hafte|mahine)\b|\bagla (hafta|mahina)\b|\bend of (the )?(week|month)\b|\bmonth end\b|\bdiwali\b/;

const isoOf = (ms) => new Date(ms).toISOString().slice(0, 10);

/**
 * Reads a date from the customer's words, in IST. bareDay lets "15" or "15th" mean
 * a day of the month: only where we have just asked for a date, because "2" at the
 * reason step picks an option.
 * @returns {{iso}|{bad:true}|{words}|null}  bad = a real date, but not an upcoming one
 */
function futureDateOf(text, nowMs = Date.now(), { bareDay = false } = {}) {
  const t = String(text || '').trim().toLowerCase();
  if (!t || t.length > 80) return null;
  const istNow = new Date(nowMs + 330 * 60000);
  const today = Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate());
  const after = (days) => ({ iso: isoOf(today + days * DAY_MS) });

  if (/\bday after tomorrow\b|\bparso\b/.test(t)) return after(2);
  if (/\btomorrow\b|\bkal\b/.test(t)) return after(1);
  if (/\btoday\b|\baaj\b/.test(t)) return after(0);

  // Without a year, a date already gone means next year, which is too far to be
  // what they meant, and is sent back as not upcoming.
  const pick = (day, month, year) => {
    if (month < 0 || month > 11 || day < 1 || day > 31) return null;
    let y = year == null ? istNow.getUTCFullYear() : (year < 100 ? 2000 + year : year);
    let ms = Date.UTC(y, month, day);
    if (new Date(ms).getUTCDate() !== day) return null;
    if (year == null && ms < today) { y += 1; ms = Date.UTC(y, month, day); }
    if (ms < today || ms > today + FUTURE_DATE_DAYS * DAY_MS) return { bad: true };
    return { iso: isoOf(ms) };
  };

  const monthName = '(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*';
  let m = t.match(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s*(?:of\\s+)?${monthName}\\.?(?:[\\s,]+(\\d{2,4}))?\\b`));
  if (m) return pick(+m[1], MONTHS.indexOf(m[2]), m[3] ? +m[3] : null) || null;
  m = t.match(new RegExp(`\\b${monthName}\\.?\\s*(\\d{1,2})(?:st|nd|rd|th)?(?:[\\s,]+(\\d{2,4}))?\\b`));
  if (m) return pick(+m[2], MONTHS.indexOf(m[1]), m[3] ? +m[3] : null) || null;
  // Day first, the way dates are written in India.
  m = t.match(/\b(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2,4}))?\b/);
  if (m) return pick(+m[1], +m[2] - 1, m[3] ? +m[3] : null) || null;

  if (VAGUE_TIME.test(t)) return { words: String(text).trim().replace(/\s+/g, ' ').slice(0, 60) };

  for (let d = 0; d < 7; d++) {
    if (WEEKDAYS[d].test(t)) {
      const ahead = (d - new Date(today).getUTCDay() + 7) % 7;
      return after(ahead === 0 ? 7 : ahead);
    }
  }

  if (bareDay) {
    m = t.match(/^(?:on\s+)?(\d{1,2})(?:st|nd|rd|th)?(?:\s*(?:ko|tareekh|tarikh|date))?[.!]*$/);
    if (m) {
      const day = +m[1];
      const thisMonth = istNow.getUTCDate() <= day ? istNow.getUTCMonth() : istNow.getUTCMonth() + 1;
      return pick(day, thisMonth % 12, thisMonth > 11 ? istNow.getUTCFullYear() + 1 : null);
    }
  }
  return null;
}

/** They can't say when. Still an answer, so the question closes. */
function noDate(text) {
  const t = String(text || '').trim().toLowerCase();
  return t.length <= 40 && /^(no|nope|nah|na|nahi|nahin|nhi)[.!]*$|\bnot sure\b|\bdon'?t know\b|\bpata nahi\b|\bpata nhi\b|\bany ?(day|time)\b|\bkabhi bhi\b/.test(t);
}

function dateLabel(iso) {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-IN', { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' });
}

/**
 * The customer's question waiting for an answer: one they are midway through
 * first, then the oldest unanswered.
 */
async function findOpenAsk(supabase, phone, nowMs = Date.now()) {
  const ten = last10(phone);
  if (ten.length < 10) return null;
  const { data, error } = await supabase.from('orders')
    .select('*')
    .in('delivery_failed_state', OPEN_STATES)
    .in('status', ['shipped', 'out_for_delivery'])
    .or(`customer_phone.eq.${ten},customer_phone.eq.91${ten},customer_phone.eq.+91${ten}`)
    .gte('delivery_failed_asked_at', new Date(nowMs - OPEN_MS).toISOString())
    .order('delivery_failed_asked_at', { ascending: true })
    .limit(10);
  if (error) {
    if (!missingColumn(error)) console.warn('[delivery-failed] open ask lookup:', error.message);
    return null;
  }
  const rows = data || [];
  return rows.find((o) => o.delivery_failed_state !== 'asked') || rows[0] || null;
}

async function move(supabase, order, fields) {
  const { data, error } = await supabase.from('orders')
    .update({
      ...fields,
      ...(order.delivery_failed_answered_at ? {} : { delivery_failed_answered_at: new Date().toISOString() }),
    })
    .eq('id', order.id).eq('delivery_failed_state', order.delivery_failed_state)
    .select('id');
  if (error) throw new Error(error.message);
  return !!(data && data.length);
}

const REASON_BODY = (id) => `Thank you! Why was the delivery of order ${id} missed?\n\n• I requested future delivery\n• Nobody came for delivery`;

/**
 * Answers a reply in code. Returns { handled, reply, buttons? }; handled false
 * lets the AI answer instead, with contextFor() telling it what is open.
 */
async function handleReply(deps, text, order) {
  const { supabase } = deps;
  const nowMs = deps.now ? deps.now() : Date.now();
  const id = idOf(order);
  const state = order.delivery_failed_state;
  const done = (reply) => ({ handled: true, reply });
  // Future delivery: straight to the date if they already gave one, else ask.
  const futureDelivery = async (fields, found) => {
    if (found && found.iso) {
      if (!await move(supabase, order, { ...fields, delivery_failed_reason: 'future_delivery', delivery_failed_future_date: found.iso, delivery_failed_state: 'closed' })) return { handled: false };
      return done(`Thank you, we've noted ${dateLabel(found.iso)} as your delivery date for order ${id}. Our team will follow it up with the courier.`);
    }
    if (found && found.words) {
      if (!await move(supabase, order, { ...fields, delivery_failed_reason: 'future_delivery', delivery_failed_future_date: found.words, delivery_failed_state: 'closed' })) return { handled: false };
      return done(`Thank you, we've noted "${found.words}" as your delivery time for order ${id}. Our team will follow it up with the courier.`);
    }
    if (!await move(supabase, order, { ...fields, delivery_failed_reason: 'future_delivery', delivery_failed_state: 'date' })) return { handled: false };
    return done(`Which date should we deliver order ${id}? For example: 12 Nov.`);
  };

  if (state === 'number') {
    const number = numberOf(text);
    if (number) {
      if (!await move(supabase, order, { delivery_failed_alt_phone: number, delivery_failed_state: 'closed' })) return { handled: false };
      return done(`Thank you! We've saved ${number} as the alternate number for order ${id}, and our team will pass it to the courier.`);
    }
    if (noNumber(text)) {
      if (!await move(supabase, order, { delivery_failed_state: 'closed' })) return { handled: false };
      return done(`No problem. We've noted that the courier did not come for order ${id}, and our team will follow it up with them.`);
    }
    return { handled: false };
  }

  // A phone number while the question is open can only be the alternate number.
  const typedNumber = state === 'date' ? '' : numberOf(text);
  if (typedNumber) {
    if (!await move(supabase, order, { delivery_failed_choice: 'want', delivery_failed_alt_phone: typedNumber, delivery_failed_state: 'closed' })) return { handled: false };
    return done(`Thank you! We've saved ${typedNumber} as the alternate number for order ${id}, and our team will pass it to the courier.`);
  }

  // Cancel is accepted at any step, since changing their mind is an answer too,
  // but after the first only when they say so: "no" does not mean cancel there.
  const short = String(text || '').trim().toLowerCase();
  if (state === 'asked' ? choiceOf(text) === 'cancel' : (short.length <= 80 && SAYS_CANCEL.test(short))) {
    if (!await move(supabase, order, { delivery_failed_choice: 'cancel', delivery_failed_reason: null, delivery_failed_future_date: null, delivery_failed_state: 'closed' })) return { handled: false };
    return done(`Understood. We've noted that you don't want order ${id}, and our team will take it from here. Please don't accept the parcel if the courier comes again.`);
  }

  if (state === 'asked') {
    // "Nobody came" answers both questions at once.
    const already = short.length > 1 ? reasonOf(text) : null;
    if (already === 'future_delivery') return futureDelivery({ delivery_failed_choice: 'want' }, futureDateOf(text, nowMs));
    if (already === 'nobody_came') {
      if (!await move(supabase, order, { delivery_failed_choice: 'want', delivery_failed_reason: already, delivery_failed_state: 'number' })) return { handled: false };
      return done(`Sorry about that. Please send an alternate phone number the courier can call for order ${id}. If there isn't one, just reply NO.`);
    }
    if (choiceOf(text) !== 'want') return { handled: false };
    if (!await move(supabase, order, { delivery_failed_choice: 'want', delivery_failed_state: 'reason' })) return { handled: false };
    return { handled: true, reply: REASON_BODY(id), buttons: [FUTURE_BUTTON, NOBODY_BUTTON] };
  }

  if (state === 'reason') {
    const reason = reasonOf(text);
    // "He came on Monday" names a day but is not asking for one. Without a word
    // for later, a date only counts when it is all they said.
    const narrated = /\b(came|come|aaya|aya|aayi|aye|called|visited)\b/i.test(String(text));
    const found = reason === 'nobody_came' || narrated ? null : futureDateOf(text, nowMs);
    const justADate = found && !found.bad && String(text).trim().length <= 24;
    if (reason === 'future_delivery' || justADate) return futureDelivery({}, found);
    if (reason === 'nobody_came') {
      if (!await move(supabase, order, { delivery_failed_reason: reason, delivery_failed_state: 'number' })) return { handled: false };
      return done(`Sorry about that. Please send an alternate phone number the courier can call for order ${id}. If there isn't one, just reply NO.`);
    }
    return { handled: false };
  }

  if (state === 'date') {
    const found = futureDateOf(text, nowMs, { bareDay: true });
    if (found && found.iso) {
      if (!await move(supabase, order, { delivery_failed_future_date: found.iso, delivery_failed_state: 'closed' })) return { handled: false };
      return done(`Thank you, we've noted ${dateLabel(found.iso)} as your delivery date for order ${id}. Our team will follow it up with the courier.`);
    }
    if (found && found.words) {
      if (!await move(supabase, order, { delivery_failed_future_date: found.words, delivery_failed_state: 'closed' })) return { handled: false };
      return done(`Thank you, we've noted "${found.words}" as your delivery time for order ${id}. Our team will follow it up with the courier.`);
    }
    if (found && found.bad) return done(`That date doesn't look right. Please send an upcoming date for order ${id}, for example: 12 Nov.`);
    if (noDate(text)) {
      if (!await move(supabase, order, { delivery_failed_state: 'closed' })) return { handled: false };
      return done(`No problem. We've noted that you requested a later delivery for order ${id}, and our team will follow it up with the courier.`);
    }
    return { handled: false };
  }
  return { handled: false };
}

/** A line for the AI, so a question in the middle of this is answered in context. */
function contextFor(order) {
  if (!order) return '';
  const id = idOf(order);
  const open = order.delivery_failed_state === 'number'
    ? 'They said nobody came for delivery, and we are waiting for an alternate phone number (or NO).'
    : order.delivery_failed_state === 'date'
      ? 'They said they requested a future delivery, and we are waiting for the date they want it.'
    : order.delivery_failed_state === 'reason'
      ? 'They said they still want it, and we are waiting to hear whether they requested a future delivery or nobody came for delivery.'
      : 'We asked whether they still want it or want to cancel it, with no answer yet.';
  return `DELIVERY FAILED QUESTION OPEN — the courier could not deliver order ${id} (${booksLine(order)}). ${open} `
    + 'Answer what they asked, then remind them of the question. Their answer is recorded automatically; never say the order is cancelled, refunded or re-attempted on a particular date.';
}

module.exports = {
  WANT_BUTTON, CANCEL_BUTTON, FUTURE_BUTTON, NOBODY_BUTTON, OPEN_STATES,
  FALLBACK_IMAGE, askTemplate, isOwnButton, askEligible, askParams, askedText, headerImageFor, sendAsks,
  choiceOf, reasonOf, numberOf, noNumber, futureDateOf, noDate, findOpenAsk, handleReply, contextFor, missingColumn,
};
