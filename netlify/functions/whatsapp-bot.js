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
- Support WhatsApp (human team): +91 92171 75546

COUPONS (share only when customer asks about discounts):
- 10% off on prepaid orders above ₹499 (code: INKLOVE10)
- 12% off on prepaid orders above ₹999 (code: SAVE12)
- 15% off on prepaid orders above ₹1499 (code: SAVE15)
- Coupons only apply to Pay Now (not COD)

ORDER TRACKING — "where is my order?" / "order status?" / "AWB?":
- Ask for their Order ID (format IC-YYYYMMDD-XXXXX) if not already shared
- Once you have the order details (from system context), share the AWB/tracking number and courier name
- Tell them to track at: https://www.delhivery.com/track-v2/package/{AWB} or inkandchai.in/track
- If order is not yet shipped, reassure them it will be dispatched soon

DELIVERY TIME — "when will I get my order?" / "kitne din mein aayega?":
- Delhi / NCR: 1-2 business days after dispatch
- Other metros (Mumbai, Bengaluru, Chennai, Hyderabad, Kolkata, Pune): 2-3 business days
- Rest of India: 3-5 business days
- Always say "after dispatch" — remind them to check tracking for live updates

ORDER CANCELLATION — "cancel my order" / "order cancel karna hai":
- Cancellations are possible before the order is shipped
- Ask them to email subject "Cancel Order" with their Order ID to: support@inkandchai.in
- Or they can WhatsApp the human support team at +91 92171 75546
- If already shipped, cancellation is not possible but they can return it after delivery

RETURN & REFUND — "wrong book", "different product", "refund chahiye", "return karna hai":
- Be very reassuring: their money is completely safe with us 💚
- Wrong book / different product received: FULL refund, no questions asked
- 7-day return window from delivery for any reason
- How to initiate: WhatsApp +91 92171 75546 or email support@inkandchai.in
- Our team replies within 24 hours, 7 days a week
- Refund is processed within 5-7 business days after we receive the book back
- For wrong/different product: we also arrange free pickup

DAMAGED BOOK:
- Full replacement or refund — no questions asked
- Customer must send a photo of the damage within 24 hours of delivery
- Contact: WhatsApp +91 92171 75546 or support@inkandchai.in

WHAT YOU CANNOT DO:
- Cannot place or modify orders (direct to website)
- Cannot process refunds directly (direct to support team)
- Cannot share personal data of other customers
- If unsure about anything, say "Let me check with our team and get back to you!" and end with: [ESCALATE]

