/**
 * RTO re-ship offer: before refunding a prepaid order that came back to us,
 * ask the customer on WhatsApp whether they still want the books.
 *
 * Owner's rules (25 Oct 2026):
 *   - Prepaid only (not COD, not partial COD, not a free replacement).
 *   - The offer goes out as soon as the courier marks the order RTO.
 *   - YES  → the same books ship again free, as a new replacement-style order
 *            (IC-R-…, cart_items[0]._replacement.original_order_id), and no
 *            refund. The bot first confirms the address, or takes a new one.
 *   - NO   → the usual RTO refund (paid − both shipping legs), as soon as the
 *            parcel is back with us.
 *   - Silence → the same refund, 48 h after the parcel is back with us.
 *
 * Everything lives on the original order row (sql/orders_rto_reship.sql):
 *   rto_offer_sent_at     when the template went out (the once-only claim)
 *   rto_offer_state       sent → confirm_address → reshipping → reship
 *                         sent | confirm_address → refund
 *   rto_offer_updated_at  last change
 *   rto_reship_address    a new address the customer typed, if any
 *   rto_reship_phone      a new phone number the customer typed, if any
 *   rto_reship_order_id   the IC-R-… order created on YES
 *   rto_back_at           first run of the refund job that saw the
 *                         delivered-back scan; the 48 h hold counts from here
 *
 * The offer is closed the moment any refund starts (refund_id or refund_state
 * set), whether by the job after 48 h or by the owner's Refund button, so a
 * late YES can never get both the books and the money.
 *
 * Nothing is sent until WHATSAPP_RTO_RESHIP_TEMPLATE names an approved
 * template (see offerParams for its four body variables).
 */

const rto = require('./rto-refund');
const { isReplacementOrder } = require('./replacement-order');
const { isPartialCodOrder } = require('./missing-books');
const { pickPincode } = require('./np-normalize');

const OPEN_STATES = ['sent', 'confirm_address'];
const HOLD_MS = 48 * 3600 * 1000;
const OFFER_COLUMNS = 'rto_offer_sent_at, rto_offer_state, rto_offer_updated_at, rto_reship_address, rto_reship_phone, rto_reship_order_id, rto_back_at';

function offerTemplate() {
  return String(process.env.WHATSAPP_RTO_RESHIP_TEMPLATE || '').trim();
}

const last10 = (p) => String(p || '').replace(/\D/g, '').slice(-10);
const rs = (paise) => (Math.round(paise) / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 });

/** A column the SQL has not added yet: callers treat the feature as off. */
function missingColumn(error) {
  return !!error && /rto_(offer|reship|back)/.test(String(error.message || error));
}

function booksLine(order, max = 80) {
  const cart = Array.isArray(order.cart_items) ? order.cart_items : [];
  const s = cart.map(i => {
    const q = Math.max(1, Number(i.qty || i.quantity) || 1);
    return `${String(i.title || i.name || 'Book').trim()}${q > 1 ? ` × ${q}` : ''}`;
  }).join(', ');
  return s.length > max ? `${s.slice(0, max - 1)}…` : (s || 'your books');
}

/** Why this order may or may not get the offer. */
function offerEligible(order) {
  if (!order) return { ok: false, reason: 'no order' };
  if (String(order.status || '') !== 'rto') return { ok: false, reason: `status ${order.status}` };
  if (order.rto_offer_sent_at) return { ok: false, reason: 'offer already sent' };
  if (order.refund_id || order.refund_state) return { ok: false, reason: 'refund already started' };
  if (isReplacementOrder(order)) return { ok: false, reason: 'free replacement' };
  if (!rto.gatewayFor(order.razorpay_payment_id)) return { ok: false, reason: 'COD' };
  if (isPartialCodOrder(order)) return { ok: false, reason: 'partial COD' };
  if (!last10(order.customer_phone) || last10(order.customer_phone).length < 10) return { ok: false, reason: 'no phone' };
  return { ok: true };
}

/** Template body: {{1}} first name, {{2}} order id, {{3}} books, {{4}} refund in rupees. */
function offerParams(order) {
  const first = String(order.customer_name || '').trim().split(/\s+/)[0] || 'there';
  const calc = rto.rtoRefundFor(order);
  return [first, String(order.razorpay_order_id || order.id), booksLine(order, 60), rs(calc.refund)];
}

/**
 * Sends the offer to every eligible RTO order not offered yet.
 * deps { supabase, send({to, template, params}), isOptedOut(db, phone), now }
 */
