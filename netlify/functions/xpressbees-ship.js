/**
 * Netlify Function: xpressbees-ship
 * POST /.netlify/functions/xpressbees-ship
 *
 * Books XpressBees shipments for website orders: fetch order from Supabase ->
 * quote serviceability -> book -> store the AWB, courier and label back on the
 * order. The twin of nimbuspost-ship.js, and it BOOKS -- unlike
 * ithink-order-push.js, every call here assigns a real AWB and costs money.
 *
 * Body:
 *   { order_id: "IC-..." }                 one order
 *   { order_ids: ["IC-...", ...] }         many
 *   { action: "candidates", days: 30 }     list what is bookable now, book nothing
 *                                          (the admin "Book on XpressBees" button)
 *   { dry_run: true }                      build + quote, book nothing
 *   { action: "serviceability" }           rates for the first order only
 *   { courier_id: 1 }                      force a courier
 *   { force: true }                        re-book an order that has a tracking id
 *   { cancel_existing: true }              void the current AWB first, then re-book
 *   { suffix: "-p" }                       book under <order id><suffix>, for a re-book
 *
 * Header: X-Admin-Key / X-Admin-Token
 * Env: XPRESSBEES_EMAIL, XPRESSBEES_PASSWORD, SUPABASE_URL, SUPABASE_SERVICE_KEY
 *      XPRESSBEES_PICKUP_* (see utils/xpressbees.js pickupFromEnv)
 *      XPRESSBEES_COURIER_PRIORITY  comma-separated name fragments
 */

const { createClient } = require('@supabase/supabase-js');
const { sanitizeForCourier, sanitizeAddressText } = require('./utils/nimbuspost-import');
const { buildTrackingUrl } = require('./utils/tracking-url');
const { normalizeIndianPhone, parseAddress, enrichAddress } = require('./utils/np-normalize');
const { requireAdmin } = require('./utils/admin-auth');
const { isReplacementOrder } = require('./utils/replacement-order');
const { classifyShipmentMoney, parseCartItems } = require('./utils/shipment-money');
const xb = require('./utils/xpressbees');
const { sendShippedNotification } = require('./utils/shipped-notification');
const { classifyXbError, availableServices } = require('./utils/xpressbees-errors');

// Same list the XpressBees feed ships from. Anything else (cancelled,
// shipped, refunded, payment still pending) must never get an AWB.
const BOOKABLE_STATUSES = ['paid', 'confirmed', 'cod_pending', 'partial_cod_pending', 'replacement_pending'];
// The customer may still cancel a fresh order on the website.
const FRESH_MS = 30 * 60 * 1000;

/**
 * Why an order must not be booked right now, or null. Checked on the row read
 * at booking time, not on what the admin screen loaded minutes earlier: on
 * 13 Oct this endpoint booked whatever ids it was handed, status unseen.
 */
function bookingHold(order, now = Date.now()) {
  const status = String(order.status || '');
  if (!BOOKABLE_STATUSES.includes(status)) return { kind: 'status', reason: `status is "${status}", not an order waiting to ship` };
  if (order.cancellation_requested_at) return { kind: 'cancel_requested', reason: 'the customer asked to cancel' };
  const age = now - Date.parse(order.created_at || 0);
  if (age >= 0 && age < FRESH_MS) {
    return { kind: 'fresh', reason: `placed ${Math.max(1, Math.round(age / 60000))} min ago; the customer can still cancel for 30 min` };
  }
  return null;
}

/** What failed, why, and what to do: the admin screen groups by kind. */
function describeFailure(orderId, message, extra = {}) {
  const c = classifyXbError(message);
  const available = c.kind === 'no_service' ? availableServices(message) : undefined;
  return { order_id: orderId, error: message, ...c, ...(available ? { available } : {}), ...extra };
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key, X-Admin-Token',
  'Content-Type': 'application/json',
};
const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body, null, 2) });

