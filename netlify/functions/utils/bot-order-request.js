/**
 * WhatsApp bot book orders: draft → customer says YES → placed.
 *
 * The bot used to write a bot_order_requests row the moment the model called
 * submit_order_request. Two things made that produce duplicate requests for the
 * same customer (18 Sep: IC-W-…-ETSJ6, -4YK6C and -N6Q3W, all one person, one
 * book set, three minutes apart):
 *   - nothing asked the customer to confirm, so "is my order placed?" or a
 *     re-pasted message was enough for the model to place it again;
 *   - nothing looked for a request the customer already had.
 *
 * Now the tool only DRAFTS the request (status awaiting_confirmation — hidden
 * from the admin Book Requests list, no payment link, no owner ping). It is
 * placed only when the customer replies YES, and that reply is handled in
 * code by confirmDraftOrder, not by the model. A request for the same books
 * as one already placed on this number returns that order instead of a new one.
 *
 * Every function takes its side effects through `deps` so it can be tested
 * without Supabase, Razorpay or WhatsApp.
 */

const DRAFT = 'awaiting_confirmation';
const DISCARDED = 'draft_discarded';
// Statuses of a request that has been placed and not closed/cancelled.
const LIVE = ['new', 'contacted', 'ordered'];
// Never shown in the admin Book Requests list.
const HIDDEN_STATUSES = [DRAFT, DISCARDED];

const DRAFT_TTL_MS = 2 * 60 * 60 * 1000;          // a YES after 2h places nothing
const DUPLICATE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const UNMATCHED_BOOK_FALLBACK_RS = 349;

const last10 = (phone) => String(phone || '').replace(/\D/g, '').slice(-10);

// ── Field validation (moved here from whatsapp-bot.js unchanged) ─────────────
// The model sometimes forces a tool call for NON-orders (status checks,
// delivery complaints) by stuffing required fields with placeholders like
// "N/A", "book", "Customer", or a date, or by putting the query text itself in
// `books` ("where is my order"). Reject those so they never pollute the panel.
const isPlaceholder = (v) => /^(n\/?a|na|none|null|nil|unknown|not\s+(provided|given|specified|available)|not\s+shared|no\s+(name|address|book|books)|customer|book|books|your\s+book\s+title|book\s+title|title|test|\d{6,})$/i.test(String(v).trim());

