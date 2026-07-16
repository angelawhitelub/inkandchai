/**
 * Cancel a NimbusPost shipment by AWB.
 *
 * Endpoint: POST https://api.nimbuspost.com/v1/shipments/cancel
 * Auth:     Bearer token from POST /v1/users/login (email + password)
 * Body:     { awb: "<tracking-id>" }
 *
 * Fires when a customer self-cancels an order on the website AFTER we've
 * already pushed it to NimbusPost. Skips if there's no AWB — nothing to cancel
 * upstream (order was still sitting pre-push in our DB).
 *
 * Never throws — cancellation must not be blocked by a NimbusPost hiccup. On
 * failure we log and return a diagnostic result so the caller can attach it to
 * the owner notification email if needed.
 */

const NP_BASE = 'https://api.nimbuspost.com/v1';

async function npAuthenticate() {
  const email    = process.env.NIMBUSPOST_EMAIL;
  const password = process.env.NIMBUSPOST_PASSWORD;
  if (!email || !password) throw new Error('NIMBUSPOST_EMAIL / NIMBUSPOST_PASSWORD env vars not set');

  const res = await fetch(`${NP_BASE}/users/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  let data; try { data = await res.json(); } catch { data = {}; }
  const token = data.data || data.token;
  if (!res.ok || !token) throw new Error(`NimbusPost auth failed: ${JSON.stringify(data)}`);
  return token;
}

/**
 * @param {string} awb
 * @returns {Promise<{ok:boolean, alreadyCancelled?:boolean, error?:string, data?:any}>}
 */
async function cancelNimbusShipment(awb) {
  const tracking = String(awb || '').trim();
  if (!tracking) return { ok: false, error: 'No AWB provided' };

  try {
    const token = await npAuthenticate();
    const res = await fetch(`${NP_BASE}/shipments/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ awb: tracking }),
    });
    let data; try { data = await res.json(); } catch { data = {}; }

    // NimbusPost sometimes returns 200 with { status: false, message: "..." }
    // for already-cancelled shipments — treat those as idempotent success.
    const msg = String(data.message || '').toLowerCase();
    if (msg.includes('already') && msg.includes('cancel')) {
      return { ok: true, alreadyCancelled: true, data };
    }
    if (!res.ok || data.status === false) {
      return { ok: false, error: data.message || `HTTP ${res.status}`, data };
    }
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * Cancel an UNSHIPPED order sitting in the NimbusPost seller panel (no AWB yet).
 *
 * These are created via the seller-panel Orders API
 * (ship.nimbuspost.com/api/orders/create, NP-API-KEY, multipart) when we
 * auto-push a new COD order. A courier-less panel order can't be cancelled via
 * /v1/shipments/cancel (that needs an AWB), so we find the panel row by our own
 * order_number (the IC-… id we sent on create), then cancel by NimbusPost's
 * internal panel order id.
 *
 * The seller-panel Orders cancel endpoint isn't in NimbusPost's public docs, so
 * this is best-effort: on any non-success the caller falls back to alerting the
 * store owner to cancel the order manually in the panel. Never throws.
 *
 * @param {string} orderNumber  the IC-… order id used as order_number on push
 * @returns {Promise<{ok:boolean, alreadyCancelled?:boolean, error?:string, data?:any}>}
 */
const NP_PANEL_BASE = 'https://ship.nimbuspost.com/api';
const NP_PANEL_ORDERS_URL = `${NP_PANEL_BASE}/orders`;
const NP_MAX_PAGE = 50;
const NP_SCAN_PAGES = 5;