// Flat box, same as every other push path. XpressBees reweighs at the hub.
const BOX = { weight: 400, length: 15, breadth: 10, height: 5 };

/**
 * The only states a shipment may be cancelled out of.
 *
 * cancel_existing exists to undo a shipment booked with the WRONG PAYMENT
 * MODE: 66 orders reached the panel as COD through the WooCommerce channel,
 * 54 already paid in full and 12 free replacements, because that importer
 * stamps everything COD. Re-booking them prepaid means voiding the AWB first.
 *
 * But a parcel that has already been picked up is out of our hands and in a
 * van. Cancelling its AWB there does not bring it back -- it detaches the only
 * number anyone can trace it by, and the customer's parcel becomes untrackable
 * while still being delivered. So this is an allowlist, not a blocklist: an
 * unrecognised state is refused, and the panel export that says otherwise is
 * not consulted, because an export is a snapshot and this is checked live.
 */
const CANCELLABLE = /^\s*(pending pickup|booked|manifested?|awaiting pickup|data received)\s*$/i;

// www.xpressbees.com drops the AWB, redirects to the site root and shows a
// CAPTCHA. The shipping-platform page deep-links with no login. See
// utils/tracking-url.js, which is the single place this is decided.
const trackUrl = (awb) => buildTrackingUrl({ courier: 'xpressbees', awb });

/**
 * Pick a courier from the serviceability quote.
 *
 * Unlike NimbusPost -- where the ladder spans genuinely different carriers and
 * a silent fallback could put a parcel with one we do not want -- every option
 * here is an XpressBees service tier, so the cheapest serviceable one is the
 * right default. A preference list still wins when set, and an explicit
 * courier_id always wins over both.
 */
function chooseCourier(quotes, { forceId, priority }) {
  const usable = quotes.filter(q => q && (q.id || q.id === 0));
  if (!usable.length) return null;

  if (forceId) {
    const hit = usable.find(q => String(q.id) === String(forceId));
    if (!hit) throw new Error(`Courier ${forceId} is not serviceable for this pincode. Available: ${usable.map(q => `${q.id}=${q.name}`).join(', ')}`);
    return hit;
  }

  for (const pref of priority) {
    const words = pref.split(/\s+/).filter(Boolean);
    const hit = usable.find(q => { const n = String(q.name || '').toLowerCase(); return words.every(w => n.includes(w)); });
    if (hit) return hit;
  }

  return usable.slice().sort((a, b) =>
    (Number(a.total_charges) || Infinity) - (Number(b.total_charges) || Infinity))[0];
}

