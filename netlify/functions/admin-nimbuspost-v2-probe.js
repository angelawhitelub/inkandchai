/**
 * TEMPORARY owner-only probe (2026-11-08): does NimbusPost's new panel API
 * (api-v2.nimbuspost.com, app.nimbuspost.com) accept the token from our
 * public-API login (api.nimbuspost.com/v1/users/login)? And is the old panel
 * API (ship.nimbuspost.com/mapi) still answering?
 *
 * READ-ONLY: one list call each, limit 1. Returns HTTP statuses, messages and
 * counts only -- never the token or any order details.
 */
const { requireAdmin } = require('./utils/admin-auth');
const { npAuthenticate } = require('./utils/nimbuspost-cancel');

const json = (statusCode, body) => ({ statusCode, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(body) });

async function timed(url, opts, ms = 15000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  const t0 = Date.now();
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    const text = await res.text();
    let data = null; try { data = JSON.parse(text); } catch { /* raw */ }
    const recs = data?.data?.records || data?.data?.items || (Array.isArray(data?.data) ? data.data : null);
    return {
      http: res.status, ms: Date.now() - t0,
      success: data?.success ?? data?.status ?? null,
      message: String(data?.message || data?.error?.message || data?.detail || data?.error || (data ? '' : text.slice(0, 120))).slice(0, 200),
      rows: Array.isArray(recs) ? recs.length : null,
      keys: data && typeof data === 'object' ? Object.keys(data).slice(0, 8) : null,
    };
  } catch (e) {
    return { http: e.name === 'AbortError' ? 599 : 0, ms: Date.now() - t0, message: e.name === 'AbortError' ? `timed out after ${ms / 1000}s` : String(e.message).slice(0, 200) };
  } finally { clearTimeout(timer); }
}

exports.handler = async (event = {}) => {
  const block = requireAdmin(event, {});
  if (block) return block;
  let token;
  try { token = await npAuthenticate(); } catch (e) { return json(502, { error: 'v1 login failed: ' + String(e.message).slice(0, 160) }); }
  const UA = { 'User-Agent': 'InkAndChai-Admin/1.0 (+https://inkandchai.in)' };
  const auth = { Accept: 'application/json', ...UA, Authorization: `Bearer ${token}` };
  const qs = 'page=1&limit=1&fields=order_id%2Cshipment.awb&order_status=ready_to_ship&include_tab_counts=false&include_total=false';
  const [v2, v2_no_token, v2_no_ua, mapi] = await Promise.all([
    timed(`https://api-v2.nimbuspost.com/orders/api/v1/orders?${qs}`, { headers: auth }),
    timed(`https://api-v2.nimbuspost.com/orders/api/v1/orders?${qs}`, { headers: { Accept: 'application/json', ...UA } }),
    timed(`https://api-v2.nimbuspost.com/orders/api/v1/orders?${qs}`, { headers: { Accept: 'application/json' } }),
    timed('https://ship.nimbuspost.com/mapi/v1/shipment/list?limit=1&page=1', {
      method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ ship_status_in: 'pending pickup', applied_tags: '' }),
    }),
  ]);
  const looksJwt = /^eyJ/.test(String(token));
  return json(200, { v1_login: 'ok', v1_token_is_jwt: looksJwt, v1_token_length: String(token).length, v2_orders: v2, v2_no_token, v2_no_ua, old_mapi: mapi });
};
