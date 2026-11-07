/**
 * TEMPORARY owner-only probe (2026-11-08): does NimbusPost's new API
 * (api-v2.nimbuspost.com) accept our NIMBUSPOST_API_KEY, and in which header?
 * READ-ONLY: GET orders list, limit 1. Returns statuses, error codes and row
 * counts only -- never the key or order details.
 */
const { requireAdmin } = require('./utils/admin-auth');

const json = (statusCode, body) => ({ statusCode, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(body) });
const UA = { 'User-Agent': 'InkAndChai-Admin/1.0 (+https://inkandchai.in)', Accept: 'application/json' };

async function probe(headers) {
  const qs = 'page=1&limit=1&fields=order_id%2Corder_number%2Cshipment.awb&order_status=ready_to_ship&include_tab_counts=false&include_total=false';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(`https://api-v2.nimbuspost.com/orders/api/v1/orders?${qs}`, { headers: { ...UA, ...headers }, signal: ctrl.signal });
    const text = await res.text();
    let d = null; try { d = JSON.parse(text); } catch { /* raw */ }
    const rows = Array.isArray(d?.data) ? d.data : (Array.isArray(d?.data?.items) ? d.data.items : (Array.isArray(d?.data?.records) ? d.data.records : null));
    return {
      http: res.status, success: d?.success ?? null,
      code: d?.error?.code || null, detail: String(d?.error?.detail || d?.message || '').slice(0, 160),
      rows: rows ? rows.length : null,
      row_keys: rows && rows[0] ? Object.keys(rows[0]).slice(0, 12) : null,
      has_awb: rows && rows[0] ? !!(rows[0].shipment && rows[0].shipment.awb) : null,
      data_keys: d?.data && !Array.isArray(d.data) && typeof d.data === 'object' ? Object.keys(d.data).slice(0, 10) : null,
    };
  } catch (e) {
    return { http: e.name === 'AbortError' ? 599 : 0, detail: String(e.message).slice(0, 120) };
  } finally { clearTimeout(timer); }
}

exports.handler = async (event = {}) => {
  const block = requireAdmin(event, {});
  if (block) return block;
  const key = process.env.NIMBUSPOST_API_KEY || '';
  if (!key) return json(500, { error: 'NIMBUSPOST_API_KEY not set' });
  const [bearer, npHeader, xApiKey] = await Promise.all([
    probe({ Authorization: `Bearer ${key}` }),
    probe({ 'NP-API-KEY': key }),
    probe({ 'x-api-key': key }),
  ]);
  // A new-panel key (npk_…) from app.nimbuspost.com/settings/api-keys, if the owner has stored one.
  const v2 = process.env.NIMBUSPOST_V2_API_KEY || '';
  const secret = process.env.NIMBUSPOST_V2_API_SECRET || '';
  // Partner API (api-v2.nimbuspost.com/docs/reference/v2): x-api-key + x-api-secret on every request.
  let v2Result = null; let track = null;
  if (v2 && secret) {
    const h = { ...UA, 'x-api-key': v2, 'x-api-secret': secret };
    const call = async (path) => {
      const res = await fetch(`https://api-v2.nimbuspost.com${path}`, { headers: h });
      let d = null; try { d = await res.json(); } catch { /* raw */ }
      return { http: res.status, success: d?.success ?? null, code: d?.error?.code || null,
        detail: String(d?.error?.detail || d?.error?.title || '').slice(0, 160),
        rows: Array.isArray(d?.data) ? d.data.length : null,
        first_keys: Array.isArray(d?.data) && d.data[0] ? Object.keys(d.data[0]).slice(0, 14) : (d?.data && typeof d.data === 'object' ? Object.keys(d.data).slice(0, 14) : null),
        has_order_id: !!(d?.data?.orderId || (Array.isArray(d?.data) && d.data[0] && (d.data[0].order_id || d.data[0].orderId))) };
    };
    v2Result = await call('/v2/orders?limit=1&order_status=ready_to_ship');
    const awb = String((event.queryStringParameters || {}).awb || '').replace(/[^A-Za-z0-9]/g, '');
    if (awb) track = await call(`/v2/tracking/${awb}`);
  }
  return json(200, { key_prefix_npk: key.startsWith('npk_'), bearer, np_api_key_header: npHeader, x_api_key_header: xApiKey,
    v2_key_set: !!v2, v2_secret_set: !!secret, v2_key_prefix_npk: v2.startsWith('npk_'), v2_key: v2Result, v2_track: track });
};
