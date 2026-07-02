/**
 * Netlify Function: whatsapp-bot
 *
 * Two roles:
 *   GET  — webhook verification (Meta one-time handshake)
 *   POST — incoming message handler → OpenAI → reply via WhatsApp
 *
 * Required env vars:
 *   WHATSAPP_TOKEN          — permanent system user token (same as existing)
 *   WHATSAPP_PHONE_ID       — phone number ID (same as existing)
 *   WHATSAPP_VERIFY_TOKEN   — any secret string you choose for webhook verification
 *   OPENAI_API_KEY          — OpenAI secret key
 *   SUPABASE_URL            — (already set)
 *   SUPABASE_SERVICE_KEY    — (already set)
 *
 * Setup steps (one-time in Meta Developer Console):
 *   Webhook URL:    https://inkandchai.in/.netlify/functions/whatsapp-bot
 *   Verify Token:   value of WHATSAPP_VERIFY_TOKEN env var
 *   Subscribe to:   messages
 */

const { createClient } = require('@supabase/supabase-js');
const { normalizePhone } = require('./utils/whatsapp');

const PHONE_ID   = process.env.WHATSAPP_PHONE_ID || '1188708014316574';
const API_VER    = 'v20.0';
const WA_URL     = `https://graph.facebook.com/${API_VER}/${PHONE_ID}/messages`;

