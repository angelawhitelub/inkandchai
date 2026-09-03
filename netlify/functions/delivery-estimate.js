/**
 * Netlify Function: delivery-estimate
 * GET /.netlify/functions/delivery-estimate?pincode=400067
 *
 * "When will it reach me?" answered for a specific pincode.
 *
 * The product page used to print a fixed table — Delhi NCR +1, Nearby states
 * +2, Rest of India +3 — which is a guess with no pincode behind it. This asks
 * NimbusPost what its couriers actually commit to for that destination, and
 * whether COD is available there at all.
 *
 * Public and unauthenticated: it exposes nothing but a delivery date for a
 * pincode, which is precisely what a shopper is entitled to know before buying.
 *
 * Required env: NIMBUSPOST_EMAIL, NIMBUSPOST_PASSWORD
 */

const { isFakePincode } = require('./utils/pincode-valid');
const { shipByDate, pickEdd, isoDay, addDays, cacheSeconds } = require('./utils/delivery-eta');

const NP_BASE = 'https://api.nimbuspost.com/v1';
const ORIGIN_PINCODE = '110006';   // our Delhi warehouse
const PARCEL_WEIGHT_G = 400;       // a paperback with packaging
const DEFAULT_ORDER_VALUE = 399;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

function noStore(status, payload) {
  return {
    statusCode: status,
    headers: { ...CORS, 'Cache-Control': 'no-store' },
    body: JSON.stringify(payload),
  };
}

async function npLogin() {
  const email = process.env.NIMBUSPOST_EMAIL;
  const password = process.env.NIMBUSPOST_PASSWORD;
  if (!email || !password) throw new Error('NimbusPost credentials are not configured');
  const res = await fetch(`${NP_BASE}/users/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const body = await res.json().catch(() => ({}));
  const token = body && (body.data || body.token);
  if (!res.ok || typeof token !== 'string' || !token) throw new Error('NimbusPost login failed');
  return token;
}

async function serviceability(token, pincode, paymentType, orderAmount) {
  const res = await fetch(`${NP_BASE}/courier/serviceability`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      origin: ORIGIN_PINCODE,
      destination: pincode,
      payment_type: paymentType,
      order_amount: orderAmount,
      weight: PARCEL_WEIGHT_G,
    }),
  });
  const body = await res.json().catch(() => ({}));
  return Array.isArray(body && body.data) ? body.data : [];
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'GET') return noStore(405, { error: 'GET only' });

  const params = event.queryStringParameters || {};
  const pincode = String(params.pincode || params.pin || '').replace(/\D/g, '');
  const orderAmount = Math.max(1, Math.round(Number(params.value) || DEFAULT_ORDER_VALUE));
  // Limited-stock titles ship a day later; the product page knows which.
  // Was capped at 5 when the only source was a hardcoded slow-shipping list.
  // Handling time is now per product (product_settings.handling_days, max 30),
  // so the cap has to match or a long handling time would quote too early.
  const extraShipDays = Math.min(30, Math.max(0, parseInt(params.extra_days, 10) || 0));

  if (pincode.length !== 6 || isFakePincode(pincode)) {
    return noStore(400, { error: 'Enter a valid 6-digit pincode.' });
  }

  const shipBy = shipByDate(Date.now(), extraShipDays);

  try {
    const token = await npLogin();
    // Prepaid and COD asked separately: a pincode can be serviceable for one
    // and not the other, and "COD available" is half of why people check.
    const [prepaid, cod] = await Promise.all([
      serviceability(token, pincode, 'prepaid', orderAmount),
      serviceability(token, pincode, 'cod', orderAmount).catch(() => []),
    ]);

    if (!prepaid.length) {
      return {
        statusCode: 200,
        headers: { ...CORS, 'Cache-Control': `public, max-age=${cacheSeconds()}` },
        body: JSON.stringify({
          pincode, serviceable: false, ship_by: isoDay(shipBy),
          message: 'No courier currently delivers to this pincode. Try another, or write to us and we will look for a way.',
        }),
      };
    }

    // NimbusPost's EDD assumes it picks the parcel up on its usual schedule. A
    // title that needs an extra day to pick delays dispatch, so it delays
    // delivery by the same day — without this the extra day is silently
    // absorbed and the customer is quoted a date we cannot make.
    let edd = pickEdd(prepaid, shipBy);
    if (edd && extraShipDays > 0) edd = addDays(edd, extraShipDays);
    const seconds = cacheSeconds();
    return {
      statusCode: 200,
      headers: {
        ...CORS,
        'Cache-Control': `public, max-age=${seconds}`,
        // Durable edge cache: this is the same answer for every shopper in a
        // pincode, and it must still expire when the IST date rolls over.
        'Netlify-CDN-Cache-Control': `public, durable, s-maxage=${seconds}`,
      },
      body: JSON.stringify({
        pincode,
        serviceable: true,
        cod_available: cod.length > 0,
        ship_by: isoDay(shipBy),
        // Null when every courier returned an unparseable EDD — the client
        // falls back to its own estimate rather than inventing a date.
        estimated_delivery: edd ? isoDay(edd) : null,
        couriers: prepaid.length,
      }),
    };
  } catch (err) {
    console.error('delivery-estimate error:', err.message);
    // Fail soft: the page keeps its own estimate rather than showing an error
    // where a delivery date should be.
    return noStore(200, {
      pincode, serviceable: null, ship_by: isoDay(shipBy),
      error: 'Could not reach the courier network just now.',
    });
  }
};
