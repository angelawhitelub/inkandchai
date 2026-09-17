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
  couriers, serviceability, book, track, cancel, manifest, pickupFromEnv,
  _resetTokenForTests: () => { _token = { value: null, at: 0 }; },
};
