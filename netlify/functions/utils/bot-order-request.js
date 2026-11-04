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

const { siteSaleDiscount } = require('./site-sale');
const { freeDeliveryFor, freeByAmount } = require('./free-delivery');

const DRAFT = 'awaiting_confirmation';
const DISCARDED = 'draft_discarded';
// Statuses of a request that has been placed and not closed/cancelled.
const LIVE = ['new', 'contacted', 'ordered'];
// Never shown in the admin Book Requests list.
const HIDDEN_STATUSES = [DRAFT, DISCARDED];

const DRAFT_TTL_MS = 2 * 60 * 60 * 1000;          // a YES after 2h places nothing
const DUPLICATE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
// priceBooksList's per-book placeholder for a title it cannot find. It is
// NEVER quoted: until 4 Nov 2026 it was, and Designing Data-Intensive
// Applications (~₹500, not listed) went to a customer as ₹349 (IC-W-20261031-
// 4VZFO). A request with an unlisted title is placed with no amount; the team
// confirms availability and price with the customer, and Push to Orders asks
// for the amount.
const UNMATCHED_BOOK_FALLBACK_RS = 349;
// A COD order the customer says YES to goes straight to Orders (owner,
// 3 Nov 2026), unless a person should look first: a title we could not price,
// or a bulk order.
const AUTO_PUSH_MAX_COPIES = 10;

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

// ── "Is that the customer, or the author?" ────────────────────────────────
// 4 Nov 2026: asked for the book, name and address together, a customer sent
// "Sanjay Kishore Kaul", the author of the book they wanted. The bot thanked
// "Sanjay" and the request was saved under the author's name. A name matching
// the author of the requested book has to be checked before it is saved.
const nameWords = (s) => String(s || '').toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter((w) => w.length >= 3);

function authorMatchingName(customerName, books, pricing) {
  const name = nameWords(customerName);
  if (!name.length) return '';
  const typed = String(books || '').split(/[,;\n]+/).map((b) => (b.match(/\bby\s+(.+)$/i) || [])[1] || '');
  const items = (pricing && Array.isArray(pricing.items)) ? pricing.items : [];
  const authors = [...typed, ...items.flatMap((i) => String(i.matchedAuthor || '').split(/,|&|\band\b/i))];
  for (const raw of authors) {
    const author = new Set(nameWords(raw));
    if (!author.size) continue;
    const shared = name.filter((w) => author.has(w)).length;
    if (shared >= 2 || shared === name.length) return raw.trim();
  }
  return '';
}