// ── Knowledge base injected into every AI conversation ───────────────────────
const SYSTEM_PROMPT = `You are Chai, the friendly customer support assistant for Ink & Chai (inkandchai.in) — an online bookstore based in India that sells books at discounted prices with fast delivery.

PERSONALITY:
- Warm, helpful, and slightly playful — like a knowledgeable friend at a bookshop
- Keep replies SHORT (2-4 sentences max) unless customer needs detailed help
- Always reply in the same language the customer used (Hindi or English)
- Use emojis sparingly but naturally 📚☕
- Never make the customer feel anxious — always reassure them their money and order are safe

ABOUT INK & CHAI:
- We sell fiction, non-fiction, self-help, Hindi books and more at 40-60% off MRP
- Free shipping on orders above ₹499, else ₹40 flat
- Pan-India delivery via Delhivery courier
- Payment: PhonePe, Razorpay (UPI/cards), Cash on Delivery, or 10% now + 90% on delivery
- Website: inkandchai.in
- Support email: support@inkandchai.in
- Support WhatsApp (human team): +91 76784 00508

COUPONS (share only when customer asks about discounts):
- 10% off on prepaid orders above ₹499 (code: INKLOVE10)
- 12% off on prepaid orders above ₹999 (code: SAVE12)
- 15% off on prepaid orders above ₹1499 (code: SAVE15)
- Coupons only apply to Pay Now (not COD)

ORDER TRACKING — "where is my order?" / "order status?" / "AWB?":
- If order details are already in the system context (looked up by their phone number), share them immediately — do NOT ask for the order ID again
- If multiple orders are in context, mention all of them briefly and highlight the most recent
- If no order details are in context, ask for their Order ID (format IC-YYYYMMDD-XXXXX — they can find it in their confirmation SMS/email or at inkandchai.in → My Orders)
- Once you have the order details, share the AWB/tracking number and courier name
- Tell them to track at: https://inkandchai.in/track or delhivery.com (if Delhivery AWB)
- If order is not yet shipped, reassure them it will be dispatched soon

DELIVERY TIME — "when will I get my order?" / "kitne din mein aayega?":
- Delhi / NCR: 1-2 business days after dispatch
- Other metros (Mumbai, Bengaluru, Chennai, Hyderabad, Kolkata, Pune): 2-3 business days
- Rest of India: 3-5 business days
- Always say "after dispatch" — remind them to check tracking for live updates

ORDER CANCELLATION — "cancel my order" / "order cancel karna hai":
- Customers can cancel their own order instantly from the website — no need to contact support
- Steps: Go to inkandchai.in → tap the 👤 icon (top right) → sign in → open "My Orders" → tap "Cancel Order" next to the order
- Cancellations are only possible before the order is shipped
- COD orders cancel immediately; prepaid orders get an automatic refund within 5–7 business days
- If already shipped, cancellation is not possible but they can return it after delivery
- If they face trouble cancelling on the website, they can WhatsApp +91 76784 00508 or email support@inkandchai.in

RETURN & REFUND — "wrong book", "different product", "refund chahiye", "return karna hai":
- Be very reassuring: their money is completely safe with us 💚
- Wrong book / different product received: FULL refund, no questions asked
- 7-day return window from delivery for any reason
- Always share this direct WhatsApp link to connect them with our team: https://wa.me/917678400508
- Message to send: "To get your refund processed, please tap this link to chat directly with our support team 👉 https://wa.me/917678400508 — they'll sort it out for you right away!"
- Our team replies within 24 hours, 7 days a week
- Refund is processed within 5-7 business days after we receive the book back
- For wrong/different product: we also arrange free pickup

DAMAGED BOOK:
- Full replacement or refund — no questions asked
- Customer must send a photo of the damage within 24 hours of delivery
- Always share the direct WhatsApp link: https://wa.me/917678400508
- Message to send: "Please tap here to chat with our team directly 👉 https://wa.me/917678400508 — share a photo of the damage and they'll arrange a replacement or refund immediately!"

HUMAN AGENT / ESCALATION — customer says "talk to human", "real person", "agent se baat karni hai", "support chahiye":
- Immediately share: https://wa.me/917678400508
- Message to send: "Sure! Tap this link to connect directly with our support team 👉 https://wa.me/917678400508 — they're available 7 days a week and will help you right away 😊"

WHAT YOU CANNOT DO:
- Cannot place or modify orders (direct to website)
- Cannot process refunds directly (always share https://wa.me/917678400508 for refund requests)
- Cannot share personal data of other customers
- If unsure about anything, share https://wa.me/917678400508 and say "Let me connect you with our team!" and end with: [ESCALATE]

ORDER STATUS LOOKUP:
- If the conversation includes order details (from the system), present them clearly including AWB and tracking link
- If customer mentions an Order ID but no data is provided, ask them to share it so you can look it up

ORDER STATUS MEANINGS — explain reassuringly when you see these statuses in the order context:
- "pending_pickup" / "pending pickup" / "awaiting pickup": This usually means the book is temporarily OUT OF STOCK from our supplier and we're waiting to restock before pickup. Reassure the customer STRONGLY that their money is 100% safe and secure with us — nothing is lost. Their order will either be dispatched as soon as the book is back in stock, or fully refunded if it can't be sourced. Tell them there is absolutely nothing to worry about.
- "cancelled": The order has been cancelled. Tell the customer their money is completely safe and a refund will be issued. Ask them to email their Order ID to refund@inkandchai.in and our team will process the refund to their original payment method within 5-7 business days. Be warm and reassuring — no money is ever lost with us.
- "refunded": The refund has already been processed and will reflect in their account within 5-7 business days.

MONEY SAFETY — this is critical, always lead with reassurance:
- Whenever a customer sounds worried about their money, order, or a delay, IMMEDIATELY reassure them: "Please don't worry at all — your money is 100% safe and secure with us 💚. We're a genuine registered business and every rupee is protected."
- Never let a customer feel anxious. Reassurance first, then the practical next step.

MISSING BOOK IN A MULTI-BOOK ORDER — customer says "I ordered 3 books but got 2", "one book missing", "ek book nahi aayi", "incomplete order":
- Apologise warmly and reassure them their money for the missing book is completely safe.
- Tell them: for the missing book, we'll issue a refund of that book's amount. Ask them to email their Order ID and the name of the missing book to refund@inkandchai.in — our team will refund it to their original payment method within 5-7 business days.
- They do NOT need to return the books they did receive.
- Alternatively, if they'd prefer we reship the missing book instead of a refund, they can mention that in the same email.

REFUND EMAIL — whenever a refund is involved (cancelled order, missing book, etc.), the correct channel is: refund@inkandchai.in (ask them to include their Order ID). This is different from general support (support@inkandchai.in).

PLACING A NEW ORDER — customer says "I want to order a book", "mujhe book chahiye", "how do I buy", "order karna hai", or names a book they want to buy:
- Offer to take their order right here on WhatsApp. Collect these details ONE at a time, conversationally (don't dump all questions at once):
  1. The book name(s) they want
  2. Their full name
  3. Their complete delivery address with pincode
- Once you have ALL THREE (book name, name, full address), call the submit_order_request tool to send it to our team. Do NOT claim the order is placed until the tool has been called.
- After the tool succeeds, confirm warmly: "Got it! I've sent your request to our team — they'll confirm your order and share payment/delivery details shortly on WhatsApp 📚"
- Also let them know they can order instantly themselves at inkandchai.in if they prefer.`;

