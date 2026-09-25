/**
 * Push website orders into the NimbusPost panel without assigning a courier or
 * generating an AWB. Uses NimbusPost's custom-order API (not Partners API).
 *
 * POST body: { order_ids: ["IC-...", ...] } or { all_unshipped: true }
 *
 * RE-PUSH WITH A SUFFIX: { all_unshipped: true, suffix: "-c", dry_run: true }
 * NimbusPost treats an order number it has seen before -- even one cancelled
 * in its panel -- as a duplicate, so an order whose panel draft was cancelled
 * cannot be pushed again under its own number. With `suffix`, such an order is
 * pushed as "<id>-c" instead. Guards, for this mode only:
 *   - our order must have NO tracking_id (another courier may be carrying it);
 *   - its panel draft must be CANCELLED -- a live draft means it is already
 *     there, and a second copy is how a parcel ships twice;
 *   - "<id>-c" must not already be in the panel (use "-c2" for a second round).
 * An order the panel has never seen is pushed under its plain number.
 * nimbuspost-awb-sync strips the suffix when it maps an AWB back to the order.
 * Header: X-Admin-Key: <admin password>
 * Required env: NIMBUSPOST_API_KEY
 */

const { createClient } = require('@supabase/supabase-js');
const { sanitizeForCourier } = require('./utils/nimbuspost-import');
const { normalizeIndianPhone, parseAddress, enrichAddress } = require('./utils/np-normalize');
const { requireAdmin } = require('./utils/admin-auth');
const { isReplacementOrder } = require('./utils/replacement-order');

const NP_ORDER_URL = 'https://ship.nimbuspost.com/api/orders/create';
const NP_ORDERS_URL = 'https://ship.nimbuspost.com/api/orders';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key',
  'Content-Type': 'application/json',
};

const UNSHIPPED_STATUSES = [
  'paid', 'confirmed', 'cod_pending', 'partial_cod_pending',
  'replacement_pending',
];

// parseAddress / normalizeIndianPhone / enrichAddress now come from
// ./utils/np-normalize so the bulk pusher and the per-order auto-push share one
// robust implementation (whole-string pincode, string phone, pincode→city/state).

