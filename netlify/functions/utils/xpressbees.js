/**
 * XpressBees API client.
 *
 * Auth is a bearer token from POST /api/users/login, which costs a round trip,
 * so it is cached across warm invocations the way nimbuspost-ship.js caches
 * its own. The token is a JWT; we do not parse it, we just re-login on 401.
 *
 * Endpoints used here (from their API doc):
 *   POST /api/users/login              { email, password }  -> { status, data: token }
 *   GET  /api/courier                  list of courier ids
 *   POST /api/courier/serviceability   rate + serviceability between pincodes
 *   POST /api/shipments2               BOOKS and returns awb_number + label pdf
 *   GET  /api/shipments2/track/{awb}   scan history
 *   POST /api/shipments2/cancel        { awb }
 *   POST /api/shipments2/manifest      { awbs: [] } -> manifest pdf
 *
 * Every response is { status: true|false, ... }. A false status with HTTP 200
 * is the normal failure shape, so `status` is the only thing worth reading --
 * the same trap iThink set, and the reason this checks it explicitly.
 */
'use strict';

const XB_BASE = 'https://shipment.xpressbees.com/api';
const TIMEOUT_MS = 9000;

let _token = { value: null, at: 0 };
const TOKEN_TTL_MS = 30 * 60 * 1000;