function normalizeOrderNumber(value) {
  return String(value ?? '').trim().toUpperCase();
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

function orderNumberFromRow(row) {
  return normalizeOrderNumber(
    row?.order_number || row?.order_no || row?.channel_order_id ||
    row?.channel_order_number || row?.order_reference ||
    row?.order?.order_number || row?.order_id
  );
}

function orderIdFromRow(row) {
  const id =
    row?.id || row?.order_id || row?.np_order_id || row?.nimbuspost_order_id ||
    row?.order?.id || row?.order?.order_id;
  return id === null || id === undefined ? '' : String(id).trim();
}

function awbFromRow(row) {
  return String(
    row?.awb_number || row?.awb || row?.tracking_number ||
    row?.shipment?.awb_number || row?.shipment?.awb || ''
  ).trim();
}

async function findNimbusOrder(orderNumber, apiKey) {
  const target = normalizeOrderNumber(orderNumber);
  const perPage = 100;
  const lastPage = Math.min(NP_SCAN_PAGES, NP_MAX_PAGE);

  for (let page = 1; page <= lastPage; page++) {
    const url = new URL(NP_PANEL_ORDERS_URL);
    url.searchParams.set('page', String(page));
    url.searchParams.set('per_page', String(perPage));
    url.searchParams.set('sort', 'desc');
    url.searchParams.set('sort_by', 'id');

    const response = await fetch(url, {
      headers: { 'Accept': 'application/json', 'NP-API-KEY': apiKey },
    });
    const text = await response.text();
    let payload;
    try { payload = text ? JSON.parse(text) : {}; } catch (_) { payload = { message: text }; }

    if (!response.ok || payload.status === false || payload.success === false || payload.error) {
      const msg = JSON.stringify(payload).toLowerCase();
      if (response.status === 404 && /(page|sort).*(must|one of|less than)/.test(msg)) break;
      throw new Error(`NimbusPost order lookup failed (${response.status}): ${JSON.stringify(payload).slice(0, 500)}`);
    }

    const rows = orderRowsFromResponse(payload);
    const hit = rows.find(row => orderNumberFromRow(row) === target);
    if (hit) return hit;
    if (rows.length < perPage) break;
  }

  return null;
}

async function cancelNimbusOrder(orderNumber) {
  const num = String(orderNumber || '').trim();
  if (!num) return { ok: false, error: 'No order_number provided' };
  const key = process.env.NIMBUSPOST_API_KEY;
  if (!key) return { ok: false, error: 'NIMBUSPOST_API_KEY not configured' };

  try {
    const panelOrder = await findNimbusOrder(num, key);
    if (!panelOrder) {
      return { ok: false, error: `NimbusPost panel order not found for order_number ${num}` };
    }

    const awb = awbFromRow(panelOrder);
    if (awb) {
      return await cancelNimbusShipment(awb);
    }

    const panelId = orderIdFromRow(panelOrder);
    if (!panelId) {
      return { ok: false, error: `NimbusPost panel order id missing for order_number ${num}`, data: panelOrder };
    }

    // POST /api/orders/cancel accepts ONLY multipart/form-data — NimbusPost
    // rejects JSON and x-www-form-urlencoded with
    // "Invalid Content-Type. Only multipart/form-data; boundary= is allowed."
    // Build a real FormData and let fetch set Content-Type WITH the boundary;
    // setting the header manually strips the boundary and triggers that error.
    // (The earlier "id is required" came from a hand-rolled body without a
    // proper multipart boundary, not from the endpoint disliking multipart.)
    const idNum = Number(panelId);
    const idValue = Number.isFinite(idNum) ? String(idNum) : String(panelId);

    const form = new FormData();
    form.append('id', idValue);

    const res = await fetch(`${NP_PANEL_BASE}/orders/cancel`, {
      method: 'POST',
      headers: { 'Accept': 'application/json', 'NP-API-KEY': key }, // no Content-Type — fetch adds boundary
      body: form,
    });
    let data; try { data = await res.json(); } catch { data = {}; }

    const msg = String(data.message || '').toLowerCase();
    if (msg.includes('already') && msg.includes('cancel')) {
      return { ok: true, alreadyCancelled: true, data };
    }
    if (!res.ok || data.status === false || data.success === false) {
      return { ok: false, error: data.message || `HTTP ${res.status}`, data };
    }
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function shipmentStatusFromRow(row) {
  const candidates = [
    row?.current_status, row?.shipment_status, row?.status_name, row?.order_status,
    row?.shipment?.current_status, row?.shipment?.shipment_status, row?.shipment?.status,
    typeof row?.status === 'string' ? row.status : '',
  ];
  return String(candidates.find(value => value !== null && value !== undefined && String(value).trim()) || '').trim();
}

/**
 * Fail-closed live check used before automatic cancellation. A stale order is
 * cancellable only when the NimbusPost panel itself still reports a pre-pickup
 * state. Unknown/not-found rows are never treated as safe to cancel.
 */
async function inspectNimbusOrder(orderNumber) {
  const key = process.env.NIMBUSPOST_API_KEY;
  if (!key) return { ok: false, found: false, error: 'NIMBUSPOST_API_KEY not configured' };
  try {
    const row = await findNimbusOrder(orderNumber, key);
    if (!row) return { ok: true, found: false, error: 'Order not found in the first 500 NimbusPost panel rows' };
    const status = shipmentStatusFromRow(row);
    const normalized = status.toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
    const moved = /\b(shipped|dispatch|picked|pickup done|in transit|out for delivery|delivered|rto|return to origin|ndr|undelivered|lost)\b/.test(normalized);
    const prePickup = /\b(booked|manifest|pickup scheduled|pickup pending|ready to ship|new|pending|awb assigned)\b/.test(normalized);
    return { ok: true, found: true, status, moved, prePickup, row };
  } catch (error) {
    return { ok: false, found: false, error: error.message };
  }
}

module.exports = { cancelNimbusShipment, cancelNimbusOrder, inspectNimbusOrder };
