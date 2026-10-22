/**
 * Prepaid RTO refunds: what is owed, and whether the parcel is really back.
 *
 * Shared by the admin "RTO Refunds" tab (rto-refund-candidates) and the
 * automatic job (rto-auto-refund-scheduled), so the figure the owner sees on a
 * row is the figure the job would send. Two copies of the arithmetic would let
 * them drift apart, and the difference would be paid out.
 *
 * WHY THE JOB ASKS THE COURIER AGAIN
 *   orders.status = 'rto' is written by courier webhooks and pollers, which say
 *   so as soon as the parcel is TURNED ROUND ("RTO initiated"). A parcel can be
 *   re-attempted and delivered after that, and a webhook can simply be wrong.
 *   So the job never pays on our own status column. At refund time it asks the
 *   courier's tracking API and pays only on the scan that means the parcel is
 *   physically back with us: XpressBees RT-DL "RTO Delivered", NimbusPost
 *   "rto delivered". Anything else -- in transit, reached origin, a lookup
 *   error, an AWB the API does not return -- is "not verified", and waits.
 */

const envPaise = (name, fallback) => Math.max(0, parseInt(process.env[name], 10) || fallback);

/** Courier legs in paise, per parcel tier. See rto-refund-candidates for the reasoning. */
function defaultRates() {
  // ₹74 per 0.5 kg slab for the round trip: a single book is one slab (₹74),
  // a bundle two (₹148). Split evenly across the legs.
  const fwd = envPaise('RTO_FORWARD_SHIPPING_PAISE', 3700);
  const ret = envPaise('RTO_RETURN_SHIPPING_PAISE', 3700);
  const hfwd = envPaise('RTO_HEAVY_FORWARD_SHIPPING_PAISE', fwd * 2);
  const hret = envPaise('RTO_HEAVY_RETURN_SHIPPING_PAISE', ret * 2);
  return { fwd, ret, hfwd, hret, standard: fwd + ret, heavy: hfwd + hret };
}

/** Which gateway holds the money, from the shape of the payment id. */
function gatewayFor(paymentId) {
  const id = String(paymentId || '').trim();
  if (!id) return null;
  return id.startsWith('pay_') ? 'razorpay' : 'phonepe';
}

/**
 * The refund for one order: what was paid, minus both legs at its tier.
 * @returns {{gateway, gross, deduction, refund, parcel}}
 */
function rtoRefundFor(order, { rates = defaultRates(), heavyAtBooks = 2, parcelTier } = {}) {
  const tierOf = parcelTier || require('./parcel-tier').parcelTier;
  const gross = Math.round(Number(order.amount_paise) || 0);
  const cart = Array.isArray(order.cart_items) ? order.cart_items : [];
  const parcel = tierOf(cart, { heavyAtBooks });
  const deduction = rates[parcel.tier] ?? rates.standard;
  return {
    gateway: gatewayFor(order.razorpay_payment_id),
    gross,
    deduction,
    refund: Math.max(0, gross - deduction),
    parcel,
  };
}

// XpressBees AWBs booked on our own account. Everything else went out through
// NimbusPost (its Delhivery, DTDC, Bluedart, Ekart, Amazon and XpressBees).
const XB_DIRECT_RE = /^1434[45]/;

function courierFor(awb) {
  return XB_DIRECT_RE.test(String(awb || '').trim()) ? 'xpressbees' : 'nimbuspost';
}

const RTO_DELIVERED_TEXT = /^rto[ _-]?delivered$/i;

/**
 * XpressBees tracking payload -> back with us?
 * The headline status says only "rto" for the whole return journey, so the
 * answer is in the scan history: status_code RT-DL is "RTO Delivered".
 */
