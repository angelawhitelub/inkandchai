/**
 * Netlify Function: order-help  (PUBLIC, behind a signed link)
 *
 *   GET  ?o=<order id>&k=<signature>        the order's books and what can be asked
 *   POST { o, k, action: 'cancel_order' }
 *   POST { o, k, action: 'remove_book', book: <index in cart_items> }
 *
 * The page the out-of-stock notice links to (stock-delay-notify-scheduled,
 * utils/stock-delay). The signature in the link is the only credential: the
 * customer is not signed in when they tap it on WhatsApp.
 *
 * A REQUEST ONLY. It records cancellation_requested_at + cancellation_request_note
 * (shown under the admin's "⏳ Cancel Requests" filter) and alerts the owner.
 * It never changes the order's status or books, cancels a shipment, or refunds.
 * One request per order; the courier must not have moved the parcel yet.
 */

const { createClient } = require('@supabase/supabase-js');
const { sendEmail } = require('./utils/email');
const { sendText } = require('./utils/whatsapp');
const sd = require('./utils/stock-delay');
const { pickupState } = require('./utils/pickup-live');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
};
const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });

// The courier's last word, read the way the Not Picked Up tab reads it.
const hasMoved = (o) => !!o.shipment_moved_at
  || [o.last_courier_status, o.last_nimbuspost_status].some((s) => s && pickupState(s) === 'moved');

function openState(order) {
  const st = String(order.status || '').toLowerCase();
  if (!sd.OPEN_STATUSES.has(st)) return { open: false, why: `This order is ${st.replace(/_/g, ' ')}, so it can no longer be changed here.` };
  if (hasMoved(order)) {
    return { open: false, why: 'Good news: your parcel has already been picked up by the courier, so it can no longer be changed here.' };
  }
  return { open: true };
}

function view(order) {
  const books = sd.booksOf(order).map((b) => ({ index: b.index, title: b.title, qty: b.qty, price: b.price }));
  const state = openState(order);
  return {
    order_id: order.razorpay_order_id,
    placed: order.created_at,
    books,
    amount_rs: Math.round(Number(order.amount_paise || 0) / 100),
    open: state.open,
    message: state.why || '',
    can_remove_book: state.open && books.length > 1,
    request: order.cancellation_requested_at
      ? { at: order.cancellation_requested_at, note: order.cancellation_request_note || '' }
      : null,
  };
}

async function alertOwner(order, note) {
  const id = order.razorpay_order_id;
  const line = `⏳ ${id}: ${note}\n${order.customer_name || ''} ${order.customer_phone || ''}`
    + `${order.tracking_id ? `\nAWB ${order.courier_name || ''} ${order.tracking_id} (not picked up)` : ''}`
    + '\nAdmin → Orders → ⏳ Cancel Requests. Nothing has been cancelled or refunded yet.';
  const jobs = [];
  if (process.env.STORE_OWNER_PHONE) jobs.push(sendText(process.env.STORE_OWNER_PHONE, line).catch(() => {}));
  if (process.env.STORE_OWNER_EMAIL) {
    jobs.push(sendEmail({
      to: process.env.STORE_OWNER_EMAIL,
      subject: `⏳ ${id} — customer request (out-of-stock delay)`,
      html: `<pre style="font-family:Georgia,serif;font-size:14px;white-space:pre-wrap;">${line.replace(/</g, '&lt;')}</pre>`,
    }).catch(() => {}));
  }
  await Promise.all(jobs);
}

exports.handler = async (event = {}) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (!['GET', 'POST'].includes(event.httpMethod)) return json(405, { error: 'Method Not Allowed' });

  let input = event.queryStringParameters || {};
  if (event.httpMethod === 'POST') {
    try { input = JSON.parse(event.body || '{}') || {}; } catch { return json(400, { error: 'Invalid JSON' }); }
  }
  const id = String(input.o || '').trim().toUpperCase();
  if (!id || !sd.verifyToken(id, String(input.k || '').trim())) {
    return json(403, { error: 'This link is not valid. Please use the link from our message, or contact us on WhatsApp.' });
  }

  try {
    const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const { data: order, error } = await db.from('orders').select('*').eq('razorpay_order_id', id).maybeSingle();
    if (error) throw error;
    if (!order) return json(404, { error: 'Order not found.' });

    if (event.httpMethod === 'GET') return json(200, view(order));

    const state = openState(order);
    if (!state.open) return json(409, { error: state.why, ...view(order) });
    if (order.cancellation_requested_at) {
      return json(409, { error: 'We already have a request for this order and will get back to you.', ...view(order) });
    }

    let note;
    if (input.action === 'cancel_order') {
      note = 'Out-of-stock delay: customer asks to CANCEL THE WHOLE ORDER.';
    } else if (input.action === 'remove_book') {
      const books = sd.booksOf(order);
      const b = books.find((x) => x.index === Number(input.book));
      if (!b) return json(400, { error: 'Please choose the book to remove.' });
      if (books.length < 2) return json(400, { error: 'This order has only one book; please request cancellation instead.' });
      note = `Out-of-stock delay: customer asks to REMOVE "${b.title}"${b.qty > 1 ? ` ×${b.qty}` : ''} (₹${b.price}) and ship the rest.`
        + (order.tracking_id ? ' The booked AWB still carries the old amount — rebook after removing.' : '');
    } else {
      return json(400, { error: 'Unknown request.' });
    }

    // Atomic: only the first request lands.
    const at = new Date().toISOString();
    const { data: claimed, error: upErr } = await db.from('orders')
      .update({ cancellation_requested_at: at, cancellation_request_note: note.slice(0, 500) })
      .eq('id', order.id)
      .is('cancellation_requested_at', null)
      .select('id');
    if (upErr) throw upErr;
    if (!claimed || !claimed.length) {
      return json(409, { error: 'We already have a request for this order and will get back to you.' });
    }
    await alertOwner(order, note);
    return json(200, { success: true, ...view({ ...order, cancellation_requested_at: at, cancellation_request_note: note }) });
  } catch (e) {
    console.error('[order-help]', e);
    return json(500, { error: 'Something went wrong. Please try again, or message us on WhatsApp.' });
  }
};

exports._test = { openState, view };