async function buildOrder(order, suffix = '') {
  const orderId = order.razorpay_order_id || order.id;

  const a = await enrichAddress(parseAddress(order.customer_address || ''));
  if (!/^\d{6}$/.test(String(a.pincode || ''))) throw new Error(a.pincodeProblem ? `${orderId}: ${a.pincodeProblem}` : `Cannot determine a 6-digit pincode for ${orderId}`);

  const tel = String(normalizeIndianPhone(order.customer_phone || '') || '').replace(/\D/g, '').slice(-10);
  if (tel.length !== 10) throw new Error(`Cannot determine a 10-digit phone for ${orderId} (got "${tel}")`);

  const tidy = (v) => String(v || '').replace(/[\s\-–,]+$/, '').trim();
  const money = classifyShipmentMoney(order, isReplacementOrder(order));

  // order_items prices are informational on the label; order_amount and
  // collectable_amount are what actually bill and collect. Their doc is
  // explicit that the total is NOT derived from the items, so both are sent.
  const items = parseCartItems(order.cart_items).filter(i => i && (i.title || i.name));
  const order_items = items.length
    ? items.map(i => ({
        name: sanitizeForCourier(i.title || i.name || 'Book').slice(0, 200),
        qty: String(Math.max(1, Number(i.qty || i.quantity || 1))),
        sku: String(i.sku || ''),
        price: String(Math.max(0, Number(i.price || 0))),
      }))
    : [{ name: 'Books', qty: '1', sku: '', price: String(money.orderValueRs) }];

  return {
    _meta: {
      order_id: orderId, db_id: order.id,
      booked_as: (String(orderId).slice(0, 20 - suffix.length) + suffix),
      payment_type: money.shipmentPaymentType,
      order_amount: money.orderValueRs,
      collectable: money.collectableAmount,
      pincode: a.pincode,
      lines: order_items.length,
    },
    payload: {
      // XpressBees keeps an order number RESERVED after a cancel: re-booking
      // ten voided shipments under their own numbers failed every time with
      // "Order number already in use", leaving ten parcels with no live AWB.
      // A suffix makes the number new. It is cosmetic to the courier and the
      // real id stays in _meta, on the order row and on the label's items.
      // The 20-char cap is the API's, so the base is trimmed to fit the
      // suffix rather than the suffix being trimmed off the end.
      order_number: (String(orderId).slice(0, 20 - suffix.length) + suffix),
      // unique_order_number is NOT sent: the v1.1.5 doc drops it, and an
      // undocumented field is not where to put double-booking protection.
      // That guard is the tracking_id check in the handler, which is ours.
      payment_type: money.isCOD ? 'cod' : 'prepaid',
      order_amount: money.orderValueRs,
      // Prepaid MUST be zero; COD must be <= order_amount. classifyShipmentMoney
      // already guarantees both, which is the whole reason it is shared.
      collectable_amount: money.collectableAmount,
      package_weight: BOX.weight,
      package_length: BOX.length,
      package_breadth: BOX.breadth,
      package_height: BOX.height,
      request_auto_pickup: 'yes',
      shipping_charges: 0,
      cod_charges: 0,
      discount: 0,
      consignee: {
        // A book-title sanitiser here shipped customers as 'Hindi Book'.
        name: sanitizeAddressText(order.customer_name || '', 60) || 'Customer',
        address: sanitizeAddressText(tidy(a.address) || tidy(a.city) || '', 200),
        address_2: '',
        city: tidy(a.city).slice(0, 40),
        state: tidy(a.state).slice(0, 40),
        pincode: String(a.pincode),
        phone: tel,
      },
      pickup: xb.pickupFromEnv(),
      order_items,
    },
  };
}

async function notifyShipped(supabase, order) {
  const claim = await supabase.from('orders')
    .update({ shipped_notified_at: new Date().toISOString() })
    .eq('id', order.id).is('shipped_notified_at', null).select('id');
  if (!claim.error && !(claim.data && claim.data.length)) return { skipped: 'already notified' };
  const sent = await sendShippedNotification(order, {
    awb: order.tracking_id, courier: order.courier_name, trackingUrl: order.tracking_url,
  }).catch((e) => ({ error: e.message }));
  // Nothing reached the customer: release the claim so admin-resend-shipped can retry.
  if (!claim.error && !(sent.whatsapp?.ok || sent.email?.ok)) {
    await supabase.from('orders').update({ shipped_notified_at: null }).eq('id', order.id);
  }
  return { whatsapp: !!sent.whatsapp?.ok, email: !!sent.email?.ok, ...(sent.error ? { error: sent.error } : {}) };
}

// ── Saved price checks ───────────────────────────────────────────────────────
// A price check (the address worked out, the payload built, the service and
// price XpressBees quoted) is kept per order, so the second look at the same
// order -- the booking right after the preview, or a preview run again -- skips
// both the address lookup and the serviceability call. It is keyed on every
// order field buildOrder and the money rules read: change the address, phone,
// books, amount or status and the saved check no longer matches and is redone.
// Refusals that come from the order itself or XpressBees' coverage are kept
// too; network, wallet and sign-in failures never are.
const QUOTE_STORE = 'xb-quote';
const QUOTE_TTL_MS = 12 * 60 * 60 * 1000;
const STICKY_FAILURES = new Set(['no_service', 'pincode', 'address', 'phone']);