function xbReturnedToOrigin(d, awb) {
  if (!d || typeof d !== 'object') return { verified: false, reason: 'no tracking data' };
  if (d.awb_number && String(d.awb_number).trim() !== String(awb).trim()) {
    return { verified: false, reason: `tracking returned a different AWB (${d.awb_number})` };
  }
  const history = Array.isArray(d.history) ? d.history : [];
  const scan = history.find(h => String(h?.status_code || '').toUpperCase() === 'RT-DL'
    || RTO_DELIVERED_TEXT.test(String(h?.message || '').trim()));
  if (scan) return { verified: true, scan: `${scan.message || scan.status_code} · ${scan.event_time || ''}`.trim() };
  const latest = history.slice().sort((a, b) => String(b.event_time || '').localeCompare(String(a.event_time || '')))[0];
  return { verified: false, reason: `not back yet: ${latest?.message || d.status || 'no scans'}` };
}

/** NimbusPost track/bulk row -> back with us? Only an exact AWB match counts. */
function npReturnedToOrigin(row, awb) {
  if (!row) return { verified: false, reason: 'AWB not returned by NimbusPost' };
  if (String(row.awb_number || '').trim() !== String(awb).trim()) {
    return { verified: false, reason: 'NimbusPost returned a different AWB' };
  }
  const status = String(row.status || '').trim();
  if (RTO_DELIVERED_TEXT.test(status)) return { verified: true, scan: status };
  // The headline says only "rto" for the whole return trip; the delivered-back
  // scan is in the history, under whichever of these fields the courier fills.
  const history = Array.isArray(row.history) ? row.history : [];
  const scan = history.find(h => String(h?.status_code || '').toUpperCase() === 'RT-DL'
    || RTO_DELIVERED_TEXT.test(String(h?.status || '').trim())
    || RTO_DELIVERED_TEXT.test(String(h?.message || '').trim()));
  if (scan) return { verified: true, scan: `${scan.message || scan.status || scan.status_code} · ${scan.event_time || ''}`.trim() };
  // What the courier did say, so a wording we do not recognise shows up in
  // the admin preview instead of an order waiting forever for no visible reason.
  const latest = history.slice().sort((a, b) => String(b.event_time || '').localeCompare(String(a.event_time || '')))
    .slice(0, 2).map(h => [h.status_code, h.status, h.message].filter(Boolean).join('/')).join(' | ');
  return { verified: false, reason: `not back yet: ${status || 'unknown'}${latest ? ` (latest: ${latest})` : ''}` };
}

const NP_BASE = 'https://api.nimbuspost.com/v1';

/**
 * Live NimbusPost rows for many AWBs, keyed by AWB. One login, chunks of 50.
 * Throws only on login failure; a failed chunk just leaves its AWBs out, which
 * reads as "not verified".
 */
async function npTrackMany(awbs, { fetchImpl = globalThis.fetch } = {}) {
  const out = new Map();
  const list = [...new Set(awbs.map(a => String(a || '').trim()).filter(Boolean))];
  if (!list.length) return out;
  const email = process.env.NIMBUSPOST_EMAIL;
  const password = process.env.NIMBUSPOST_PASSWORD;
  if (!email || !password) throw new Error('NimbusPost credentials are not configured');
  const login = await fetchImpl(`${NP_BASE}/users/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const lb = await login.json().catch(() => ({}));
  const token = lb?.data || lb?.token;
  if (!login.ok || typeof token !== 'string' || !token) throw new Error('NimbusPost login failed');
  for (let i = 0; i < list.length; i += 50) {
    const chunk = list.slice(i, i + 50);
    try {
      const res = await fetchImpl(`${NP_BASE}/shipments/track/bulk`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ awb: chunk }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body?.status !== true) continue;
      for (const row of Array.isArray(body.data) ? body.data : []) {
        const k = String(row?.awb_number || '').trim();
        if (k) out.set(k, row);
      }
    } catch { /* this chunk stays unverified */ }
  }
  return out;
}

module.exports = {
  defaultRates, gatewayFor, rtoRefundFor, courierFor,
  xbReturnedToOrigin, npReturnedToOrigin, npTrackMany, RTO_DELIVERED_TEXT,
};