ORDER STATUS LOOKUP:
- If the conversation includes order details (from the system), present them clearly including AWB and tracking link
- If customer mentions an Order ID but no data is provided, ask them to share it so you can look it up`;

// ── Per-user conversation memory (in-memory, resets on cold start) ────────────
// For production persistence use Supabase, but in-memory works for 90% of cases
// since Netlify keeps functions warm for ~15 min between messages.
const conversationHistory = new Map(); // phone → [{role, content}]
const MAX_HISTORY = 10; // last 10 messages kept per user

function getHistory(phone) {
  return conversationHistory.get(phone) || [];
}

function appendHistory(phone, role, content) {
  const hist = getHistory(phone);
  hist.push({ role, content });
  // Keep only last MAX_HISTORY messages
  if (hist.length > MAX_HISTORY) hist.splice(0, hist.length - MAX_HISTORY);
  conversationHistory.set(phone, hist);
}

// ── Look up order by ID in Supabase ──────────────────────────────────────────
async function lookupOrder(orderId) {
  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const { data } = await supabase
      .from('orders')
      .select('razorpay_order_id, status, customer_name, amount_paise, created_at, tracking_id, courier_name, tracking_url')
      .or(`razorpay_order_id.eq.${orderId},id.eq.${orderId}`)
      .maybeSingle();
    return data || null;
  } catch { return null; }
}

// ── Send a plain text WhatsApp message ───────────────────────────────────────
async function sendReply(to, text) {
  const token = process.env.WHATSAPP_TOKEN;
  if (!token) { console.warn('WHATSAPP_TOKEN not set'); return; }

  const phone = normalizePhone(to) || to;
  await fetch(WA_URL, {
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

// ── Ask OpenAI ────────────────────────────────────────────────────────────────
async function askOpenAI(phone, userMessage, extraContext = '') {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY not set');

  appendHistory(phone, 'user', userMessage);

  const systemContent = extraContext
    ? SYSTEM_PROMPT + '\n\nORDER CONTEXT FOR THIS CONVERSATION:\n' + extraContext
    : SYSTEM_PROMPT;

  const messages = [
    { role: 'system', content: systemContent },
    ...getHistory(phone),
  ];

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4o-mini',    // Fast + cheap — ~$0.0003 per message
      messages,
      max_tokens: 300,
      temperature: 0.7,
    }),
  });

  const data = await res.json();
  if (!res.ok) throw new Error(`OpenAI error ${res.status}: ${data.error?.message || JSON.stringify(data)}`);

  const reply = data.choices?.[0]?.message?.content?.trim() || "Sorry, I couldn't process that. Please try again!";
  appendHistory(phone, 'assistant', reply);
  return reply;
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

    const msg     = value.messages[0];
    const msgId   = msg.id;
    const from    = msg.from;  // sender's WhatsApp phone number

    // Dedupe
    if (processedMsgIds.has(msgId)) return { statusCode: 200, body: 'ok' };
    processedMsgIds.add(msgId);
    if (processedMsgIds.size > 500) {
      // Trim set to avoid memory leak on long-lived instances
      const arr = [...processedMsgIds];
      arr.splice(0, 250).forEach(id => processedMsgIds.delete(id));
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
      await sendReply(from, "Hi! I can only read text messages right now 😊 Please type your question and I'll help you out!");
      return { statusCode: 200, body: 'ok' };
    }

    if (!userText) return { statusCode: 200, body: 'ok' };

    console.log(`[IN]  ${from}: ${userText.slice(0, 120)}`);

    // ── Check if message contains an Order ID — look it up ───────────────────
    let extraContext = '';
    const orderId = extractOrderId(userText);
    if (orderId) {
      const order = await lookupOrder(orderId);
      if (order) {
        const amt   = order.amount_paise ? `₹${(order.amount_paise / 100).toLocaleString('en-IN')}` : '—';
        const date  = order.created_at ? new Date(order.created_at).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' }) : '—';
        const track = order.tracking_id ? `${order.courier_name || 'Courier'} AWB: ${order.tracking_id}` : 'Not yet shipped';
        const trackUrl = order.tracking_url || `https://inkandchai.in/track/?id=${encodeURIComponent(orderId)}`;
        extraContext = `Order ID: ${orderId}\nCustomer: ${order.customer_name}\nAmount: ${amt}\nDate: ${date}\nStatus: ${order.status}\nTracking: ${track}\nTrack URL: ${trackUrl}`;
      } else {
        extraContext = `Order ID ${orderId} was not found in our system.`;
      }
    }

    // ── Get AI reply ──────────────────────────────────────────────────────────
    let reply = await askOpenAI(from, userText, extraContext);

    // If AI flagged escalation, notify owner and soften message
    if (reply.includes('[ESCALATE]')) {
      reply = reply.replace('[ESCALATE]', '').trim();
      const ownerPhone = process.env.STORE_OWNER_PHONE;
      if (ownerPhone) {
        await sendReply(ownerPhone,
          `⚠️ WhatsApp bot escalation needed\nFrom: ${from}\nMessage: "${userText.slice(0, 200)}"`
        );
      }
    }

    await sendReply(from, reply);
    console.log(`[OUT] ${from}: ${reply.slice(0, 120)}`);

  } catch (err) {
    console.error('whatsapp-bot error:', err.message);
    // Don't let errors surface to Meta (it would retry)
  }

  return { statusCode: 200, body: 'ok' };
};