function quoteSig(order, courierId, suffix) {
  const fields = ['customer_address', 'customer_phone', 'customer_name', 'cart_items', 'amount_paise',
    'advance_paid_paise', 'status', 'source', 'razorpay_payment_id'];
  const raw = JSON.stringify([fields.map((f) => order[f] ?? null), String(courierId || ''), suffix || '', pickupPincodeSafe()]);
  return require('node:crypto').createHash('sha1').update(raw).digest('hex');
}
function pickupPincodeSafe() { try { return xb.pickupFromEnv().pincode; } catch { return ''; } }

function quoteStore() {
  try { return require('@netlify/blobs').getStore(QUOTE_STORE); } catch { return null; }
}
async function readQuote(store, orderId, sig) {
  if (!store) return null;
  try {
    const hit = await store.get(orderId, { type: 'json' });
    return hit && hit.sig === sig && Date.now() - hit.at < QUOTE_TTL_MS ? hit : null;
  } catch { return null; }
}
async function writeQuote(store, orderId, value) {
  if (!store) return;
  try { await store.set(orderId, JSON.stringify({ ...value, at: Date.now() })); } catch (e) { console.warn('[xpressbees-ship] quote save:', e.message); }
}
async function dropQuote(store, orderId) {
  if (!store) return;
  try { await store.delete(orderId); } catch { /* expires on its own */ }
}

/** Runs fn over items, `limit` at a time, in order of start. */
async function pool(items, limit, fn) {
  let next = 0;
  const run = async () => { while (next < items.length) { const i = next++; await fn(items[i], i); } };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, run));
}

/** Everything bookable right now: { ready, held }. Books nothing. */
async function listCandidates(supabase, days) {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const { data, error } = await supabase.from('orders')
    .select('id, razorpay_order_id, status, created_at, tracking_id, cancellation_requested_at, source, customer_name, amount_paise')
    .in('status', BOOKABLE_STATUSES)
    .is('tracking_id', null)
    .gte('created_at', since)
    .order('created_at', { ascending: true })
    .limit(1000);
  if (error) throw error;
  const ready = [], held = [];
  for (const o of data || []) {
    if (o.source === 'paperbound') continue;
    const hold = bookingHold(o);
    const row = { order_id: o.razorpay_order_id || o.id, created_at: o.created_at, status: o.status, customer: o.customer_name || '' };
    if (hold) held.push({ ...row, ...hold }); else ready.push(row);
  }
  return { ready, held };
}

/**
 * Quote (dry_run) or book the given orders. Shared by the HTTP call and the
 * background job (worker/xb-booking-job.js). Orders are worked `concurrency`
 * at a time; after a wallet refusal nothing new is started.
 */