const looksLikeQuery = (v) => {
  const s = String(v || '').trim().toLowerCase();
  if (!s) return false;
  if (/\?$/.test(s)) return true;
  return /(where\s*(is|are)?\s*(my|the)?\s*(order|parcel|package|book|delivery|shipment)|my\s+order|order\s*(status|update|kahan|kaha|kab)|status\s+of|track(ing)?\s+(my\s+)?(order|parcel|package|shipment)|check\s+(my\s+)?order|kahan\s*hai|kaha\s*hai|not\s+(delivered|received|arrived)|haven'?t\s+(received|got)|delivery\s+(update|status)|when\s+will|kab\s+(aayega|milega)|cancel|refund|return|complaint|damaged|wrong\s+(book|item))/i.test(s)
    || /^(order|status|tracking|track|help|update|delivery|refund|cancel|return)$/i.test(s);
};

function validateOrderFields(args = {}) {
  const customerName = String(args.customer_name || '').slice(0, 160).trim();
  const address      = String(args.address || '').slice(0, 600).trim();
  const books        = String(args.books || '').slice(0, 600).trim();
  const notes        = String(args.notes || '').slice(0, 400).trim();
  const mode         = String(args.payment_mode || '').toLowerCase().trim();
  const paymentMode  = mode === 'prepaid' ? 'prepaid' : mode === 'cod' ? 'cod' : '';
  if (!customerName || !address || !books) {
    return { error: 'Missing name, address, or book name.' };
  }
  if (!paymentMode) {
    return { error: 'Missing payment_mode. Ask the customer whether they want COD (Cash on Delivery) or Prepaid (pay online now), then call this tool again with payment_mode set.' };
  }
  const bad = [];
  if (isPlaceholder(customerName) || customerName.length < 2) bad.push('a real full name');
  if (isPlaceholder(books) || looksLikeQuery(books)) bad.push('the actual book title');
  // A real Indian address is more than a bare city/word.
  const hasPin = /\b\d{6}\b/.test(address);
  if (isPlaceholder(address) || (address.length < 12 && !hasPin)) bad.push('the complete delivery address with pincode');
  if (bad.length) {
    return { error: `This does not look like a real new-book order. Do NOT submit it. If the customer actually wants to buy a book, ask them for ${bad.join(', ')}. If they are asking about an existing order, delivery, or a refund, handle that instead — do not call this tool.` };
  }
  return { fields: { customerName, address, books, notes, paymentMode } };
}

// ── "Same books?" ────────────────────────────────────────────────────────────
// The model rewrites titles between calls ("vol1+vol2 by Alex xu" →
// "System Design Interview Vol 1, Vol 2 by Alex Xu"), so compare word sets,
// not strings.
const STOP = new Set(['the', 'and', 'by', 'of', 'a', 'an', 'book', 'books', 'copy', 'copies', 'paperback', 'edition', 'set', 'combo', 'part', 'english', 'hindi']);
function bookWords(s) {
  const words = String(s || '').toLowerCase()
    .replace(/\b(vol(?:ume)?|part|book)\.?\s*(\d+)/g, 'vol$2')
    .replace(/[^a-z0-9ऀ-ॿ]+/g, ' ')
    .split(' ')
    .filter((w) => w && (w.length > 2 || /\d/.test(w)) && !STOP.has(w));
  return new Set(words);
}
function sameBooks(a, b) {
  const x = bookWords(a);
  const y = bookWords(b);
  if (!x.size || !y.size) return false;
  let both = 0;
  for (const w of x) if (y.has(w)) both++;
  return both / (x.size + y.size - both) >= 0.75;
}

function mintOrderId(now = new Date()) {
  const datePart = now.toISOString().slice(0, 10).replace(/-/g, '');
  const randPart = Math.random().toString(36).slice(2, 7).toUpperCase().padEnd(5, 'X');
  return `IC-W-${datePart}-${randPart}`;
}

async function recentRequests(db, phone, sinceMs, nowMs) {
  const { data, error } = await db.from('bot_order_requests')
    .select('id, order_id, customer_name, address, books, notes, status, payment_mode, amount_paise, payment_link, payment_status, order_pushed_id, created_at')
    .eq('customer_phone', last10(phone))
    .gte('created_at', new Date(nowMs - sinceMs).toISOString())
    .order('created_at', { ascending: false })
    .limit(20);
  if (error) throw new Error(`bot_order_requests read failed: ${error.message}`);
  return data || [];
}

function rupees(paise) { return Math.round(Number(paise || 0) / 100); }

async function priceSafely(priceBooksList, books) {
  try {
    return await priceBooksList(books, UNMATCHED_BOOK_FALLBACK_RS);
  } catch (e) {
    console.error('bot-order-request price:', e.message);
    const totalRs = UNMATCHED_BOOK_FALLBACK_RS + 40;
    return { items: [], subtotalRs: UNMATCHED_BOOK_FALLBACK_RS, shippingRs: 40, totalRs, totalPaise: totalRs * 100, unmatched: [books] };
  }
}

/**
 * The submit_order_request tool. Never places an order.
 * deps: { db, priceBooksList, now? }
 */
async function draftOrderRequest(deps, phone, args) {
  const v = validateOrderFields(args);
  if (v.error) return { ok: false, error: v.error };
  const f = v.fields;
  const { db } = deps;
  const nowMs = (deps.now ? deps.now() : new Date()).getTime();

  let rows;
  try { rows = await recentRequests(db, phone, DUPLICATE_WINDOW_MS, nowMs); }
  catch (e) {
    // Without the read we cannot tell a duplicate from a new order, so do not
    // write anything — a missed order is recoverable from the chat, a
    // duplicate shipment is not.
    console.error('draftOrderRequest:', e.message);
    return { ok: false, error: 'lookup-failed', message: 'Sorry, I could not check your existing orders just now. Please try again in a minute. [ESCALATE]' };
  }

  const placed = rows.filter((r) => LIVE.includes(r.status));
  const dup = placed.find((r) => sameBooks(r.books, f.books));
  if (dup) {
    return {
      ok: true,
      already_placed: true,
      order_id: dup.order_id,
      books: dup.books,
      payment_mode: dup.payment_mode,
      total_rs: dup.amount_paise ? rupees(dup.amount_paise) : null,
      payment_link: dup.payment_mode === 'prepaid' && dup.payment_status !== 'paid' ? (dup.payment_link || null) : null,
      message: `NOT placed again — this customer ALREADY HAS order ${dup.order_id} for these books (placed ${new Date(dup.created_at).toISOString().slice(0, 10)}). Tell them their order ${dup.order_id} is already placed and will be dispatched; do not create another. If they really want an additional copy, a human will add it: https://wa.me/919217175546`,
    };
  }

  const pricing = await priceSafely(deps.priceBooksList, f.books);
  const draft = rows.find((r) => r.status === DRAFT && nowMs - new Date(r.created_at).getTime() < DRAFT_TTL_MS);
  const values = {
    customer_name: f.customerName,
    address:       f.address,
    books:         f.books,
    notes:         f.notes,
    payment_mode:  f.paymentMode,
    amount_paise:  pricing.totalPaise,
  };

  let orderId;
  if (draft) {
    // The customer changed something before saying YES — revise the one draft.
    orderId = draft.order_id;
    const { error } = await db.from('bot_order_requests').update(values).eq('id', draft.id).eq('status', DRAFT);
    if (error) return { ok: false, error: error.message };
  } else {
    orderId = mintOrderId(new Date(nowMs));
    const { error } = await db.from('bot_order_requests').insert({
      order_id: orderId,
      customer_phone: last10(phone),
      status: DRAFT,
      created_at: new Date(nowMs).toISOString(),
      ...values,
    });
    if (error) return { ok: false, error: error.message };
  }

  const others = placed.map((r) => r.order_id).filter(Boolean);
  return {
    ok: true,
    needs_confirmation: true,
    order_id: orderId,
    summary: {
      books: f.books,
      name: f.customerName,
      address: f.address,
      payment_mode: f.paymentMode,
      subtotal_rs: pricing.subtotalRs,
      shipping_rs: pricing.shippingRs,
      total_rs: pricing.totalRs,
    },
    other_open_orders: others,
    message: 'NOT PLACED YET. Read the summary back to the customer (books, name, address, COD or prepaid, total) and ask them to reply YES to place the order or tell you what to change. Do not say the order is placed and do not share an order ID yet.'
      + (others.length ? ` Also mention they already have order ${others.join(', ')} — this would be a separate, additional order.` : ''),
  };
}

// Whole-message affirmatives/negatives only: "yes but change the address" must
// reach the model, not place the order with the old address.
const YES_RE = /^(yes|y|yeah|yep|yup|ok|okay|sure|confirm(ed)?|place( it| the order| order)?|haan|haanji|han|ha|ji|done|correct|✅|👍)( (please|pls|ji|confirm|kar do|karo|place it|go ahead))?[\s.!]*$/i;
const NO_RE  = /^(no|n|nope|cancel|cancel it|don'?t|nahi|nahin|nhi|mat|❌|👎)( (please|pls|ji|thanks|thank you))?[\s.!]*$/i;
function draftReplyDecision(text) {
  const t = String(text || '').trim();
  if (YES_RE.test(t)) return 'confirm';
  if (NO_RE.test(t)) return 'cancel';
  return null;
}

function placedMessage(row, pricing, paymentLink) {
  const total = rupees(row.amount_paise);
  const breakdown = pricing && pricing.shippingRs
    ? ` (books ₹${pricing.subtotalRs} + shipping ₹${pricing.shippingRs})`
    : '';
  if (row.payment_mode === 'prepaid') {
    return paymentLink
      ? `Your order is placed ✅\nOrder ID: ${row.order_id}\nAmount to pay: ₹${total}${breakdown}\n\nTap here to pay securely: ${paymentLink}\n\nAs soon as we receive your payment we'll dispatch it — usually same-day 📚`
      : `Your order is placed ✅\nOrder ID: ${row.order_id}\nAmount to pay: ₹${total}${breakdown}\n\nOur team will send you the payment link shortly 📚`;
  }
  return `Your COD order is placed ✅\nOrder ID: ${row.order_id}\nTotal: ₹${total}${breakdown}\nPay ₹${total} in cash when the courier delivers. We'll dispatch it soon 📚`;
}

/**
 * The customer's YES/NO to a draft. Returns null when there is no live draft
 * (the message then goes on to the other handlers / the model).
 * deps: { db, priceBooksList, createPaymentLink, upsertBotCustomer, notifyOwner, now? }
 */
async function confirmDraftOrder(deps, phone, decision) {
  const { db } = deps;
  const nowMs = (deps.now ? deps.now() : new Date()).getTime();
  const nowIso = new Date(nowMs).toISOString();
  const { data, error } = await db.from('bot_order_requests')
    .select('id, order_id, customer_phone, customer_name, address, books, notes, payment_mode, amount_paise, created_at')
    .eq('customer_phone', last10(phone))
    .eq('status', DRAFT)
    .gte('created_at', new Date(nowMs - DRAFT_TTL_MS).toISOString())
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) { console.error('confirmDraftOrder read:', error.message); return null; }
  const row = data && data[0];
  if (!row) return null;

  if (decision === 'cancel') {
    await db.from('bot_order_requests').update({ status: DISCARDED, customer_cancelled_at: nowIso }).eq('id', row.id).eq('status', DRAFT);
    return { handled: true, order_id: row.order_id, reply: "No problem — I haven't placed it. Tell me what you'd like to change, or message me any time you want to order 📚" };
  }

  // Claim the draft. Two YES messages processed at once both reach here; only
  // the one whose update matched the draft goes on to place it.
  const { data: claimed, error: claimErr } = await db.from('bot_order_requests')
    .update({ status: 'new', customer_confirmed_at: nowIso })
    .eq('id', row.id)
    .eq('status', DRAFT)
    .select('id');
  if (claimErr) { console.error('confirmDraftOrder claim:', claimErr.message); return null; }
  if (!claimed || !claimed.length) return { handled: true, order_id: row.order_id, reply: null };

  const pricing = await priceSafely(deps.priceBooksList, row.books);

  let paymentLink = '';
  let linkError = '';
  if (row.payment_mode === 'prepaid') {
    try {
      const link = await deps.createPaymentLink({
        amountPaise: Number(row.amount_paise),
        description: `Ink & Chai — ${String(row.books).slice(0, 100)}`,
        customerName: row.customer_name,
        customerPhone: row.customer_phone,
        shippingAddress: row.address,
        books: row.books,
        referenceId: row.order_id,
        callbackUrl: `https://inkandchai.in/track/?id=${encodeURIComponent(row.order_id)}`,
      });
      paymentLink = (link && link.short_url) || '';
      await db.from('bot_order_requests').update({
        payment_link: paymentLink || null,
        razorpay_payment_link_id: (link && link.id) || null,
        payment_status: paymentLink ? 'created' : 'link_failed',
      }).eq('id', row.id);
    } catch (e) {
      linkError = e.message;
      console.error('confirmDraftOrder payment link:', e.message);
      await db.from('bot_order_requests').update({ payment_status: 'link_failed' }).eq('id', row.id);
    }
  }

  try { await deps.upsertBotCustomer(phone, { customer_name: row.customer_name, address: row.address, order_id: row.order_id }); }
  catch (e) { console.error('confirmDraftOrder upsertBotCustomer:', e.message); }

  const total = rupees(row.amount_paise);
  const modeLabel = row.payment_mode === 'prepaid'
    ? (paymentLink ? `💳 Prepaid — ${paymentLink}` : `💳 Prepaid — ⚠️ link failed: ${linkError || 'unknown'}`)
    : '💵 COD';
  const unmatched = pricing.unmatched && pricing.unmatched.length
    ? `\n⚠️ Titles not in catalogue (verify price): ${pricing.unmatched.join('; ')}` : '';
  try {
    await deps.notifyOwner(
      `🆕 New book order request (WhatsApp bot, confirmed by customer)\n\n🆔 ${row.order_id}\n👤 ${row.customer_name}\n📞 ${row.customer_phone}\n📚 ${row.books}\n📍 ${row.address}\n💰 Total ₹${total}${unmatched}\n${modeLabel}${row.notes ? `\n📝 ${row.notes}` : ''}\n\nOpen admin panel → Book Requests → Push to Orders.`);
  } catch (e) { console.error('confirmDraftOrder notifyOwner:', e.message); }

  console.log(`[ORDER-REQUEST] ${row.order_id} ${row.customer_phone} confirmed -> ${String(row.books).slice(0, 60)} mode=${row.payment_mode} total=₹${total}`);
  return { handled: true, placed: true, order_id: row.order_id, reply: placedMessage(row, pricing, paymentLink) };
}

// ── What the model is told about this number's bot orders ────────────────────
// Conversation history lives in memory and does not survive between Worker
// isolates, so the model often cannot see that it already took an order. This
// puts the facts in front of it on every message.
const STATUS_WORDS = {
  [DRAFT]: 'NOT PLACED — waiting for the customer to reply YES',
  new: 'placed, our team is processing it',
  contacted: 'placed, our team is processing it',
  ordered: 'placed and moved to dispatch',
};
function describeRequest(r) {
  const status = STATUS_WORDS[r.status] || r.status;
  const amount = r.amount_paise ? ` · ₹${rupees(r.amount_paise)}` : '';
  const mode = r.payment_mode ? ` · ${String(r.payment_mode).toUpperCase()}${r.payment_mode === 'prepaid' && r.payment_status === 'paid' ? ' (paid)' : ''}` : '';
  const pushed = r.order_pushed_id && r.order_pushed_id !== r.order_id ? ` · now order ${r.order_pushed_id}` : '';
  return `- ${r.order_id}: ${r.books}${amount}${mode} — ${status}${pushed} (${new Date(r.created_at).toISOString().slice(0, 10)})`;
}

async function botOrdersContext(db, phone, now = new Date()) {
  try {
    const rows = await recentRequests(db, phone, 14 * 24 * 60 * 60 * 1000, now.getTime());
    const shown = rows.filter((r) => LIVE.includes(r.status)
      || (r.status === DRAFT && now.getTime() - new Date(r.created_at).getTime() < DRAFT_TTL_MS));
    if (!shown.length) return '';
    return 'WHATSAPP ORDERS ON THIS NUMBER (from our database — trust this over the chat history):\n'
      + shown.map(describeRequest).join('\n')
      + '\nIf the customer asks whether their order is placed, answer from this list. NEVER call submit_order_request to "check" or "re-place" an order listed here.';
  } catch (e) {
    console.warn('botOrdersContext:', e.message);
    return '';
  }
}

async function lookupBotRequest(db, orderId) {
  try {
    const { data } = await db.from('bot_order_requests')
      .select('order_id, books, status, payment_mode, payment_status, amount_paise, order_pushed_id, created_at')
      .eq('order_id', String(orderId).toUpperCase())
      .maybeSingle();
    return data || null;
  } catch (e) { console.warn('lookupBotRequest:', e.message); return null; }
}

module.exports = {
  DRAFT, DISCARDED, LIVE, HIDDEN_STATUSES, DRAFT_TTL_MS,
  validateOrderFields, sameBooks, draftReplyDecision,
  draftOrderRequest, confirmDraftOrder, botOrdersContext, lookupBotRequest, describeRequest,
};
