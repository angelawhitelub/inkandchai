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

module.exports = { cancelNimbusShipment };
