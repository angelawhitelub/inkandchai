/**
 * Netlify Function: admin-screenshot-order   (owner only)
 *
 * Admin "📸 Order from screenshot": turn screenshots of a WhatsApp chat into a
 * real order, through the same path as a WhatsApp bot order.
 *
 * POST { action: 'read', images: [dataURL, …] }
 *   → { fields, pricing, existing }   reads the chat (OpenAI vision), prices the
 *     books from the catalogue, lists this number's recent requests/orders.
 *     Writes nothing.
 * POST { action: 'price', fields }
 *   → { pricing }   re-price after the admin edits books or COD/prepaid.
 * POST { action: 'create', fields, confirm_existing?, notify? }
 *   → { ok, order_id, request_id }   saves a bot_order_requests row (status new)
 *     and pushes it to Orders with pushBotOrder, exactly like "Push to Orders"
 *     on a WhatsApp request: COD → cod_pending, prepaid only when the payment
 *     is already received. notify (default true) sends the customer the usual
 *     order-confirmed WhatsApp and the owner ping.
 *
 * Prices never come from the picture; the model only reads names, numbers,
 * address and books (utils/screenshot-order.js).
 */

const { createClient } = require('@supabase/supabase-js');
const { requireAdmin } = require('./utils/admin-auth');
const { priceBooksList } = require('./utils/book-lookup');
const { priceChatOrder, unlistedTitles, mintOrderId, sameBooks, LIVE_STATUSES } = require('./utils/bot-order-request');
const { pushBotOrder } = require('./utils/push-bot-order');
const so = require('./utils/screenshot-order');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Token, X-Admin-Key',
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
};
const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });
const db = () => createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

async function readScreenshots(images, { fetchImpl = fetch, model = process.env.SCREENSHOT_ORDER_MODEL || 'gpt-4o' } = {}) {
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is not set');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  try {
    const res = await fetchImpl('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: 900,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: so.PROMPT },
          { role: 'user', content: [
            { type: 'text', text: `${images.length} screenshot(s) of one chat, in order. Return the JSON.` },
            ...images.map((url) => ({ type: 'image_url', image_url: { url, detail: 'high' } })),
          ] },
        ],
      }),
      signal: controller.signal,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`OpenAI ${res.status}: ${body.error?.message || 'request failed'}`);
    try { return JSON.parse(body.choices?.[0]?.message?.content || '{}'); }
    catch { throw new Error('Could not read the screenshot (the model returned no JSON). Try a clearer screenshot.'); }
  } finally {
    clearTimeout(timer);
  }
}

async function price(supabase, fields) {
  const books = so.booksString(fields.books);
  if (!books) return null;
  const mode = fields.payment_mode === 'prepaid' ? 'prepaid' : 'cod';
  const p = await priceChatOrder({ db: supabase, priceBooksList }, books, mode);
  return {
    books,
    items: (p.items || []).map((i) => ({
      asked: i.query || i.title, matched: i.matched ? i.matchedTitle : null, slug: i.slug || null,
      qty: i.qty || 1, unit_rs: i.unitPrice ?? i.price, line_rs: i.price,
    })),
    subtotal_rs: p.subtotalRs,
    shipping_rs: p.shippingRs,
    sale_rs: p.saleRs || 0,
    sale_label: p.saleLabel || '',
    free_delivery: !!p.freeDelivery,
    total_rs: unlistedTitles(p).length ? null : p.totalRs,
    unlisted: unlistedTitles(p),
    removed: Array.isArray(p.removed) ? p.removed.filter(Boolean) : [],
  };
}

/** This customer's recent WhatsApp requests and orders, so nothing is placed twice. */
async function existingFor(supabase, phones) {
  const tens = [...new Set((phones || []).map(so.mobile).filter(Boolean))];
  if (!tens.length) return { requests: [], orders: [] };
  const since = new Date(Date.now() - 30 * 86400000).toISOString();
  const orFilter = tens.flatMap((t) => [`customer_phone.eq.${t}`, `customer_phone.eq.91${t}`, `customer_phone.eq.+91${t}`]).join(',');
  const [reqs, orders] = await Promise.all([
    supabase.from('bot_order_requests').select('id, order_id, status, books, payment_mode, amount_paise, created_at, order_pushed_id')
      .in('customer_phone', tens).gte('created_at', since).order('created_at', { ascending: false }).limit(10),
    supabase.from('orders').select('razorpay_order_id, status, cart_items, amount_paise, created_at')
      .or(orFilter).gte('created_at', since).order('created_at', { ascending: false }).limit(10),
  ]);
  return {
    requests: (reqs.data || []).map((r) => ({
      id: r.id, order_id: r.order_id, status: r.status, books: r.books, payment_mode: r.payment_mode,
      amount_rs: r.amount_paise ? Math.round(r.amount_paise / 100) : null, created_at: r.created_at, pushed_as: r.order_pushed_id || null,
    })),
    orders: (orders.data || []).map((o) => ({
      order_id: o.razorpay_order_id, status: o.status, amount_rs: Math.round((o.amount_paise || 0) / 100), created_at: o.created_at,
      books: (Array.isArray(o.cart_items) ? o.cart_items : []).map((i) => `${i.title || i.name || ''}${i.qty > 1 ? ' ×' + i.qty : ''}`).filter(Boolean).join(', '),
    })),
  };
}