async function sendOffers(deps, opts = {}) {
  const { supabase } = deps;
  const now = deps.now ? deps.now() : Date.now();
  const template = opts.template != null ? opts.template : offerTemplate();
  const dryRun = !!opts.dryRun;
  const days = opts.days || 30;
  const max = opts.max || 30;
  const summary = { dry_run: dryRun, enabled: !!template, sent: [], would_send: [], skipped: [], failed: [] };
  if (!template && !dryRun) return summary;

  const { data, error } = await supabase.from('orders')
    .select(`id, razorpay_order_id, razorpay_payment_id, amount_paise, status, created_at, customer_name, customer_phone, cart_items, source, refund_id, refund_state, ${OFFER_COLUMNS}`)
    .eq('status', 'rto')
    .is('rto_offer_sent_at', null)
    .is('refund_id', null)
    .gte('created_at', new Date(now - days * 86400000).toISOString())
    .order('created_at', { ascending: true })
    .limit(200);
  if (error) {
    if (missingColumn(error)) { summary.error = 'run sql/orders_rto_reship.sql first'; return summary; }
    throw new Error(error.message);
  }

  for (const order of data || []) {
    const id = order.razorpay_order_id || order.id;
    const elig = offerEligible(order);
    if (!elig.ok) { summary.skipped.push({ order_id: id, reason: elig.reason }); continue; }
    if (deps.isOptedOut && await deps.isOptedOut(supabase, order.customer_phone)) {
      summary.skipped.push({ order_id: id, reason: 'customer opted out of WhatsApp' });
      continue;
    }
    const params = offerParams(order);
    if (dryRun) { summary.would_send.push({ order_id: id, params }); continue; }
    if (summary.sent.length + summary.failed.length >= max) { summary.skipped.push({ order_id: id, reason: 'per-run cap; next run' }); continue; }

    // Claim first: two overlapping runs cannot both message the customer.
    const stamp = new Date(now).toISOString();
    const { data: claimed, error: claimErr } = await supabase.from('orders')
      .update({ rto_offer_sent_at: stamp, rto_offer_state: 'sent', rto_offer_updated_at: stamp })
      .eq('id', order.id).eq('status', 'rto').is('rto_offer_sent_at', null).is('refund_id', null).is('refund_state', null)
      .select('id');
    if (claimErr || !claimed || !claimed.length) {
      summary.skipped.push({ order_id: id, reason: claimErr ? `claim failed: ${claimErr.message}` : 'changed since it was read' });
      continue;
    }
    const res = await deps.send({ to: order.customer_phone, template, params });
    if (res && res.ok) {
      summary.sent.push({ order_id: id });
    } else {
      // Not delivered: release the claim so no hold is put on the refund for an
      // offer the customer never saw. The next run tries once more.
      summary.failed.push({ order_id: id, error: String((res && (res.error || res.status)) || 'send failed').slice(0, 160) });
      await supabase.from('orders')
        .update({ rto_offer_sent_at: null, rto_offer_state: null, rto_offer_updated_at: null })
        .eq('id', order.id).eq('rto_offer_state', 'sent')
        .then(() => {}, () => {});
    }
  }
  return summary;
}

/** YES / NO from a reply or a template button. null = something else. */
function decisionOf(text) {
  const t = String(text || '').trim().toLowerCase();
  if (!t) return null;
  if (/refund|paise wapas|money back/.test(t) || /^(no|n|nope|nah|nahi|nahin|nhi|na|mat|❌|👎)\b/.test(t)) return 'no';
  if (/send (it )?again|re-?ship|still want|bhej do|bhejo|bhej dijiye/.test(t)
    || /^(yes|y|yeah|yup|yep|ok|okay|sure|please|haan|haanji|han|ha|ji|confirm|confirmed|✅|👍)\b/.test(t)) return 'yes';
  return null;
}

/** An address the customer typed: needs a 6-digit pincode and some substance. */
function addressFrom(text) {
  const raw = String(text || '').trim();
  if (raw.length < 20) return null;
  const { pincode } = pickPincode(raw);
  if (!pincode) return null;
  const m = raw.match(/(?:\+?91[\s-]?)?\b([6-9]\d{9})\b/);
  const phone = m ? m[1] : '';
  const address = (m ? raw.replace(m[0], ' ') : raw)
    .replace(/^(yes|haan|ok|okay)\b[\s,.:-]*/i, '')
    .replace(/\b(phone|mobile|mob|ph|contact)( no\.?| number)?\s*[:\-]?\s*$/i, '')
    .replace(/\s+/g, ' ').replace(/\s+,/g, ',').trim();
  return { address, phone, pincode };
}

const shipAddress = (o) => o.rto_reship_address || o.customer_address || '';
const shipPhone = (o) => o.rto_reship_phone || last10(o.customer_phone);

