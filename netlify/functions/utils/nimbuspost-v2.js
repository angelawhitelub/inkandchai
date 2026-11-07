/**
 * NimbusPost Partner API (the new app.nimbuspost.com, Nov 2026).
 * Reference: https://api-v2.nimbuspost.com/docs/reference/v2
 *
 * Every request carries the key pair from Settings -> API Keys:
 *   x-api-key: npk_...          NIMBUSPOST_V2_API_KEY
 *   x-api-secret: ...           NIMBUSPOST_V2_API_SECRET
 * The key needs the Admin role for labels. Without a User-Agent the edge in
 * front of api-v2 answers a bare nginx 403, so one is always sent.
 * The old v1 token and the old panel (ship.nimbuspost.com/mapi) do not work here.
 */

const BASE = 'https://api-v2.nimbuspost.com';
const UA = 'InkAndChai-Admin/1.0 (+https://inkandchai.in)';

class NpV2Error extends Error {
  constructor(message, status = 502) { super(message); this.status = status; }
}

const configured = () => !!(process.env.NIMBUSPOST_V2_API_KEY && process.env.NIMBUSPOST_V2_API_SECRET);

async function v2Fetch(path, { method = 'GET', body, ms = 30000, fetchImpl = fetch } = {}) {
  const key = process.env.NIMBUSPOST_V2_API_KEY;
  const secret = process.env.NIMBUSPOST_V2_API_SECRET;
  if (!key || !secret) {
    throw new NpV2Error('NimbusPost API key is not set (NIMBUSPOST_V2_API_KEY and NIMBUSPOST_V2_API_SECRET).', 500);
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetchImpl(`${BASE}${path}`, {
      method,
      headers: {
        Accept: 'application/json', 'User-Agent': UA, 'x-api-key': key, 'x-api-secret': secret,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { /* raw below */ }
    return { httpStatus: res.status, data, raw: text.slice(0, 300) };
  } catch (e) {
    if (e.name === 'AbortError') return { httpStatus: 599, data: null, raw: `timed out after ${Math.round(ms / 1000)}s` };
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

const errText = (out) => String(out.data?.error?.detail || out.data?.error?.title || out.data?.message || out.raw || '').slice(0, 200);

/** deps.v2Fetch replaces the network in tests. A 401/403 is a key problem, said plainly. */
function makeV2Caller(deps = {}) {
  const call = deps.v2Fetch || v2Fetch;
  return async (path, opts = {}) => {
    const out = await call(path, opts);
    if (out.httpStatus === 401 || out.httpStatus === 403) {
      throw new NpV2Error(`NimbusPost refused the API key (HTTP ${out.httpStatus}: ${errText(out)}). `
        + 'Check Settings -> API Keys on app.nimbuspost.com: Active, Admin role, no IP allowlist.', 502);
    }
    return out;
  };
}

/** One row per booked order: { id: order_id, awb_number, courier_name, ship_status, created }. */
function toShipment(r) {
  const s = r && r.shipment ? r.shipment : {};
  return {
    id: String(r?.order_id || ''),
    awb_number: String(s.awb || '').trim(),
    courier_name: s.courier_name || '',
    ship_status: String(r?.status_tab || r?.order_status || ''),
    created: s.created_at || r?.order_date || r?.created_at || '',
    units: (Array.isArray(r?.items) ? r.items : []).reduce((n, i) => n + (Number(i?.qty) || 0), 0),
  };
}

/** Orders matching a query, following next_cursor; at most `max`. */
async function listOrders(call, params, { max = 1000, pageSize = 200 } = {}) {
  const rows = [];
  let cursor = '';
  while (rows.length < max) {
    const qs = new URLSearchParams({ ...params, limit: String(pageSize), ...(cursor ? { cursor } : {}) });
    const out = await call(`/v2/orders?${qs}`);
    if (out.httpStatus !== 200 || !Array.isArray(out.data?.data)) {
      throw new NpV2Error(`NimbusPost order list failed (HTTP ${out.httpStatus}): ${errText(out)}`);
    }
    rows.push(...out.data.data);
    cursor = out.data?.meta?.pagination?.next_cursor || '';
    if (!cursor || !out.data.data.length) break;
  }
  return rows.slice(0, max);
}

/** The booked order behind an AWB, or null. Exact AWB match only. */
async function findByAwb(call, awb) {
  const want = String(awb || '').trim().toUpperCase();
  const rows = await listOrders(call, { awb: want }, { max: 20, pageSize: 20 });
  const hit = rows.map(toShipment).find((s) => s.id && s.awb_number.toUpperCase() === want);
  return hit || null;
}

/** One merged label PDF for these NimbusPost order ids. */
async function labelPdf(call, orderIds, fetchImpl = fetch) {
  const out = await call('/v2/shipments/labels', { method: 'POST', body: { order_ids: orderIds.map(String) }, ms: 60000 });
  const url = out.data?.data?.url;
  if (out.httpStatus !== 200 || out.data?.success !== true || typeof url !== 'string' || !/^https:\/\//.test(url)) {
    throw new NpV2Error(`NimbusPost label download failed (HTTP ${out.httpStatus}): ${errText(out)}`);
  }
  const res = await fetchImpl(url);
  if (!res.ok) throw new NpV2Error(`Label PDF download failed (HTTP ${res.status})`);
  return new Uint8Array(await res.arrayBuffer());
}

module.exports = { BASE, NpV2Error, configured, v2Fetch, makeV2Caller, toShipment, listOrders, findByAwb, labelPdf };