// ── Admin edit of a request ───────────────────────────────────────────────
// Returns { values } for the update, or { error, code }. A pushed request is an
// order now, and a payment link already sent is for one fixed amount.
function buildRequestEdit(req, edit = {}) {
  if (req.order_pushed_id) return { error: `Already pushed as ${req.order_pushed_id}. Edit it from the Orders tab.`, code: 409 };
  if (HIDDEN_STATUSES.includes(req.status)) return { error: 'The customer has not confirmed this order on WhatsApp yet.', code: 409 };

  const customer_name = String(edit.customer_name || '').trim().slice(0, 160);
  const address = String(edit.address || '').trim().slice(0, 600);
  const books = String(edit.books || '').trim().slice(0, 600);
  const notes = String(edit.notes || '').trim().slice(0, 400);
  const payment_mode = edit.payment_mode === 'prepaid' ? 'prepaid' : edit.payment_mode === 'cod' ? 'cod' : '';
  if (customer_name.length < 2) return { error: 'Enter the customer name.', code: 400 };
  if (!books) return { error: 'Enter the book title.', code: 400 };
  if (address.length < 12 && !/\b\d{6}\b/.test(address)) return { error: 'Enter the full delivery address with pincode.', code: 400 };
  if (!payment_mode) return { error: 'Choose COD or Prepaid.', code: 400 };

  const rawAmount = String(edit.amount_rupees ?? '').replace(/[₹,\s]/g, '');
  const rupeesValue = rawAmount === '' ? null : Number(rawAmount);
  if (rupeesValue !== null && (!Number.isFinite(rupeesValue) || rupeesValue <= 0)) return { error: 'Enter the amount in rupees, e.g. 549.', code: 400 };
  const amount_paise = rupeesValue === null ? null : Math.round(rupeesValue) * 100;

  const priceChanged = (Number(req.amount_paise) || 0) !== (amount_paise || 0) || req.payment_mode !== payment_mode;
  if (priceChanged && (req.payment_link || req.payment_status === 'paid')) {
    return { error: 'A payment link has already gone out for this request, so the amount and payment mode cannot change here.', code: 409 };
  }
  return { values: { customer_name, address, books, notes, payment_mode, amount_paise } };
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

// The site-wide sale (utils/site-sale.js) on a bot order, so a chat order costs
// what the same books cost at checkout. `at` is when the draft was priced: the
// confirmation re-prices only for the breakdown and must match the stored total.
// An opt-in sale (a coupon picked on the website) never applies here.
function withSiteSale(pricing, at) {
  const sale = siteSaleDiscount(pricing.subtotalRs, at);
  if (!sale.discount) return pricing;
  const totalRs = pricing.totalRs - sale.discount;
  return { ...pricing, saleRs: sale.discount, saleLabel: sale.label, totalRs, totalPaise: totalRs * 100 };
}

// A matched free-delivery book ships the whole chat order free, as at checkout
// (utils/free-delivery). Any lookup failure keeps the normal charge.
async function withFreeDelivery(db, pricing) {
  const slugs = (pricing.items || []).map((i) => i && i.slug).filter(Boolean);
  if (!pricing.shippingRs || !slugs.length) return pricing;
  let free;
  try { free = await freeDeliveryFor(db, slugs); } catch (e) { console.error('bot-order-request free delivery:', e.message); return pricing; }
  if (!free.size) return pricing;
  const totalRs = pricing.totalRs - pricing.shippingRs;
  return { ...pricing, shippingRs: 0, freeDelivery: true, totalRs, totalPaise: totalRs * 100 };
}

// priceBooksList charges shipping below ₹499 (the COD rule). A prepaid chat
// order ships free above ₹399, as at checkout (utils/free-delivery).
function withPaymentShipping(pricing, paymentMode) {
  if (!pricing.shippingRs || paymentMode !== 'prepaid' || !freeByAmount(pricing.subtotalRs, 'prepaid')) return pricing;
  const totalRs = pricing.totalRs - pricing.shippingRs;
  return { ...pricing, shippingRs: 0, freeDelivery: true, totalRs, totalPaise: totalRs * 100 };
}

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

  const pricing = withSiteSale(withPaymentShipping(await withFreeDelivery(db, await priceSafely(deps.priceBooksList, f.books)), f.paymentMode), nowMs);
  const author = args.name_confirmed === true ? '' : authorMatchingName(f.customerName, f.books, pricing);
  if (author) {
    return {
      ok: false,
      error: 'name_matches_author',
      message: `NOT saved. "${f.customerName}" looks like the author of the book (${author}), not the customer. Do NOT use it as their name. Ask them: "Is ${f.customerName} your own name, or the author of the book? Please send the name to put on the parcel." Then call this tool again with the name they give. Set name_confirmed to true only if they say it really is their own name.`,
    };
  }
  const unlisted = unlistedTitles(pricing);
  const draft = rows.find((r) => r.status === DRAFT && nowMs - new Date(r.created_at).getTime() < DRAFT_TTL_MS);
  const values = {
    customer_name: f.customerName,
    address:       f.address,
    books:         f.books,
    notes:         f.notes,
    payment_mode:  f.paymentMode,
    amount_paise:  unlisted.length ? null : pricing.totalPaise,
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
  const othersNote = others.length ? ` Also mention they already have order ${others.join(', ')} — this would be a separate, additional order.` : '';
  if (unlisted.length) {
    return {
      ok: true,
      needs_confirmation: true,
      price_unknown: true,
      order_id: orderId,
      summary: {
        books: f.books,
        name: f.customerName,
        address: f.address,
        payment_mode: f.paymentMode,
        not_in_catalogue: unlisted,
        price: 'to be confirmed by our team',
      },
      other_open_orders: others,
      message: `NOT PLACED YET, and there is NO PRICE: ${unlisted.join('; ')} ${unlisted.length > 1 ? 'are' : 'is'} not listed in our catalogue. `
        + 'Do NOT quote, estimate or guess any price or total for this order — not even for the other books. Read back the books, name, address and COD/prepaid, '
        + 'and explain that because this title is not listed, our team will check availability and message them the exact price here before anything is shipped or paid. '
        + 'Ask them to reply YES to send this request to the team, or to tell you what to change (they can drop the unlisted title to order the rest now at our listed prices).'
        + othersNote,
    };
  }
  return {
    ok: true,
    needs_confirmation: true,
    order_id: orderId,
    summary: {
      books: f.books,
      name: f.customerName,
      address: f.address,
      payment_mode: f.paymentMode,
      ...(Array.isArray(pricing.items) && pricing.items.length ? {
        items: pricing.items.map((i) => ({ title: i.matchedTitle || i.title || i.query, copies: i.qty || 1, price_each_rs: i.unitPrice ?? i.price, line_rs: i.price })),
      } : {}),
      subtotal_rs: pricing.subtotalRs,
      ...(pricing.saleRs ? { sale_discount_rs: pricing.saleRs, sale: pricing.saleLabel } : {}),
      shipping_rs: pricing.shippingRs,
      ...(pricing.freeDelivery ? { free_delivery: true } : {}),
      total_rs: pricing.totalRs,
    },
    other_open_orders: others,
    message: 'NOT PLACED YET. Read the summary back to the customer (books with the number of copies of each, name, address, COD or prepaid, total) and ask them to reply YES to place the order or tell you what to change. Do not say the order is placed and do not share an order ID yet.'
      + othersNote,
  };
}

/** Titles priceBooksList could not find; their price is only the placeholder. */
function unlistedTitles(pricing) {
  return (pricing && Array.isArray(pricing.unmatched) ? pricing.unmatched : []).filter(Boolean);
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
  if (!Number(row.amount_paise)) {
    const titles = unlistedTitles(pricing);
    return `Your request is placed ✅\nOrder ID: ${row.order_id}\n\n${titles.length ? `${titles.join(', ')} ${titles.length > 1 ? 'are' : 'is'} not listed on our site yet, so` : 'So'} our team will check availability and message you the exact price here. Nothing is shipped${row.payment_mode === 'prepaid' ? ' or charged' : ''} until you agree to it 📚`;
  }
  const total = rupees(row.amount_paise);
  const sale = pricing && pricing.saleRs ? ` − ${pricing.saleLabel} ₹${pricing.saleRs}` : '';
  const ship = pricing && pricing.shippingRs ? ` + shipping ₹${pricing.shippingRs}` : pricing && pricing.freeDelivery ? ' · free delivery 🚚' : '';
  const breakdown = pricing && (pricing.shippingRs || pricing.saleRs || pricing.freeDelivery)
    ? ` (books ₹${pricing.subtotalRs}${sale}${ship})`
    : '';
  if (row.payment_mode === 'prepaid') {
    return paymentLink
      ? `Your order is placed ✅\nOrder ID: ${row.order_id}\nAmount to pay: ₹${total}${breakdown}\n\nTap here to pay securely: ${paymentLink}\n\nAs soon as we receive your payment we'll dispatch it — usually same-day 📚`
      : `Your order is placed ✅\nOrder ID: ${row.order_id}\nAmount to pay: ₹${total}${breakdown}\n\nOur team will send you the payment link shortly 📚`;
  }
  return `Your COD order is placed ✅\nOrder ID: ${row.order_id}\nTotal: ₹${total}${breakdown}\nPay ₹${total} in cash when the courier delivers. We'll dispatch it soon 📚`;
}

/** Why a confirmed COD order must wait for a person instead of going to Orders, or null. */
function autoPushHold(pricing) {
  if (pricing.unmatched && pricing.unmatched.length) return 'a title is not in the catalogue, so its price is a guess';
  const copies = Number(pricing.copies) || (pricing.items || []).reduce((n, i) => n + (Number(i && i.qty) || 1), 0);
  if (copies > AUTO_PUSH_MAX_COPIES) return `bulk order of ${copies} copies`;
  return null;
}

/**
 * The customer's YES/NO to a draft. Returns null when there is no live draft
 * (the message then goes on to the other handlers / the model).
 * A confirmed COD order is pushed to Orders here (deps.pushOrder, which is
 * utils/push-bot-order); prepaid goes there once its link is paid.
 * deps: { db, priceBooksList, createPaymentLink, upsertBotCustomer, notifyOwner, pushOrder?, now? }
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

  const pricing = withSiteSale(withPaymentShipping(await withFreeDelivery(db, await priceSafely(deps.priceBooksList, row.books)), row.payment_mode), new Date(row.created_at).getTime());

  // No amount: an unlisted title, priced by the team, not by a guess.
  const priceNeeded = !Number(row.amount_paise);
  let paymentLink = '';
  let linkError = '';
  if (row.payment_mode === 'prepaid' && !priceNeeded) {
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

  // COD: straight to Orders, the customer's YES being the confirmation the
  // team used to get by phone. The bot's reply below is their confirmation.
  let pushedId = '';
  let pushNote = '';
  if (row.payment_mode !== 'prepaid' && deps.pushOrder) {
    const hold = priceNeeded ? 'no price yet — a title is not in the catalogue' : autoPushHold(pricing);
    if (hold) pushNote = `⚠️ Not pushed automatically: ${hold}. Check it, then Book Requests → Push to Orders.`;
    else {
      try {
        const pushed = await deps.pushOrder({ ...row, status: 'new', customer_confirmed_at: nowIso });
        if (pushed && pushed.ok) pushedId = pushed.order_id;
        else pushNote = `⚠️ Auto-push failed: ${(pushed && pushed.error) || 'unknown'}. Book Requests → Push to Orders.`;
      } catch (e) {
        console.error('confirmDraftOrder push:', e.message);
        pushNote = `⚠️ Auto-push failed: ${e.message}. Book Requests → Push to Orders.`;
      }
    }
  }

  const total = rupees(row.amount_paise);
  const modeLabel = row.payment_mode === 'prepaid'
    ? priceNeeded ? '💳 Prepaid — send a payment link once the price is agreed' : (paymentLink ? `💳 Prepaid — ${paymentLink}` : `💳 Prepaid — ⚠️ link failed: ${linkError || 'unknown'}`)
    : '💵 COD';
  const unmatched = pricing.unmatched && pricing.unmatched.length
    ? `\n⚠️ Not in catalogue: ${pricing.unmatched.join('; ')}` : '';
  try {
    await deps.notifyOwner(
      `🆕 New book order request (WhatsApp bot, confirmed by customer)\n\n🆔 ${row.order_id}\n👤 ${row.customer_name}\n📞 ${row.customer_phone}\n📚 ${row.books}\n📍 ${row.address}\n💰 ${priceNeeded ? 'PRICE NEEDED — confirm availability and price with the customer, then Push to Orders with the agreed amount' : `Total ₹${total}`}${unmatched}\n${modeLabel}${row.notes ? `\n📝 ${row.notes}` : ''}\n\n${
        pushedId ? `✅ Pushed to Orders as ${pushedId} — ship it from the Orders tab.`
        : priceNeeded ? 'Admin → Book Requests: WhatsApp them, then Push to Orders.'
      : pushNote || 'Open admin panel → Book Requests → Push to Orders.'}`);
  } catch (e) { console.error('confirmDraftOrder notifyOwner:', e.message); }

  console.log(`[ORDER-REQUEST] ${row.order_id} ${row.customer_phone} confirmed -> ${String(row.books).slice(0, 60)} mode=${row.payment_mode} total=₹${total}${pushedId ? ` pushed=${pushedId}` : pushNote ? ' not-pushed' : ''}`);
  return { handled: true, placed: true, order_id: row.order_id, pushed_order_id: pushedId || null, reply: placedMessage(row, pricing, paymentLink) };
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
  const amount = r.amount_paise ? ` · ₹${rupees(r.amount_paise)}` : ' · price NOT set — the team will confirm it with the customer; never quote one';
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
  authorMatchingName,
  buildRequestEdit,
  DRAFT, DISCARDED, LIVE, HIDDEN_STATUSES, DRAFT_TTL_MS, AUTO_PUSH_MAX_COPIES,
  validateOrderFields, sameBooks, draftReplyDecision,
  draftOrderRequest, confirmDraftOrder, botOrdersContext, lookupBotRequest, describeRequest,
};