/** The customer's offer still waiting for an answer, newest first. */
async function findOpenOffer(supabase, phone) {
  const key = last10(phone);
  if (key.length < 10) return null;
  const { data, error } = await supabase.from('orders')
    .select('*')
    .in('rto_offer_state', OPEN_STATES)
    .eq('status', 'rto')
    .is('refund_id', null)
    .is('refund_state', null)
    .order('rto_offer_sent_at', { ascending: false })
    .limit(100);
  if (error) {
    if (!missingColumn(error)) console.warn('[rto-reship] open offer lookup:', error.message);
    return null;
  }
  return (data || []).find(o => last10(o.customer_phone) === key) || null;
}

/** Moves the offer on, only from the state it was read in. */
async function transition(supabase, order, from, fields) {
  const { data, error } = await supabase.from('orders')
    .update({ ...fields, rto_offer_updated_at: new Date().toISOString() })
    .eq('id', order.id).eq('rto_offer_state', from).is('refund_id', null).is('refund_state', null)
    .select('id');
  if (error) throw new Error(error.message);
  return !!(data && data.length);
}

function replacementId() {
  const datePart = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const randPart = Array.from({ length: 5 }, () =>
    'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 32)]).join('');
  return `IC-R-${datePart}-${randPart}`;
}

/**
 * The free re-shipment: the same row shape admin-create-replacement writes, so
 * the unshipped list, the courier pushes (always prepaid for replacements) and
 * the RTO refund job's replacement check all see it with no special case. Not
 * pushed to the courier here: the replacement sweep picks it up after its edit
 * window, which gives the owner time to stop it.
 */
async function createReshipOrder(supabase, order) {
  const cart = (Array.isArray(order.cart_items) ? order.cart_items : []).map((src) => {
    const { _missing, _missing_at, _missing_qty, _missing_photos, _replacement, _payment, ...rest } = src || {};
    return { ...rest };
  });
  if (!cart.length) throw new Error('the original order has no books on it');
  const originalId = String(order.razorpay_order_id || order.id);
  cart[0]._replacement = {
    original_order_id: originalId,
    reason: 'rto_reship',
    reason_label: 'Re-ship after RTO (customer said yes on WhatsApp)',
    note: 'The parcel came back to us; the customer asked for it again on WhatsApp. Free, no refund.',
    created_by: 'whatsapp_bot',
    photos: [],
    requested_at: new Date().toISOString(),
  };
  const replId = replacementId();
  const { data, error } = await supabase.from('orders').insert({
    razorpay_order_id:     replId,
    razorpay_payment_id:   null,
    amount_paise:          0,
    status:                'replacement_pending',
    shipment_payment_type: 'prepaid',
    customer_name:         order.customer_name || '',
    customer_email:        order.customer_email || '',
    customer_phone:        shipPhone(order) || order.customer_phone || '',
    customer_address:      shipAddress(order),
    cart_items:            cart,
    ...(order.user_id ? { user_id: order.user_id } : {}),
    source:                'replacement',
  }).select('razorpay_order_id').single();
  if (error) throw new Error(error.message);
  return (data && data.razorpay_order_id) || replId;
}

function addressPrompt(order) {
  return `Please check where we should send it:\n\n📍 ${shipAddress(order) || '(no address on file)'}\n📞 ${shipPhone(order) || '(no phone on file)'}\n\n`
    + `Reply *YES* to ship it here, or type the correct full address with pincode (and a new phone number if it has changed).`;
}

function refundPromise(order) {
  const calc = rto.rtoRefundFor(order);
  if (calc.refund <= 0) return `Our team will look at the refund for order ${order.razorpay_order_id} and get back to you here.`;
  return `No problem. We'll refund ₹${rs(calc.refund)} for order ${order.razorpay_order_id} (₹${rs(calc.gross)} paid, less ₹${rs(calc.deduction)} for shipping both ways) to your original payment method as soon as the parcel reaches us. You'll get a message when it's done.`;
}

/**
 * Answers a customer's reply to the offer, in code. Returns { handled, reply }
 * where reply is the text to send; handled false lets the AI answer instead.
 * deps { supabase, ownerAlert(text) }
 */
async function handleOfferReply(deps, phone, text, { offer = null } = {}) {
  const { supabase } = deps;
  const order = offer || await findOpenOffer(supabase, phone);
  if (!order) return { handled: false };
  const id = order.razorpay_order_id || order.id;
  const state = order.rto_offer_state;
  const decision = decisionOf(text);

  // A typed address is checked before YES/NO: "No. 12, MG Road …" is an
  // address, and sending one at all means they want the books.
  const typed = addressFrom(text);
  if (typed) {
    const fields = { rto_reship_address: typed.address, rto_offer_state: 'confirm_address' };
    if (typed.phone) fields.rto_reship_phone = typed.phone;
    if (!await transition(supabase, order, state, fields)) return { handled: false };
    return { handled: true, reply: `Got it, thank you! 📝\n\n${addressPrompt({ ...order, ...fields })}` };
  }

  if (decision === 'no') {
    if (!await transition(supabase, order, state, { rto_offer_state: 'refund' })) return { handled: false };
    return { handled: true, reply: refundPromise(order) };
  }

  if (decision !== 'yes') return { handled: false };

  if (state === 'sent') {
    if (!await transition(supabase, order, 'sent', { rto_offer_state: 'confirm_address' })) return { handled: false };
    return { handled: true, reply: `Great, we'll send ${booksLine(order)} again, free of charge 📚\n\n${addressPrompt(order)}` };
  }

  // confirm_address + YES: claim, create the order, then record it. A double tap
  // finds the state already moved on and creates nothing.
  if (!await transition(supabase, order, 'confirm_address', { rto_offer_state: 'reshipping' })) return { handled: false };
  let replId;
  try {
    replId = await createReshipOrder(supabase, order);
  } catch (e) {
    console.error('[rto-reship] create failed:', id, e.message);
    await transition(supabase, order, 'reshipping', { rto_offer_state: 'confirm_address' }).catch(() => {});
    if (deps.ownerAlert) await deps.ownerAlert(`⚠️ RTO re-ship for ${id} failed: ${e.message}. The customer said YES; create the replacement by hand.`);
    return { handled: true, reply: `Sorry, something went wrong on our side while creating the new shipment. Our team has been told and will sort it out for you here shortly.` };
  }
  await transition(supabase, order, 'reshipping', { rto_offer_state: 'reship', rto_reship_order_id: replId })
    .catch(e => console.error('[rto-reship] record failed:', id, e.message));
  if (deps.ownerAlert) {
    await deps.ownerAlert(`🔁 RTO re-ship: ${id} → ${replId} (${booksLine(order)}), free, no refund. Ship to: ${shipAddress(order)} · ${shipPhone(order)}`);
  }
  return {
    handled: true,
    reply: `✅ Done! Your free re-shipment is order *${replId}* for ${booksLine(order)}.\n\n📍 ${shipAddress(order)}\n\nThere's nothing to pay. You'll get tracking on WhatsApp as soon as it's dispatched.`,
    replacement_id: replId,
  };
}

/** A line for the AI, so a question in the middle of the offer is answered in context. */
function offerContext(order) {
  if (!order) return '';
  const id = order.razorpay_order_id || order.id;
  const ask = order.rto_offer_state === 'confirm_address'
    ? `The customer said they want it again. We are waiting for them to reply YES to ship to: ${shipAddress(order)} (phone ${shipPhone(order)}), or to type a corrected full address with pincode.`
    : `We asked whether they still want it (free re-shipment) or a refund of ₹${rs(rto.rtoRefundFor(order).refund)} once it is back with us. No answer yet; with no answer the refund goes out 48 hours after the parcel is back.`;
  return `RTO RE-SHIP OFFER OPEN — order ${id} (${booksLine(order)}) was not delivered and is returning to us. ${ask} `
    + `Answer their question, then remind them to reply YES or NO. Never create an order or promise a refund yourself; their YES/NO reply is handled automatically.`;
}

/**
 * The refund job's view: may this verified-back order be refunded now?
 * Returns { hold: false } or { hold: true, reason, backAt? }.
 */
function refundHold(order, now = Date.now()) {
  const state = order && order.rto_offer_state;
  if (!order || !order.rto_offer_sent_at || !state || state === 'refund' || state === 'reship') return { hold: false };
  if (state === 'reshipping') return { hold: true, reason: 'the customer is confirming a free re-shipment right now' };
  const backAt = order.rto_back_at ? Date.parse(order.rto_back_at) : NaN;
  if (!Number.isFinite(backAt)) return { hold: true, reason: 'back with us; waiting 48 h for the customer to answer the re-ship offer', markBack: true };
  if (now - backAt < HOLD_MS) {
    return { hold: true, reason: `waiting for the customer to answer the re-ship offer until ${new Date(backAt + HOLD_MS).toISOString()}` };
  }
  return { hold: false };
}

module.exports = {
  OPEN_STATES, HOLD_MS, OFFER_COLUMNS,
  offerTemplate, offerEligible, offerParams, sendOffers, decisionOf, addressFrom,
  findOpenOffer, handleOfferReply, createReshipOrder, offerContext, refundHold, missingColumn, booksLine,
};