// ── Per-user conversation memory (in-memory cache + Supabase persistence) ────
const conversationHistory = new Map(); // phone → [{role, content}]
const MAX_HISTORY = 10;

function getHistory(phone) {
  return conversationHistory.get(phone) || [];
}

function appendHistory(phone, role, content) {
  const hist = getHistory(phone);
  hist.push({ role, content });
  if (hist.length > MAX_HISTORY) hist.splice(0, hist.length - MAX_HISTORY);
  conversationHistory.set(phone, hist);
}

// ── Persist a message to Supabase + update conversation row ──────────────────
async function persistMessage(phone, role, message, customerName = null) {
  try {
    const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const now = new Date().toISOString();
    const preview = (role === 'user' ? message : `[Bot]: ${message}`).slice(0, 100);

    // Insert message
    await db.from('bot_messages').insert({ customer_phone: phone, role, message, created_at: now });

    // Upsert conversation summary
    const convUpdate = {
      customer_phone:  phone,
      last_message:    preview,
      last_message_at: now,
      status:          'active',
    };
    if (customerName) convUpdate.customer_name = customerName;
    // Only increment unread for inbound customer messages
    if (role === 'user') {
      // Use raw SQL increment via rpc — fallback: just set a flag
      const { data: existing } = await db.from('bot_conversations')
        .select('unread_count').eq('customer_phone', phone).maybeSingle();
      convUpdate.unread_count = ((existing?.unread_count) || 0) + 1;
    }

    await db.from('bot_conversations').upsert(convUpdate, { onConflict: 'customer_phone' });
  } catch (e) {
    // Non-fatal — don't break the main flow
    console.error('persistMessage error:', e.message);
  }
}

// ── Check if this conversation has human takeover active ──────────────────────
async function isHumanTakeover(phone) {
  try {
    const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const { data } = await db.from('bot_conversations')
      .select('human_takeover')
      .eq('customer_phone', phone)
      .maybeSingle();
    return data?.human_takeover === true;
  } catch { return false; }
}

// ── Look up order by IC- display ID in Supabase ──────────────────────────────
// All order types (Razorpay, PhonePe, COD) store the IC-YYYYMMDD-XXXXX id
// in the razorpay_order_id column. The `id` column is a UUID — never query it
// with an IC- string or Supabase throws a UUID format error.
async function lookupOrder(orderId) {
  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const { data, error } = await supabase
      .from('orders')
      .select('razorpay_order_id, status, customer_name, amount_paise, created_at, tracking_id, courier_name, tracking_url')
      .eq('razorpay_order_id', orderId.toUpperCase())
      .maybeSingle();
    if (error) console.error('lookupOrder error:', error.message);
    return data || null;
  } catch (e) { console.error('lookupOrder exception:', e.message); return null; }
}