function parseItems(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function splitName(value) {
  const parts = String(value || 'Customer').trim().split(/\s+/).filter(Boolean);
  const first = parts.shift() || 'Customer';
  return { first, last: parts.join(' ') || '.' };
}

async function buildPayload(order) {
  const orderId = String(order.razorpay_order_id || order.id);
  const items = parseItems(order.cart_items);
  const amountRs = Math.max(0, Number(order.amount_paise || 0) / 100);
  const itemSubtotal = items.reduce((sum, item) => {
    return sum + (Number(item.price || 0) * Math.max(1, Number(item.qty || item.quantity || 1)));
  }, 0);
  const paymentMeta = items[0]?._payment || {};
  // A replacement's cart is copied from the original order, so it inherits that
  // order's _payment meta — including a partial-COD balance that was already
  // collected once. Rule it out before any of the money tests run.
  const isReplacement = isReplacementOrder(order, items);
  // Partial COD is "there is still a balance to collect", not a status label —
  // the deposit itself is a captured online payment, so this test must come
  // before the prepaid one. See nimbuspost-ship.js for the same reasoning.
  const isPartialCod = !isReplacement && (order.status === 'partial_cod_pending'
    || Number(order.advance_paid_paise || 0) > 0
    || Number(paymentMeta.balance || 0) > 0);
  // For partial COD, NimbusPost must collect only the outstanding balance.
  // For every other payment type, use the final charged/order amount so coupon
  // discounts are preserved instead of rebuilding the undiscounted subtotal.
  // A replacement is the exception to the subtotal fallback: its amount_paise
  // is authoritative and 0 means free, whereas the subtotal is what the
  // customer already paid on the original order.
  const collectable = Math.round(isPartialCod
    ? Math.max(0, Number(paymentMeta.balance || 0))
    : (isReplacement ? amountRs : (amountRs || itemSubtotal)));
  const totalQty = items.reduce((sum, item) => sum + Math.max(1, Number(item.qty || item.quantity || 1)), 0) || 1;
  const name = splitName(order.customer_name);
  const address = await enrichAddress(parseAddress(order.customer_address));  // fills city/state from pincode
  const phone = normalizeIndianPhone(order.customer_phone);
  // Was `status in (cod_pending, partial_cod_pending)`, which pushed any unpaid
  // order in another status (e.g. 'confirmed', set by the admin status dropdown)
  // to the panel as prepaid — the courier then collects nothing at the door.
  // Decide on captured money instead: prepaid only when a gateway payment exists
  // or the order is explicitly 'paid'. A ₹0 order has nothing to collect.
  const fullyPrepaid = !isPartialCod
    && (Boolean(order.razorpay_payment_id) || String(order.status || '').toLowerCase() === 'paid');
  // Replacements are always prepaid fulfilment shipments. Even when an admin
  // records a non-zero declared value, it must not become a COD collection.
  const isCod = !isReplacement && (isPartialCod || (!fullyPrepaid && collectable > 0));
  // `amount` doubles as the declared value of the parcel, so a free replacement
  // still declares the books' worth — it just isn't collected.
  const amount = isCod ? collectable : Math.round(collectable || itemSubtotal);

  if (!phone) throw new Error('Customer phone must contain a valid 10-digit mobile number');
  if (!address.pincode) throw new Error(address.pincodeProblem || 'Customer address has no 6-digit pincode');
  if (!address.address) throw new Error('Customer address has no street line — only a city/state/pincode was saved');
  // city/state are derived from the pincode when the address doesn't spell them
  // out, so reaching here almost always means the pincode itself isn't real.
  if (!address.city || !address.state) {
    throw new Error(`Pincode ${address.pincode} did not resolve to a city/state — check it is a real pincode (address: "${address.address}")`);
  }

  return {
    order_number: orderId,
    payment_method: isCod ? 'COD' : 'prepaid',
    amount,
    fname: name.first,
    lname: name.last,
    address: address.address,
    address_2: '',
    phone,
    city: address.city,
    state: address.state,
    country: 'India',
    pincode: Number(address.pincode),
    // Flat 400g / 15×10×5 for every shipment regardless of qty or product mix.
    weight: 400,
    length: 15,
    breadth: 10,
    height: 5,
    products: items.length ? items.map(item => ({
      name: sanitizeForCourier(item.title || item.name || 'Book'),
      qty: Math.max(1, Number(item.qty || item.quantity || 1)),
      price: Math.round(Number(item.price || 0)),
    })) : [{ name: 'Books', qty: 1, price: amount }],
  };
}

// Flatten a payload object into FormData using bracket notation for nested
// values: { products: [{ name: 'x' }] } -> products[0][name] = 'x'.
// NimbusPost's panel API (/api/orders/create) ONLY accepts multipart/form-data;
// it 404s with "Invalid Content-Type" on application/json.
function appendFormField(form, key, value) {
  if (value === null || value === undefined) return;
  if (Array.isArray(value)) {
    value.forEach((v, i) => appendFormField(form, `${key}[${i}]`, v));
  } else if (typeof value === 'object') {
    for (const k of Object.keys(value)) appendFormField(form, `${key}[${k}]`, value[k]);
  } else {
    form.append(key, String(value));
  }
}

function toFormData(payload) {
  const form = new FormData();
  for (const k of Object.keys(payload)) appendFormField(form, k, payload[k]);
  return form;
}

function orderRowsFromResponse(payload) {
  const candidates = [
    payload?.data?.data,
    payload?.data?.orders,
    payload?.data,
    payload?.orders,
    payload?.results,
    payload,
  ];
  return candidates.find(Array.isArray) || [];
}

function paginationFromResponse(payload) {
  const sources = [payload?.data, payload?.meta, payload?.pagination, payload];
  for (const source of sources) {
    if (!source || Array.isArray(source) || typeof source !== 'object') continue;
    const current = Number(source.current_page || source.page || 0);
    const last = Number(source.last_page || source.total_pages || source.pages || 0);
    if (current || last) return { current, last };
  }
  return { current: 0, last: 0 };
}

function normalizeOrderNumber(value) {
  return String(value ?? '').trim().toUpperCase();
}

// NimbusPost does not enforce unique order_number values, so we read the panel
// first and deduplicate ourselves. We only scan the MOST RECENT few pages
// (newest-first): the orders we push are unshipped (recent), so a duplicate can
// only be a recently-pushed order — it will be on these pages. Scanning the
// whole panel (1700+ orders, up to 50 sequential calls) just times the function
// out and returns an HTML error. NimbusPost also hard-caps `page` at 50.
const NP_MAX_PAGE = 50;    // NimbusPost rejects page > 50
const NP_SCAN_PAGES = 5;   // recent pages are enough to catch re-pushes; keeps us well under the function timeout

// A panel draft's own state, in whatever field this account's API uses.
function panelRowCancelled(row) {
  const vals = [row?.status, row?.order_status, row?.fulfillment, row?.fulfillment_status,
    row?.status_name, row?.order?.status].map((v) => String(v ?? '').toLowerCase());
  return vals.some((v) => /cancel/.test(v));
}

async function getExistingOrderNumbers(apiKey, { pages = NP_SCAN_PAGES, rowsByNumber = null, sample = null } = {}) {
  const existing = new Set();
  const perPage = 100;
  const lastPage = Math.min(pages, NP_MAX_PAGE);

  for (let page = 1; page <= lastPage; page++) {
    const url = new URL(NP_ORDERS_URL);
    url.searchParams.set('page', String(page));
    url.searchParams.set('per_page', String(perPage));
    url.searchParams.set('sort', 'desc');   // newest orders first (NimbusPost wants lowercase)
    url.searchParams.set('sort_by', 'id');

    const response = await fetch(url, {
      headers: { 'Accept': 'application/json', 'NP-API-KEY': apiKey },
    });
    const text = await response.text();
    let payload;
    try { payload = text ? JSON.parse(text) : {}; } catch (_) { payload = { message: text }; }

    if (!response.ok || payload.status === false || payload.success === false || payload.error) {
      // NimbusPost is fussy about pagination/sort params and caps `page` at 50.
      // On a param-validation 404 (e.g. page over the cap, or an unsupported
      // sort value) stop with the orders gathered so far rather than aborting
      // the whole import — partial newest-first coverage still dedupes recent
      // orders, which is where collisions happen.
      const msg = JSON.stringify(payload).toLowerCase();
      if (response.status === 404 && /(page|sort).*(must|one of|less than)/.test(msg)) break;
      throw new Error(`NimbusPost duplicate preflight failed (${response.status}): ${JSON.stringify(payload).slice(0, 500)}`);
    }

    const rows = orderRowsFromResponse(payload);
    for (const row of rows) {
      const number = normalizeOrderNumber(
        row?.order_number || row?.order_no || row?.channel_order_id ||
        row?.channel_order_number || row?.order_reference ||
        row?.order?.order_number || row?.order_id
      );
      if (number) existing.add(number);
      if (number && rowsByNumber) {
        if (!rowsByNumber.has(number)) rowsByNumber.set(number, []);
        rowsByNumber.get(number).push({ cancelled: panelRowCancelled(row) });
      }
      if (sample && !sample.length) {
        sample.push(Object.fromEntries(Object.entries(row || {})
          .filter(([, v]) => v === null || typeof v !== 'object')
          .map(([k, v]) => [k, typeof v === 'string' ? v.slice(0, 40) : v])));
      }
    }

    const pagination = paginationFromResponse(payload);
    if (!rows.length) break;
    if (pagination.last ? page >= pagination.last : rows.length < perPage) break;
    // Otherwise keep going until we hit NP_MAX_PAGE, then stop gracefully.
  }

  return existing;
}

async function pushOrder(order, apiKey) {
  const payload = await buildPayload(order);
  const response = await fetch(NP_ORDER_URL, {
    method: 'POST',
    headers: {
      // Do NOT set Content-Type — fetch will add multipart/form-data with the
      // correct boundary automatically when body is a FormData instance.
      'Accept': 'application/json',
      'NP-API-KEY': apiKey,
    },
    body: toFormData(payload),
  });

  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch (_) { data = { message: text }; }

  if (!response.ok || data.status === false || data.success === false || data.error) {
    throw new Error(`NimbusPost order import failed (${response.status}): ${JSON.stringify(data)}`);
  }
  return data;
}

async function suffixRun({ body, orders, apiKey, supabase }) {
  const suffix = String(body.suffix || '').trim();
  if (!/^-[A-Za-z0-9]{1,3}$/.test(suffix)) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'suffix must look like "-c" or "-c2"' }) };
  }
  const dryRun = body.dry_run !== false;

  // The whole guard rests on knowing each order's panel state, so a failed or
  // partial panel read stops the run instead of pushing blind.
  const rowsByNumber = new Map();
  const sample = [];
  await getExistingOrderNumbers(apiKey, { pages: Number(body.scan_pages) || 20, rowsByNumber, sample });

  const plan = [];
  const skipped = { has_awb: [], live_in_panel: [], suffix_taken: [], pushed_before_not_found: [] };
  for (const order of orders) {
    const id = String(order.razorpay_order_id || order.id);
    const base = normalizeOrderNumber(id);
    const suffixed = normalizeOrderNumber(id + suffix);
    if (String(order.tracking_id || '').trim()) { skipped.has_awb.push(`${id} (${order.courier_name || '?'} ${order.tracking_id})`); continue; }
    const rows = rowsByNumber.get(base) || [];
    if (rows.some((r) => !r.cancelled)) { skipped.live_in_panel.push(id); continue; }
    if (rowsByNumber.has(suffixed)) { skipped.suffix_taken.push(id + suffix); continue; }
    if (!rows.length && order.nimbus_pushed_at) {
      // Stamped as pushed but not on the pages read: cannot tell whether that
      // draft is live, so it is not guessed at.
      skipped.pushed_before_not_found.push(id);
      continue;
    }
    plan.push({ order, number: rows.length ? id + suffix : id, reason: rows.length ? 'panel draft cancelled' : 'never in panel' });
  }

  const report = {
    dry_run: dryRun,
    suffix,
    panel_rows_read: [...rowsByNumber.values()].reduce((n, r) => n + r.length, 0),
    candidates: orders.length,
    to_push: plan.length,
    with_suffix: plan.filter((p) => p.number !== String(p.order.razorpay_order_id || p.order.id)).length,
    plan: plan.map((p) => ({ order: p.order.razorpay_order_id, push_as: p.number, why: p.reason, status: p.order.status })),
    skipped_counts: Object.fromEntries(Object.entries(skipped).map(([k, v]) => [k, v.length])),
    skipped,
    panel_row_sample: dryRun ? sample[0] || null : undefined,
  };
  if (dryRun) return { statusCode: 200, headers: CORS, body: JSON.stringify(report) };

  const results = [];
  for (const p of plan) {
    try {
      await pushOrder({ ...p.order, razorpay_order_id: p.number }, apiKey);
      await supabase.from('orders').update({ nimbus_pushed_at: new Date().toISOString() }).eq('id', p.order.id);
      results.push({ order: p.order.razorpay_order_id, pushed_as: p.number, ok: true });
    } catch (err) {
      results.push({ order: p.order.razorpay_order_id, pushed_as: p.number, ok: false, error: String(err.message || err).slice(0, 300) });
    }
    if (plan.length > 5) await new Promise((resolve) => setTimeout(resolve, 250));
  }
  report.results = results;
  report.pushed = results.filter((r) => r.ok).length;
  report.failed = results.filter((r) => !r.ok).length;
  return { statusCode: 200, headers: CORS, body: JSON.stringify(report) };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: 'Method Not Allowed' };

  const _adminBlock = requireAdmin(event, CORS); if (_adminBlock) return _adminBlock;

  const apiKey = process.env.NIMBUSPOST_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({
      error: 'NIMBUSPOST_API_KEY is not configured in Netlify.',
    }) };
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    let query = supabase.from('orders').select('*').or('source.is.null,source.neq.paperbound');

    if (body.all_unshipped) {
      query = query.in('status', UNSHIPPED_STATUSES).order('created_at', { ascending: false }).limit(500);
    } else if (Array.isArray(body.order_ids) && body.order_ids.length) {
      query = query.in('razorpay_order_id', body.order_ids);
    } else {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({
        error: 'Provide order_ids or all_unshipped:true',
      }) };
    }

    const { data: orders, error } = await query;
    if (error) throw error;

    if (body.suffix !== undefined) {
      return await suffixRun({ body, orders: orders || [], apiKey, supabase });
    }

    // Dedup is best-effort: if the panel lookup fails, proceed with the push
    // and flag it, rather than blocking the whole import.
    let existingOrderNumbers = new Set();
    let dedupWarning = null;
    try {
      existingOrderNumbers = await getExistingOrderNumbers(apiKey);
    } catch (err) {
      dedupWarning = `Duplicate pre-check skipped (${String(err.message || err).slice(0, 160)}). Orders were still pushed.`;
      console.warn('[nimbuspost-order-push] preflight skipped:', err.message);
    }
    const summary = { pushed: 0, skipped: 0, failed: 0, errors: [] };
    for (const order of orders || []) {
      const orderNumber = normalizeOrderNumber(order.razorpay_order_id || order.id);

      // Primary, deterministic dedup: once we've pushed an order we stamp
      // nimbus_pushed_at on our own row, so a re-push is skipped regardless of
      // how old the order is. (The NP panel scan below only covers the ~500
      // most-recent orders, so it MISSES an original pushed weeks ago — that's
      // exactly how the duplicates got created.) If the column doesn't exist
      // yet (migration not run), this is simply undefined and we fall back to
      // the panel scan.
      if (order.nimbus_pushed_at || existingOrderNumbers.has(orderNumber)) {
        summary.skipped++;
        continue;
      }

      try {
        await pushOrder(order, apiKey);
        summary.pushed++;
        // Also protects against repeated rows in this same request.
        existingOrderNumbers.add(orderNumber);
        // Stamp our own row so this order is never pushed again. Best-effort:
        // a missing column (pre-migration) must not fail the import.
        try {
          await supabase.from('orders')
            .update({ nimbus_pushed_at: new Date().toISOString() })
            .eq('id', order.id);
        } catch (e) { console.warn('[nimbuspost-order-push] stamp nimbus_pushed_at (run orders_nimbus_pushed_at.sql):', e.message); }
      } catch (err) {
        const message = String(err.message || err);
        if (/already|duplicate|exists/i.test(message)) {
          summary.skipped++;
        } else {
          summary.failed++;
          summary.errors.push(`${order.razorpay_order_id || order.id}: ${message.slice(0, 220)}`);
        }
      }
      if ((orders || []).length > 5) await new Promise(resolve => setTimeout(resolve, 250));
    }

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ summary, errors: summary.errors, warning: dedupWarning }),
    };
  } catch (err) {
    console.error('[nimbuspost-order-push]', err);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
