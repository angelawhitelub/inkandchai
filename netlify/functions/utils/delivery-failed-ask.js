/**
 * When the courier reports a failed delivery, ask the customer on WhatsApp what
 * they want, and keep the answers for the owner (owner's request, 5 Nov 2026).
 *
 *   Template  "Do you still want this order, or would you like to cancel it?"
 *     Cancel → recorded. Nothing is cancelled or refunded here: the parcel is
 *              with the courier, and that decision stays with the owner.
 *     Want   → "Why was the delivery missed?"
 *       I requested future delivery → recorded, finished.
 *       Nobody came for delivery    → asks for an alternate number, recorded.
 *
 * Decided in code, like the RTO re-ship offer: the model never records an answer.
 * Each order is asked once, however many attempts fail.
 *
 * Everything lives on the order row (sql/orders_delivery_failed_ask.sql):
 *   delivery_failed_asked_at     when the template went out (the once-only claim)
 *   delivery_failed_state        asked → reason → number → closed
 *                                ('backlog' = already failed when this went live)
 *   delivery_failed_choice       want | cancel
 *   delivery_failed_reason       future_delivery | nobody_came
 *   delivery_failed_alt_phone    the alternate number, 10 digits
 *   delivery_failed_answered_at  their first answer
 *
 * Nothing is sent until WHATSAPP_DELIVERY_FAILED_TEMPLATE names an approved
 * template: {{1}} first name, {{2}} order id, {{3}} books, with the two quick-reply
 * buttons below, worded exactly.
 */

const { booksLine } = require('./rto-reship');

const WANT_BUTTON = 'I want this order';
const CANCEL_BUTTON = 'Cancel this order';
const FUTURE_BUTTON = 'Future delivery';
const NOBODY_BUTTON = 'Nobody came';
const OWN_BUTTONS = new Set([WANT_BUTTON, CANCEL_BUTTON, FUTURE_BUTTON, NOBODY_BUTTON].map((b) => b.toLowerCase()));

const OPEN_STATES = ['asked', 'reason', 'number'];
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
    if (dryRun) { summary.would_send.push({ order_id: id, params }); continue; }
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
    const res = await deps.send({ to: order.customer_phone, template, params });
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
  if (t === '1' || /\bfuture\b|\blater\b|\banother (day|date)\b|\bnext (day|week)\b|\bbaad me|\bkal\b|\breschedul|\bdate\b|\brequested\b/.test(t)) return 'future_delivery';
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
  const id = idOf(order);
  const state = order.delivery_failed_state;
  const done = (reply) => ({ handled: true, reply });

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
  const typedNumber = numberOf(text);
  if (typedNumber) {
    if (!await move(supabase, order, { delivery_failed_choice: 'want', delivery_failed_alt_phone: typedNumber, delivery_failed_state: 'closed' })) return { handled: false };
    return done(`Thank you! We've saved ${typedNumber} as the alternate number for order ${id}, and our team will pass it to the courier.`);
  }

  // Cancel is accepted at either step, since changing their mind is an answer
  // too, but at the reason step only when they say so: "no" answers nothing there.
  const short = String(text || '').trim().toLowerCase();
  if (state === 'asked' ? choiceOf(text) === 'cancel' : (short.length <= 80 && SAYS_CANCEL.test(short))) {
    if (!await move(supabase, order, { delivery_failed_choice: 'cancel', delivery_failed_reason: null, delivery_failed_state: 'closed' })) return { handled: false };
    return done(`Understood. We've noted that you don't want order ${id}, and our team will take it from here. Please don't accept the parcel if the courier comes again.`);
  }

  if (state === 'asked') {
    // "Nobody came" answers both questions at once.
    const already = short.length > 1 ? reasonOf(text) : null;
    if (already === 'future_delivery') {
      if (!await move(supabase, order, { delivery_failed_choice: 'want', delivery_failed_reason: already, delivery_failed_state: 'closed' })) return { handled: false };
      return done(`Thank you, we've noted that you requested a later delivery for order ${id}. Our team will follow it up with the courier.`);
    }
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
    if (reason === 'future_delivery') {
      if (!await move(supabase, order, { delivery_failed_reason: reason, delivery_failed_state: 'closed' })) return { handled: false };
      return done(`Thank you, we've noted that you requested a later delivery for order ${id}. Our team will follow it up with the courier.`);
    }
    if (reason === 'nobody_came') {
      if (!await move(supabase, order, { delivery_failed_reason: reason, delivery_failed_state: 'number' })) return { handled: false };
      return done(`Sorry about that. Please send an alternate phone number the courier can call for order ${id}. If there isn't one, just reply NO.`);
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
    : order.delivery_failed_state === 'reason'
      ? 'They said they still want it, and we are waiting to hear whether they requested a future delivery or nobody came for delivery.'
      : 'We asked whether they still want it or want to cancel it, with no answer yet.';
  return `DELIVERY FAILED QUESTION OPEN — the courier could not deliver order ${id} (${booksLine(order)}). ${open} `
    + 'Answer what they asked, then remind them of the question. Their answer is recorded automatically; never say the order is cancelled, refunded or re-attempted on a particular date.';
}

module.exports = {
  WANT_BUTTON, CANCEL_BUTTON, FUTURE_BUTTON, NOBODY_BUTTON, OPEN_STATES,
  askTemplate, isOwnButton, askEligible, askParams, askedText, sendAsks,
  choiceOf, reasonOf, numberOf, noNumber, findOpenAsk, handleReply, contextFor, missingColumn,
};