// ── Look up most recent orders by customer phone ──────────────────────────────
// Called when customer messages without sharing an order ID — lets us proactively
// show their latest order status without asking them to type the order ID.
async function lookupOrdersByPhone(phone) {
  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    // Normalise: strip country code to get 10-digit number, then try both formats
    const digits = phone.replace(/\D/g, '');
    const ten = digits.length >= 10 ? digits.slice(-10) : digits;
    const { data, error } = await supabase
      .from('orders')
      .select('razorpay_order_id, status, customer_name, amount_paise, created_at, tracking_id, courier_name, tracking_url')
      .or(`customer_phone.eq.${ten},customer_phone.eq.91${ten},customer_phone.eq.+91${ten}`)
      .order('created_at', { ascending: false })
      .limit(3);
    if (error) console.error('lookupOrdersByPhone error:', error.message);
    return data || [];
  } catch (e) { console.error('lookupOrdersByPhone exception:', e.message); return []; }
}

// ── Send a plain text WhatsApp message ───────────────────────────────────────
// Reply through the SAME phone number that received the customer's message
// (Meta puts it in the webhook payload as value.metadata.phone_number_id).
// One bot, both numbers: each replies through itself. Falls back to the
// env-configured PHONE_ID when the caller doesn't know the sender.
async function sendReply(to, text, senderPhoneId) {
  const token = process.env.WHATSAPP_TOKEN;
  if (!token) { console.warn('WHATSAPP_TOKEN not set'); return; }

  const phoneId = senderPhoneId || PHONE_ID;
  const url = `https://graph.facebook.com/${API_VER}/${phoneId}/messages`;

  const phone = normalizePhone(to) || to;
  await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: phone,
      type: 'text',
      text: { body: text, preview_url: false },
    }),
  }).catch(e => console.error('sendReply error:', e.message));
}

// ── High-value COD confirmation handler ───────────────────────────────────────
// Finds the customer's most recent COD order awaiting confirmation and either
// confirms it (-> cod_pending, ready to ship) or cancels it. Matched by the last
// 10 digits of the phone number. Returns true if an order was acted on.
async function handleCodConfirm(from, decision, senderPhoneId) {
  try {
    const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const last10 = String(from).replace(/\D/g, '').slice(-10);
    const { data: orders } = await db
      .from('orders')
      .select('id, razorpay_order_id, customer_phone, created_at')
      .eq('status', 'cod_awaiting_confirmation')
      .order('created_at', { ascending: false })
      .limit(30);
    const order = (orders || []).find(
      o => String(o.customer_phone || '').replace(/\D/g, '').slice(-10) === last10
    );
    if (!order) return false;

    if (decision === 'cancel') {
      await db.from('orders').update({ status: 'cancelled' }).eq('id', order.id);
      await sendReply(from, `Your order ${order.razorpay_order_id} has been cancelled. If that was a mistake, just reply here and we'll help. 💛`, senderPhoneId);
    } else {
      await db.from('orders').update({ status: 'cod_pending' }).eq('id', order.id);
      await sendReply(from, `✅ Thank you! Your order ${order.razorpay_order_id} is confirmed and will be shipped soon. You'll get tracking on WhatsApp once it's dispatched.`, senderPhoneId);
    }
    console.log(`[COD-CONFIRM] ${from} -> ${decision} -> ${order.razorpay_order_id}`);
    return true;
  } catch (e) {
    console.error('handleCodConfirm error:', e.message);
    return false;
  }
}

// ── OpenAI tool: take a book order over WhatsApp → admin panel ────────────────
const OPENAI_TOOLS = [{
  type: 'function',
  function: {
    name: 'submit_order_request',
    description: 'Send a customer\'s book order request to the Ink & Chai team / admin panel. Call this ONLY after you have collected the book name(s), the customer\'s full name, and their complete delivery address including pincode.',
    parameters: {
      type: 'object',
      properties: {
        customer_name: { type: 'string', description: 'Customer full name' },
        address:       { type: 'string', description: 'Complete delivery address including pincode' },
        books:         { type: 'string', description: 'Book name(s) the customer wants to order, comma-separated' },
        notes:         { type: 'string', description: 'Any extra notes (quantity, language, edition, etc.)' },
      },
      required: ['customer_name', 'address', 'books'],
    },
  },
}];