async function xbFetch(path, { method = 'GET', token, body, ms = TIMEOUT_MS } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(`${XB_BASE}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { /* keep raw below */ }
    return { httpStatus: res.status, data, raw: text.slice(0, 400) };
  } catch (err) {
    if (err.name === 'AbortError') {
      return { httpStatus: 599, data: null, raw: `XpressBees ${path} timed out after ${Math.round(ms / 1000)}s` };
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function login({ force = false } = {}) {
  if (!force && _token.value && Date.now() - _token.at < TOKEN_TTL_MS) return _token.value;
  const email = process.env.XPRESSBEES_EMAIL;
  const password = process.env.XPRESSBEES_PASSWORD;
  if (!email || !password) throw new Error('XPRESSBEES_EMAIL / XPRESSBEES_PASSWORD are not configured on the Worker.');

  const { data, raw } = await xbFetch('/users/login', { method: 'POST', body: { email, password } });
  if (!data || data.status !== true || !data.data) {
    throw new Error(`XpressBees login failed: ${data?.message || raw}`);
  }
  _token = { value: data.data, at: Date.now() };
  return _token.value;
}

/** Runs `fn(token)`, re-logging in once if the token has gone stale. */
async function withAuth(fn) {
  let token = await login();
  let out = await fn(token);
  if (out?.httpStatus === 401) {
    token = await login({ force: true });
    out = await fn(token);
  }
  return out;
}

async function couriers() {
  const out = await withAuth((token) => xbFetch('/courier', { token }));
  if (!out.data || out.data.status !== true) throw new Error(`XpressBees courier list failed: ${out.data?.message || out.raw}`);
  return Array.isArray(out.data.data) ? out.data.data : [];
}

/**
 * @returns array of { id, name, freight_charges, cod_charges, total_charges,
 *                     min_weight, chargeable_weight }
 */
async function serviceability({ origin, destination, paymentType, orderAmount, weight, length, breadth, height }) {
  const body = {
    origin: String(origin),
    destination: String(destination),
    payment_type: paymentType,
    order_amount: String(orderAmount ?? 0),
    weight: String(weight ?? 500),
    length: String(length ?? 10),
    breadth: String(breadth ?? 10),
    height: String(height ?? 10),
  };
  const out = await withAuth((token) => xbFetch('/courier/serviceability', { method: 'POST', token, body }));
  if (!out.data || out.data.status !== true) {
    throw new Error(`XpressBees serviceability failed for ${destination}: ${out.data?.message || out.raw}`);
  }
  return Array.isArray(out.data.data) ? out.data.data : [];
}

/** BOOKS a shipment. Returns { awb_number, courier_name, label, shipment_id, ... }. */
async function book(payload) {
  const out = await withAuth((token) => xbFetch('/shipments2', { method: 'POST', token, body: payload }));
  if (!out.data || out.data.status !== true || !out.data.data?.awb_number) {
    throw new Error(`XpressBees booking failed: ${out.data?.message || out.raw}`);
  }
  return out.data.data;
}

/**
 * XpressBees scan codes -> our order statuses. From the v1.1.5 doc, which is
 * the only version that publishes this table.
 *
 * RTO is deliberately NOT treated as a refund trigger anywhere downstream: a
 * parcel coming back is not the same event as money going out, and conflating
 * them is how an automatic refund fires on a book we still hold.
 */
const STATUS_CODES = {
  PP:      { label: 'Pending Pickup',  order_status: 'shipped' },
  IT:      { label: 'In Transit',      order_status: 'in_transit' },
  EX:      { label: 'Exception',       order_status: 'exception' },
  FD:      { label: 'Out For Delivery',order_status: 'out_for_delivery' },
  DL:      { label: 'Delivered',       order_status: 'delivered' },
  RT:      { label: 'RTO',             order_status: 'rto' },
  'RT-IT': { label: 'RTO In Transit',  order_status: 'rto' },
  'RT-DL': { label: 'RTO Delivered',   order_status: 'rto_delivered' },
};

/** @returns {{code, label, order_status}|null} */
function mapStatusCode(code) {
  const key = String(code || '').toUpperCase().trim();
  const hit = STATUS_CODES[key];
  return hit ? { code: key, ...hit } : null;
}

/**
 * NDR / exception list. v1.1.5 documents pagination and an AWB filter; the
 * earlier doc had neither, and without them this returns everything.
 */
async function ndrList({ awbNumbers, page, perPage } = {}) {
  const qs = new URLSearchParams();
  if (awbNumbers?.length) qs.set('awb_number', awbNumbers.map(String).join(','));
  if (page)    qs.set('page', String(page));
  if (perPage) qs.set('per_page', String(Math.min(250, Number(perPage) || 50)));
  const suffix = qs.toString() ? `?${qs}` : '';
  const out = await withAuth((token) => xbFetch(`/ndr${suffix}`, { token }));
  if (!out.data || out.data.status !== true) {
    if (/no record found/i.test(String(out.data?.message || ''))) return [];
    throw new Error(`XpressBees NDR list failed: ${out.data?.message || out.raw}`);
  }
  return Array.isArray(out.data.data) ? out.data.data : [];
}

/**
 * Take action on an exception. Up to 100 AWBs per request, and only where the
 * courier has actually raised one -- otherwise it answers "No Courier
 * Exception Available" per AWB rather than failing the request.
 * actions: [{ awb, action: 're-attempt'|'change_address'|'change_phone', action_data }]
 */
async function ndrCreate(actions) {
  if (!Array.isArray(actions) || !actions.length) throw new Error('ndrCreate needs at least one action');
  if (actions.length > 100) throw new Error('XpressBees accepts at most 100 NDR actions per request');
  const out = await withAuth((token) => xbFetch('/ndr/create', { method: 'POST', token, body: actions }));
  const rows = Array.isArray(out.data) ? out.data : (Array.isArray(out.data?.data) ? out.data.data : null);
  if (!rows) throw new Error(`XpressBees NDR action failed: ${out.data?.message || out.raw}`);
  return rows;
}

/**
 * The panel's own order list. Undocumented -- it is not in apidoc.pdf,
 * apidoc_v1.1.5.pdf or the Postman collection -- and read-only: POST, PUT,
 * PATCH and DELETE all answer "Unknown method".
 *
 * It is the only way to read back what the PANEL thinks a shipment is, as
 * opposed to what we asked for. Nothing else exposes payment mode: the
 * tracking endpoint returns scans and status, never the collectable. That
 * gap is why 133 orders imported COD -- 66 of them already paid -- and
 * nothing noticed for two days.
 */
async function panelOrders({ page = 1, perPage = 100, params = {} } = {}) {
  const qs = new URLSearchParams({
    page: String(page),
    per_page: String(Math.min(250, Number(perPage) || 100)),
    ...params,
  });
  const out = await withAuth((token) => xbFetch(`/orders?${qs}`, { token }));
  if (!out.data) throw new Error(`XpressBees order list failed: ${out.raw}`);
  if (out.data.status === false) throw new Error(`XpressBees order list failed: ${out.data.message || out.raw}`);
  const d = out.data.data;
  const rows = Array.isArray(d) ? d : (Array.isArray(d?.data) ? d.data : []);
  return { rows, meta: Array.isArray(d) ? null : (d && typeof d === 'object' ? { ...d, data: undefined } : null) };
}

async function track(awb) {
  const out = await withAuth((token) => xbFetch(`/shipments2/track/${encodeURIComponent(awb)}`, { token }));
  if (!out.data || out.data.status !== true) throw new Error(`XpressBees tracking failed for ${awb}: ${out.data?.message || out.raw}`);
  return out.data.data;
}

async function cancel(awb) {
  const out = await withAuth((token) => xbFetch('/shipments2/cancel', { method: 'POST', token, body: { awb: String(awb) } }));
  if (!out.data || out.data.status !== true) throw new Error(`XpressBees cancel failed for ${awb}: ${out.data?.message || out.raw}`);
  return out.data.message || 'Shipment Cancelled.';
}

async function manifest(awbs) {
  const out = await withAuth((token) => xbFetch('/shipments2/manifest', { method: 'POST', token, body: { awbs: awbs.map(String) } }));
  if (!out.data || out.data.status !== true) throw new Error(`XpressBees manifest failed: ${out.data?.message || out.raw}`);
  return out.data.data;   // a PDF url
}

/** The pickup block is sent inline on every booking -- no warehouse id to resolve. */
function pickupFromEnv() {
  return {
    warehouse_name: process.env.XPRESSBEES_WAREHOUSE_NAME || 'Ink and Chai',
    name:           process.env.XPRESSBEES_PICKUP_NAME    || 'Ink and Chai',
    address:        process.env.XPRESSBEES_PICKUP_ADDRESS || '2969, Kucha Mai Dass, Sitaram Bazar',
    address_2:      process.env.XPRESSBEES_PICKUP_ADDRESS2 || 'Chandni Chowk',
    city:           process.env.XPRESSBEES_PICKUP_CITY    || 'Delhi',
    state:          process.env.XPRESSBEES_PICKUP_STATE   || 'Delhi',
    pincode:        process.env.XPRESSBEES_PICKUP_PINCODE || '110006',
    phone:          String(process.env.XPRESSBEES_PICKUP_PHONE || '9625836117').replace(/\D/g, '').slice(-10),
  };
}

module.exports = {
  XB_BASE, login, withAuth, xbFetch,
  couriers, serviceability, book, track, cancel, manifest, pickupFromEnv, panelOrders,
  STATUS_CODES, mapStatusCode, ndrList, ndrCreate,
  _resetTokenForTests: () => { _token = { value: null, at: 0 }; },
};