const ACTIVE_ORDER = (s) => !['cancelled', 'refunded', 'rto', 'lost'].includes(String(s || '').toLowerCase());

async function create(supabase, body) {
  const f = body.fields || {};
  const problems = so.validateForCreate(f);
  if (problems.length) return json(400, { error: `Missing or wrong: ${problems.join('; ')}.` });
  const phone = so.mobile(f.phone);
  const books = so.booksString(f.books);
  const address = so.fullAddress({ address: f.address, pincode: f.pincode, alt_phones: f.alt_phones });
  const amountRupees = Math.round(Number(f.amount_rupees));
  const mode = f.payment_mode === 'prepaid' ? 'prepaid' : 'cod';

  // Same books for this number already requested or ordered → ask first.
  if (body.confirm_existing !== true) {
    const ex = await existingFor(supabase, [phone]);
    const clash = [
      ...ex.requests.filter((r) => LIVE_STATUSES.includes(r.status) && sameBooks(r.books, books)).map((r) => r.pushed_as || r.order_id),
      ...ex.orders.filter((o) => ACTIVE_ORDER(o.status) && sameBooks(o.books, books)).map((o) => o.order_id),
    ].filter(Boolean);
    if (clash.length) {
      return json(409, { error: 'already_exists', existing: [...new Set(clash)], message: `This number already has ${[...new Set(clash)].join(', ')} for these books in the last 30 days.` });
    }
  }

  const now = new Date();
  const row = {
    order_id: mintOrderId(now),
    customer_phone: phone,
    customer_name: String(f.customer_name).trim().slice(0, 160),
    address: address.slice(0, 600),
    books: books.slice(0, 600),
    notes: ['Created by admin from a WhatsApp screenshot', String(f.notes || '').trim()].filter(Boolean).join(' · ').slice(0, 400),
    payment_mode: mode,
    amount_paise: amountRupees * 100,
    status: 'new',
    created_at: now.toISOString(),
    customer_confirmed_at: now.toISOString(),
    ...(mode === 'prepaid' ? { payment_status: 'paid' } : {}),
  };
  const { data: saved, error } = await supabase.from('bot_order_requests').insert(row).select('*').single();
  if (error) throw new Error(`Could not save the request: ${error.message}`);

  const pushed = await pushBotOrder(supabase, saved, { amountRupees, paymentMode: mode, notify: body.notify !== false });
  if (!pushed.ok) {
    return json(pushed.code || 400, { error: `Saved as WhatsApp request ${saved.order_id}, but it could not go to Orders: ${pushed.error}`, request_id: saved.id, request_order_id: saved.order_id });
  }
  return json(200, { ok: true, order_id: pushed.order_id, status: pushed.status, amount: pushed.amount, payment_kind: pushed.payment_kind, request_id: saved.id });
}

async function handle(event, deps = {}) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'POST only' });
  if (!deps.skipAuth) { const block = requireAdmin(event, CORS); if (block) return block; }
  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }
  const supabase = deps.db || db();
  try {
    if (body.action === 'read') {
      const images = (Array.isArray(body.images) ? body.images : []).filter((u) => /^data:image\/(png|jpe?g|webp);base64,/i.test(String(u)));
      if (!images.length) return json(400, { error: 'Add at least one screenshot (PNG, JPG or WebP).' });
      if (images.length > so.MAX_IMAGES) return json(400, { error: `At most ${so.MAX_IMAGES} screenshots at once.` });
      if (images.some((u) => u.length > so.MAX_IMAGE_CHARS)) return json(400, { error: 'A screenshot is too large. Use a normal phone/desktop screenshot.' });
      const fields = so.normaliseExtraction(await (deps.read || readScreenshots)(images));
      const [pricing, existing] = await Promise.all([
        price(supabase, fields).catch((e) => ({ error: e.message })),
        existingFor(supabase, [fields.phone, ...fields.alt_phones]).catch(() => ({ requests: [], orders: [] })),
      ]);
      return json(200, { fields, pricing, existing });
    }
    if (body.action === 'price') return json(200, { pricing: await price(supabase, body.fields || {}) });
    if (body.action === 'create') return await create(supabase, body);
    return json(400, { error: 'Unknown action' });
  } catch (e) {
    console.error('[admin-screenshot-order]', e.message);
    return json(500, { error: e.message });
  }
}

exports.handler = (event) => handle(event);
exports._test = { handle, readScreenshots };