async function callOpenAIChat(messages, { tools = false } = {}) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY not set');
  const payload = {
    model: 'gpt-4o-mini',    // Fast + cheap — ~$0.0003 per message
    messages,
    max_tokens: 320,
    temperature: 0.7,
  };
  if (tools) { payload.tools = OPENAI_TOOLS; payload.tool_choice = 'auto'; }
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`OpenAI error ${res.status}: ${data.error?.message || JSON.stringify(data)}`);
  return data.choices?.[0]?.message || {};
}

// ── Ask OpenAI (with order-intake tool support) ──────────────────────────────
async function askOpenAI(phone, userMessage, extraContext = '') {
  appendHistory(phone, 'user', userMessage);

  const systemContent = extraContext
    ? SYSTEM_PROMPT + '\n\nORDER CONTEXT FOR THIS CONVERSATION:\n' + extraContext
    : SYSTEM_PROMPT;

  const messages = [
    { role: 'system', content: systemContent },
    ...getHistory(phone),
  ];

  // First pass — the model may decide to call submit_order_request.
  const first = await callOpenAIChat(messages, { tools: true });

  if (first.tool_calls && first.tool_calls.length) {
    // Execute each tool call, then ask the model for a natural confirmation reply.
    messages.push(first);
    for (const call of first.tool_calls) {
      let result = { ok: false, error: 'unknown tool' };
      if (call.function?.name === 'submit_order_request') {
        let args = {};
        try { args = JSON.parse(call.function.arguments || '{}'); } catch {}
        result = await submitOrderRequest(phone, args);
      }
      messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
    }
    const second = await callOpenAIChat(messages, { tools: false });
    const reply = (second.content || '').trim() || 'Got it! I\'ve sent your request to our team — they\'ll confirm shortly 📚';
    appendHistory(phone, 'assistant', reply);
    return reply;
  }

  const reply = (first.content || '').trim() || "Sorry, I couldn't process that. Please try again!";
  appendHistory(phone, 'assistant', reply);
  return reply;
}

// ── Persist a WhatsApp book-order request + notify the store owner ────────────
async function submitOrderRequest(phone, args) {
  const last10 = String(phone).replace(/\D/g, '').slice(-10);
  const customerName = String(args.customer_name || '').slice(0, 160).trim();
  const address      = String(args.address || '').slice(0, 600).trim();
  const books        = String(args.books || '').slice(0, 600).trim();
  const notes        = String(args.notes || '').slice(0, 400).trim();
  if (!customerName || !address || !books) {
    return { ok: false, error: 'Missing name, address, or book name.' };
  }
  try {
    const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const { data, error } = await db.from('bot_order_requests').insert({
      customer_phone: last10,
      customer_name:  customerName,
      address,
      books,
      notes,
      status:         'new',
      created_at:     new Date().toISOString(),
    }).select('id').maybeSingle();
    if (error) { console.error('submitOrderRequest insert:', error.message); return { ok: false, error: error.message }; }

    // Notify the store owner on WhatsApp so they can action it immediately.
    const ownerPhone = process.env.STORE_OWNER_PHONE;
    if (ownerPhone) {
      await sendReply(ownerPhone,
        `🆕 New book order request (WhatsApp bot)\n\n👤 ${customerName}\n📞 ${last10}\n📚 ${books}\n📍 ${address}${notes ? `\n📝 ${notes}` : ''}\n\nOpen admin panel → Book Requests to process.`
      );
    }
    console.log(`[ORDER-REQUEST] ${last10} -> ${books.slice(0, 60)}`);
    return { ok: true, message: 'Order request sent to the team.' };
  } catch (e) {
    console.error('submitOrderRequest exception:', e.message);
    return { ok: false, error: e.message };
  }
}