async function processOrders(ids, opts = {}) {
  const supabase = opts.supabase || createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const suffix = String(opts.suffix || '');
  const priority = String(process.env.XPRESSBEES_COURIER_PRIORITY || 'surface')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  const store = opts.quoteStore === undefined ? quoteStore() : opts.quoteStore;

  const { data: orders, error } = await supabase.from('orders').select('*').in('razorpay_order_id', ids);
  if (error) throw error;
  const found = new Set((orders || []).map(o => String(o.razorpay_order_id || o.id)));

  const booked = [], skipped = [], failed = [];
  for (const id of ids) if (!found.has(String(id))) skipped.push({ order_id: id, kind: 'missing', reason: 'no such order' });
  if (!orders || !orders.length) return { booked, skipped, failed };

  const pickupPincode = xb.pickupFromEnv().pincode;
  // After a wallet refusal every later booking fails the same way; stop
  // rather than pile up identical errors.
  let walletEmpty = false;
  const concurrency = opts.concurrency || (opts.dry_run ? 6 : 4);

  await pool(orders, concurrency, async (order) => {
    const orderId = order.razorpay_order_id || order.id;
    // cancel_existing is a re-book by definition, so it implies force.
    const force = !!opts.force || !!opts.cancel_existing;
    if (order.tracking_id && !force) {
      skipped.push({ order_id: orderId, kind: 'has_awb', reason: `already has tracking ${order.tracking_id}` });
      return;
    }
    if (!force) {
      const hold = bookingHold(order);
      if (hold) { skipped.push({ order_id: orderId, ...hold }); return; }
    }
    if (walletEmpty) {
      skipped.push({ order_id: orderId, kind: 'wallet_stop', reason: 'not attempted: the XpressBees wallet ran out on an earlier order' });
      return;
    }
    let cancelled = null;
    if (order.tracking_id && opts.cancel_existing) {
      // Live, never from a stored status: the DB says 'shipped' for all of
      // these and a two-day-old panel export said 'booked' for shipments
      // that were by then in transit.
      let state = '';
      try { state = String((await xb.track(order.tracking_id))?.status || ''); }
      catch (e) {
        failed.push({ order_id: orderId, error: `cannot read live status of ${order.tracking_id}, refusing to cancel blind: ${e.message}` });
        return;
      }
      if (!CANCELLABLE.test(state)) {
        failed.push({ order_id: orderId, error: `refusing to cancel ${order.tracking_id}: courier reports "${state}"` });
        return;
      }
      try { cancelled = { awb: order.tracking_id, message: await xb.cancel(order.tracking_id), was: state }; }
      catch (e) {
        failed.push({ order_id: orderId, error: `cancel of ${order.tracking_id} failed, not re-booking: ${e.message}` });
        return;
      }
    }
    // A re-book never reuses a saved check: the AWB it replaces changes things.
    const sig = cancelled ? '' : quoteSig(order, opts.courier_id, suffix);
    const saved = sig ? await readQuote(store, orderId, sig) : null;
    let stage = 'quote';
    try {
      if (saved && saved.failure) {
        failed.push({ ...saved.failure, cached: true });
        return;
      }
      let built, courier;
      if (saved && saved.built && saved.courier) {
        ({ built, courier } = saved);
      } else {
        built = await buildOrder(order, suffix);
        const quotes = await xb.serviceability({
          origin: pickupPincode, destination: built._meta.pincode,
          paymentType: built.payload.payment_type,
          orderAmount: built.payload.order_amount,
          weight: BOX.weight, length: BOX.length, breadth: BOX.breadth, height: BOX.height,
        });
        courier = chooseCourier(quotes, { forceId: opts.courier_id, priority });
        if (!courier) throw new Error(`No XpressBees service is serviceable for pincode ${built._meta.pincode}`);
        courier = { id: courier.id, name: courier.name, total_charges: courier.total_charges };
        if (sig) await writeQuote(store, orderId, { sig, built, courier });
      }

      if (opts.dry_run) {
        booked.push({ ...built._meta, dry_run: true, cached: !!saved, courier_charges: courier.total_charges,
          courier, ...(opts.with_payload ? { payload: built.payload } : {}) });
        return;
      }

      stage = 'book';
      const res = await xb.book({ ...built.payload, courier_id: String(courier.id) });

      const awb = res.awb_number;
      const assignedAt = new Date().toISOString();
      const update = {
        status: 'shipped',
        tracking_id: awb,
        courier_name: res.courier_name || courier.name || 'XpressBees',
        tracking_url: trackUrl(awb),
        shipped_at: assignedAt,
        awb_assigned_at: assignedAt,
        shipment_payment_type: built._meta.payment_type,
      };
      const { error: updErr } = await supabase.from('orders').update(update).eq('id', order.id);
      if (updErr) console.warn(`[xpressbees-ship] ${orderId} booked as ${awb} but Supabase update failed:`, updErr.message);
      await dropQuote(store, orderId);

      // Every booking tells the customer, like every other way an order
      // becomes shipped. 13 Oct 2026: 32 orders were booked through here and
      // nobody heard a thing. Fire-once on shipped_notified_at, the same claim
      // admin-resend-shipped uses, so a re-book cannot message twice.
      const notified = updErr ? { skipped: 'order not updated' } : await notifyShipped(supabase, { ...order, ...update });

      booked.push({
        order_id: orderId, awb,
        booked_as: built._meta.booked_as,
        cancelled_awb: cancelled ? cancelled.awb : undefined,
        courier_name: update.courier_name,
        courier_charges: courier.total_charges,
        collectable: built._meta.collectable,
        label: res.label || null,
        shipment_id: res.shipment_id || null,
        tracking_url: update.tracking_url,
        db_updated: !updErr,
        notified,
      });
    } catch (err) {
      // A cancel that succeeded before a book that failed leaves the order
      // with NO live AWB. Say so loudly: it is not shipped and nothing else
      // will notice on its own.
      const f = describeFailure(orderId, String(err.message || err), {
        cancelled_awb_now_void: cancelled ? cancelled.awb : undefined,
      });
      if (f.kind === 'wallet') walletEmpty = true;
      // Only a quote can be wrong the same way next time; a refused booking
      // with a good quote is worth trying again.
      if (sig && stage === 'quote' && STICKY_FAILURES.has(f.kind) && !saved) await writeQuote(store, orderId, { sig, failure: f });
      failed.push(f);
    }
  });

  // The admin screen lists them in the order they were asked for.
  const rank = new Map(ids.map((id, i) => [String(id), i]));
  const byAsk = (a, b) => (rank.get(String(a.order_id)) ?? 1e9) - (rank.get(String(b.order_id)) ?? 1e9);
  return { booked: booked.sort(byAsk), skipped: skipped.sort(byAsk), failed: failed.sort(byAsk) };
}

