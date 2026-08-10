/**
 * "Has the courier actually got this parcel?" — asked of NimbusPost directly.
 *
 * WHY THIS EXISTS
 *   Cancellation used to answer that question purely from webhook leftovers
 *   (orders.shipment_moved_at / last_nimbuspost_status). That is only as good as
 *   the webhooks we receive, and NimbusPost's FIRST movement event is "picked" —
 *   a status nimbuspost-webhook.js did not map, so it was dropped on the floor
 *   and nothing was ever written to the order.
 *
 *   IC-R-20260807-P7DX5: Delhivery picked the parcel up at 17:48 on 10 Aug; the
 *   customer cancelled at 23:5x with both columns still NULL, so every local
 *   guard passed. The auto-cancel then failed at NimbusPost — correctly, the
 *   parcel was already gone — and the shipment went out anyway.
 *
 *   Mapping "picked" (done in nimbuspost-webhook.js) fixes the feed going
 *   forward. This asks the API at the moment of cancellation, which does not
 *   depend on a push arriving at all, or arriving in time.
 *
 * Never throws, and answers `null` (unknown) on any failure — a NimbusPost
 * hiccup must not stop a customer from cancelling an order that really is
 * still sitting on our table.
 */

const NP_BASE = 'https://api.nimbuspost.com/v1';

/**
 * Courier statuses that mean the parcel is no longer ours to stop.
 *
 * "picked" is first for a reason — it is the earliest movement signal
 * NimbusPost emits and the one this whole module exists for. The `^` anchor
 * with no `up` alternation is deliberate: it covers "picked", "picked up" and
 * "pickup done" alike.
 *
 * public/js/auth.js carries a copy of this pattern to decide whether to show
 * the Cancel button. Change one, change the other — a mismatch means the button
 * appears and then the API refuses it.
 */
const MOVED_RE = new RegExp('^(?:'
  + 'picked|pickup done'
  + '|in[ -]?transit|reached (?:at|nearest|destination) hub|in sorting centre|sorting|spd'
  + '|shipped|dispatched'
  + '|out[ _-]?for[ _-]?delivery|ofd|delivered'
  + '|rto|return to origin'
  + '|undelivered|ndr|delivery (?:failed|attempt failed|exception)|lost'
  + ')');

function statusImpliesMovement(raw) {
  return MOVED_RE.test(String(raw || '').toLowerCase().trim());
}

async function npLogin(fetchImpl, signal) {
  const email = process.env.NIMBUSPOST_EMAIL;
  const password = process.env.NIMBUSPOST_PASSWORD;
  if (!email || !password) throw new Error('NimbusPost credentials are not configured');
  const res = await fetchImpl(`${NP_BASE}/users/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
    signal,
  });
  const body = await res.json();
  const token = body?.data || body?.token;
  if (!res.ok || !token || typeof token !== 'string') throw new Error('NimbusPost login failed');
  return token;
}

/**
 * @param {string} awb
 * @returns {Promise<{moved: true|false|null, status: string, error?: string}>}
 *   moved === true   courier has it (or later) — cancellation must be refused
 *   moved === false  NimbusPost knows the AWB and reports no movement yet
 *   moved === null   could not tell (no creds, network, timeout, odd shape)
 */
async function npShipmentMoved(awb, opts = {}) {
  const tracking = String(awb || '').trim();
  if (!tracking) return { moved: null, status: '', error: 'no awb' };

  const fetchImpl = opts.fetchImpl === undefined ? globalThis.fetch : opts.fetchImpl;
  if (typeof fetchImpl !== 'function') return { moved: null, status: '', error: 'no fetch' };

  // Short — this sits in front of a customer waiting on a Cancel button.
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 6000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const token = await npLogin(fetchImpl, controller.signal);
    const res = await fetchImpl(`${NP_BASE}/shipments/track/bulk`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ awb: [tracking] }),
      signal: controller.signal,
    });
    const body = await res.json();
    if (!res.ok || body?.status !== true) return { moved: null, status: '', error: 'tracking lookup failed' };

    const rows = Array.isArray(body.data) ? body.data : [];
    const row = rows.find(r => String(r?.awb_number || '').trim() === tracking) || rows[0];
    if (!row) return { moved: null, status: '', error: 'awb not in response' };

    const status = String(row.status || '').trim();
    if (statusImpliesMovement(status)) return { moved: true, status };

    // The headline status can lag its own history — the scan list is what the
    // courier actually recorded, so a PICKED entry counts even if the summary
    // still says something earlier.
    const history = Array.isArray(row.history) ? row.history : [];
    const movedScan = history.find(h => statusImpliesMovement(h?.status_code) || statusImpliesMovement(h?.status));
    if (movedScan) return { moved: true, status: String(movedScan.status_code || movedScan.status || status).trim() };

    return { moved: false, status };
  } catch (err) {
    return { moved: null, status: '', error: err.name === 'AbortError' ? 'timeout' : err.message };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { npShipmentMoved, statusImpliesMovement, MOVED_RE };