// ── Extract Order ID from message ─────────────────────────────────────────────
function extractOrderId(text) {
  const match = text.match(/\bIC-\d{8}-[A-Z0-9]{5}\b/i);
  return match ? match[0].toUpperCase() : null;
}

// ── Dedupe: track processed message IDs to avoid double-handling ──────────────
const processedMsgIds = new Set();

// ── Main handler ──────────────────────────────────────────────────────────────
exports.handler = async (event) => {

  // ── Webhook verification (GET from Meta) ────────────────────────────────────
  if (event.httpMethod === 'GET') {
    const p = event.queryStringParameters || {};
    if (
      p['hub.mode'] === 'subscribe' &&
      p['hub.verify_token'] === process.env.WHATSAPP_VERIFY_TOKEN
    ) {
      console.log('WhatsApp webhook verified ✅');
      return { statusCode: 200, body: p['hub.challenge'] };
    }
    return { statusCode: 403, body: 'Forbidden' };
  }

  // ── Incoming message (POST from Meta) ───────────────────────────────────────
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  // Always return 200 immediately — Meta will retry on non-200
  // Process asynchronously
  let body;
  try { body = JSON.parse(event.body); } catch { return { statusCode: 200, body: 'ok' }; }

  try {
    const entry   = body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value   = changes?.value;

    // Ignore status updates (delivery receipts etc.)
    if (!value?.messages?.length) return { statusCode: 200, body: 'ok' };

    const msg           = value.messages[0];
    const msgId         = msg.id;
    const from          = msg.from;  // sender's WhatsApp phone number
    // The number that RECEIVED this message. We reply through the same one so
    // that customers messaging 7678400508 hear back from 7678400508, and those
    // messaging 9217175546 hear back from 9217175546. Both share this handler.
    const recvPhoneId   = value?.metadata?.phone_number_id || PHONE_ID;

    // Dedupe
    if (processedMsgIds.has(msgId)) return { statusCode: 200, body: 'ok' };
    processedMsgIds.add(msgId);
    if (processedMsgIds.size > 500) {
      // Trim set to avoid memory leak on long-lived instances
      const arr = [...processedMsgIds];
      arr.splice(0, 250).forEach(id => processedMsgIds.delete(id));
    }

    // ── High-value COD confirmation buttons (Confirm / Cancel) ───────────────
    // Template quick-reply buttons arrive as type 'button'; interactive buttons as
    // 'interactive'. If this is a Confirm/Cancel tap and the customer has a COD
    // order awaiting confirmation, act on it and stop (don't run the AI bot).
    if (msg.type === 'button' || msg.type === 'interactive') {
      const btnText = (
        msg.button?.text || msg.button?.payload ||
        msg.interactive?.button_reply?.title || msg.interactive?.button_reply?.id || ''
      ).toLowerCase();
      if (btnText.includes('confirm') || btnText.includes('cancel')) {
        const handled = await handleCodConfirm(from, btnText.includes('cancel') ? 'cancel' : 'confirm', recvPhoneId);
        if (handled) return { statusCode: 200, body: 'ok' };
      }
    }

    // Only handle text messages for now
    let userText = '';
    if (msg.type === 'text') {
      userText = msg.text?.body?.trim() || '';
    } else if (msg.type === 'interactive') {
      // Button/list replies
      userText = msg.interactive?.button_reply?.title || msg.interactive?.list_reply?.title || '';
    } else {
      // Audio, image, etc — politely decline
      await sendReply(from, "Hi! I can only read text messages right now 😊 Please type your question and I'll help you out!", recvPhoneId);
      return { statusCode: 200, body: 'ok' };
    }

    if (!userText) return { statusCode: 200, body: 'ok' };

    console.log(`[IN]  ${from}: ${userText.slice(0, 120)}`);

    // ── Persist inbound message ───────────────────────────────────────────────
    await persistMessage(from, 'user', userText);

    // ── If human has taken over this conversation, just persist + stop ────────
    if (await isHumanTakeover(from)) {
      console.log(`[TAKEOVER] ${from} — bot suppressed, human handling`);
      return { statusCode: 200, body: 'ok' };
    }

    // ── Check if message contains an Order ID — look it up ───────────────────
    let extraContext = '';
    const orderId = extractOrderId(userText);

    // Helper: format a single order row into readable context for the AI
    function formatOrderContext(order, displayId) {
      const id    = displayId || order.razorpay_order_id || '—';
      const amt   = order.amount_paise ? `₹${(order.amount_paise / 100).toLocaleString('en-IN')}` : '—';
      const date  = order.created_at ? new Date(order.created_at).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' }) : '—';
      const track = order.tracking_id ? `${order.courier_name || 'Courier'} AWB: ${order.tracking_id}` : 'Not yet shipped';
      const trackUrl = order.tracking_url || `https://inkandchai.in/track/?id=${encodeURIComponent(id)}`;
      return `Order ID: ${id}\nCustomer: ${order.customer_name}\nAmount: ${amt}\nDate: ${date}\nStatus: ${order.status}\nTracking: ${track}\nTrack URL: ${trackUrl}`;
    }

    if (orderId) {
      // Customer explicitly shared an order ID — look it up directly
      const order = await lookupOrder(orderId);
      if (order) {
        extraContext = formatOrderContext(order, orderId);
      } else {
        extraContext = `Order ID ${orderId} was searched in our database but was not found. This could mean the customer typed it incorrectly, or it belongs to a different account. Ask them to double-check the order ID from their confirmation email/SMS or from My Orders on inkandchai.in.`;
      }
    } else {
      // No order ID in message — check if message is order-related and look up by phone
      const isOrderQuery = /order|track|deliver|ship|dispatch|status|awb|courier|kahan|kab|mila|parcel|packet|book.*aaya|aaya.*book/i.test(userText);
      if (isOrderQuery) {
        const orders = await lookupOrdersByPhone(from);
        if (orders.length > 0) {
          extraContext = `Customer's recent orders (looked up by their WhatsApp number):\n` +
            orders.map((o, i) => `--- Order ${i + 1} ---\n${formatOrderContext(o, o.razorpay_order_id)}`).join('\n');
        }
      }
    }

    // ── Get AI reply ──────────────────────────────────────────────────────────
    let reply = await askOpenAI(from, userText, extraContext);

    // If AI flagged escalation, notify owner and switch to human takeover
    if (reply.includes('[ESCALATE]')) {
      reply = reply.replace('[ESCALATE]', '').trim();
      const ownerPhone = process.env.STORE_OWNER_PHONE;
      if (ownerPhone) {
        // Owner escalation always through the env-configured bot number.
        await sendReply(ownerPhone,
          `⚠️ Bot escalation needed\nFrom: wa.me/${from}\nMessage: "${userText.slice(0, 200)}"\n\nCustomer needs human help. Go to admin panel → Bot Inbox to take over.`
        );
      }
      // Auto-enable human takeover so the bot stops replying
      try {
        const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
        await db.from('bot_conversations').upsert({
          customer_phone: from,
          human_takeover: true,
          status: 'active',
          last_message_at: new Date().toISOString(),
        }, { onConflict: 'customer_phone' });
      } catch (e) { console.error('takeover upsert error:', e.message); }
    }

    await sendReply(from, reply, recvPhoneId);
    // Persist bot reply (reset unread — bot replied so nothing new for admin)
    await persistMessage(from, 'bot', reply);
    console.log(`[OUT] ${from}: ${reply.slice(0, 120)}`);

  } catch (err) {
    console.error('whatsapp-bot error:', err.message);
    // Don't let errors surface to Meta (it would retry)
  }

  return { statusCode: 200, body: 'ok' };
};