// ── The background job (worker/xb-booking-job.js) ────────────────────────────
// One XpressBees job at a time, held by a Durable Object so it keeps going when
// the admin tab is closed. These calls only talk to it.
function jobStub() {
  const ns = require('../../worker/shims/runtime-bindings').get('XB_BOOKING_JOB');
  if (!ns) throw new Error('The background booking runner is not available here (XB_BOOKING_JOB binding missing).');
  return ns.get(ns.idFromName('xpressbees'));
}
async function jobCall(payload) {
  const res = await jobStub().fetch('https://xb-booking.internal/', { method: 'POST', body: JSON.stringify(payload) });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

const rs = (n) => '₹' + Math.round(Number(n) || 0).toLocaleString('en-IN');
const escHtml = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The owner's email when a background booking finishes. Called by the job. */
async function jobFinished(job, deps = {}) {
  if (job.mode !== 'book') return { skipped: 'preview' };
  const to = process.env.STORE_OWNER_EMAIL;
  if (!to) return { skipped: 'STORE_OWNER_EMAIL not set' };
  const sendEmail = deps.sendEmail || require('./utils/email').sendEmail;
  const booked = job.booked || [], failed = job.failed || [], skipped = job.skipped || [];
  const notAttempted = job.not_attempted || [];
  const freight = booked.reduce((t, b) => t + (Number(b.courier_charges) || 0), 0);
  const unnotified = booked.filter(b => b.notified && !b.notified.whatsapp && !b.notified.email && !b.notified.skipped);
  const notSaved = booked.filter(b => b.db_updated === false);
  const row = (cells) => '<tr>' + cells.map(c => `<td style="padding:4px 8px;border-bottom:1px solid #eee;">${c}</td>`).join('') + '</tr>';
  const table = (head, rows) => rows.length
    ? `<table style="border-collapse:collapse;font-size:13px;margin:6px 0 14px;">${row(head.map(h => `<b>${h}</b>`))}${rows.join('')}</table>` : '';
  const stop = { wallet: 'Stopped: the XpressBees wallet ran out. Recharge it and run the button again for the rest.',
    auth: 'Stopped: could not sign in to XpressBees (check XPRESSBEES_EMAIL / XPRESSBEES_PASSWORD).',
    error: `Stopped on an error: ${escHtml(job.error || '')}` }[job.stop_reason] || '';
  const html = `<p><b>XpressBees booking finished</b> — started ${escHtml(new Date(job.started_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }))} IST.</p>`
    + `<p>✅ Booked <b>${booked.length}</b> (${rs(freight)} freight) · ❌ Failed <b>${failed.length}</b> · ⏭ Not sent <b>${skipped.length + notAttempted.length}</b></p>`
    + (stop ? `<p style="color:#b42318;"><b>${stop}</b></p>` : '')
    + (notSaved.length ? `<p style="color:#b42318;"><b>${notSaved.length} booked at XpressBees but NOT saved on the order</b> — put these AWBs on by hand: ${notSaved.map(b => escHtml(b.order_id + ' → ' + b.awb)).join(', ')}</p>` : '')
    + (unnotified.length ? `<p style="color:#b42318;">${unnotified.length} customer(s) were not notified: ${unnotified.map(b => escHtml(b.order_id)).join(', ')} — resend from the order.</p>` : '')
    + (failed.length ? '<h3>Failed</h3>' + table(['Order', 'Why'], failed.map(f => row([escHtml(f.order_id), escHtml(f.title || f.kind || '') + ' — ' + escHtml(String(f.error || '').slice(0, 180))]))) : '')
    + (booked.length ? '<h3>Booked</h3>' + table(['Order', 'AWB', 'Payment', 'Freight', 'Customer told'], booked.map(b => row([
        escHtml(b.order_id), escHtml(b.awb), Number(b.collectable) > 0 ? 'COD ' + rs(b.collectable) : 'Prepaid', rs(b.courier_charges),
        b.notified && (b.notified.whatsapp || b.notified.email) ? 'yes' : (b.notified && b.notified.skipped ? 'already' : 'NO')]))) : '')
    + (skipped.length || notAttempted.length ? '<h3>Not sent</h3>' + table(['Order', 'Why'], skipped.map(s => row([escHtml(s.order_id), escHtml(s.reason || s.kind || '')])).concat(notAttempted.map(id => row([escHtml(id), 'not attempted'])))) : '');
  try {
    await sendEmail({ to, subject: `XpressBees booking: ${booked.length} booked, ${failed.length} failed${stop ? ' — stopped' : ''}`, html });
    return { sent: true };
  } catch (e) {
    console.error('[xpressbees-ship] job email:', e.message);
    return { error: e.message };
  }
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST')    return json(405, { error: 'Method not allowed' });

  const block = requireAdmin(event, CORS);
  if (block) return block;

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }

  // Everything bookable right now, for the admin preview. Books nothing.
  if (body.action === 'candidates') {
    try {
      const days = Math.min(120, Math.max(1, parseInt(body.days, 10) || 30));
      const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
      return json(200, { days, ...(await listCandidates(supabase, days)) });
    } catch (err) {
      return json(500, { error: `Could not list orders: ${err.message || err}` });
    }
  }

  // The background job: start a price check or a booking, read its progress,
  // or clear a finished one. It runs on the server; the tab only watches.
  if (body.action === 'job_status' || body.action === 'job_dismiss') {
    try {
      const { status, data } = await jobCall({ action: body.action === 'job_status' ? 'status' : 'dismiss' });
      return json(status, data);
    } catch (err) {
      return json(503, { error: String(err.message || err) });
    }
  }
  if (body.action === 'job_start') {
    try {
      const mode = body.mode === 'book' ? 'book' : 'preview';
      let ids = Array.isArray(body.order_ids) ? body.order_ids.map(String).filter(Boolean) : [];
      let held = [];
      if (!ids.length && mode === 'preview') {
        const days = Math.min(120, Math.max(1, parseInt(body.days, 10) || 30));
        const c = await listCandidates(createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY), days);
        ids = c.ready.map(r => r.order_id);
        held = c.held.map(h => ({ order_id: h.order_id, kind: h.kind, reason: h.reason }));
      }
      if (!ids.length && !held.length) return json(400, { error: 'No orders to check.' });
      if (ids.length > 1000) return json(400, { error: `At most 1000 orders per run (got ${ids.length}).` });
      const { status, data } = await jobCall({ action: 'start', job: {
        mode, order_ids: [...new Set(ids)], held,
        courier_id: body.courier_id ? String(body.courier_id) : '',
        service: String(body.service || ''),
      } });
      return json(status, data);
    } catch (err) {
      return json(503, { error: String(err.message || err) });
    }
  }

  const ids = body.order_ids || (body.order_id ? [body.order_id] : []);
  if (!ids.length) return json(400, { error: 'Provide order_id or order_ids' });
  if (ids.length > 25) return json(400, { error: `At most 25 orders per call (got ${ids.length}); send them in batches.` });

  const suffix = String(body.suffix || '');
  if (suffix && !/^[A-Za-z0-9_-]{1,8}$/.test(suffix)) {
    return json(400, { error: `suffix must be 1-8 characters of A-Z, 0-9, - or _ (got ${JSON.stringify(suffix)})` });
  }

  try {
    // Rates only, book nothing.
    if (body.action === 'serviceability') {
      const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
      const { data: orders, error } = await supabase.from('orders').select('*').in('razorpay_order_id', ids);
      if (error) throw error;
      if (!orders?.length) return json(404, { error: 'No orders found for given IDs' });
      const priority = String(process.env.XPRESSBEES_COURIER_PRIORITY || 'surface')
        .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
      const built = await buildOrder(orders[0], suffix);
      const quotes = await xb.serviceability({
        origin: xb.pickupFromEnv().pincode, destination: built._meta.pincode,
        paymentType: built.payload.payment_type,
        orderAmount: built.payload.order_amount,
        weight: BOX.weight, length: BOX.length, breadth: BOX.breadth, height: BOX.height,
      });
      return json(200, {
        order_id: built._meta.order_id, pincode: built._meta.pincode,
        payment_type: built.payload.payment_type,
        chosen: chooseCourier(quotes, { forceId: body.courier_id, priority }),
        couriers: quotes,
      });
    }

    const out = await processOrders(ids, {
      dry_run: !!body.dry_run, courier_id: body.courier_id, force: body.force,
      cancel_existing: body.cancel_existing, suffix, with_payload: !!body.dry_run,
    });
    if (out.skipped.length === ids.length && out.skipped.every(s => s.kind === 'missing')) {
      return json(404, { error: 'No orders found for given IDs' });
    }
    const { booked, skipped, failed } = out;
    return json(200, {
      dry_run: !!body.dry_run,
      totals: {
        booked: booked.length, skipped: skipped.length, failed: failed.length,
        collectable_total: booked.reduce((t, b) => t + (Number(b.collectable) || 0), 0),
        freight_total: booked.reduce((t, b) => t + (Number(b.courier_charges) || 0), 0),
      },
      booked, skipped, failed,
    });
  } catch (err) {
    console.error('xpressbees-ship error:', err);
    return json(500, { error: String(err.message || err) });
  }
};

module.exports.CANCELLABLE   = CANCELLABLE;
module.exports.bookingHold   = bookingHold;
module.exports.describeFailure = describeFailure;
module.exports.buildOrder    = buildOrder;
module.exports.chooseCourier = chooseCourier;
module.exports.processOrders = processOrders;
module.exports.jobFinished   = jobFinished;
module.exports.quoteSig      = quoteSig;
