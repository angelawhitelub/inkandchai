/**
 * Netlify Function: pincode-lookup
 * GET /.netlify/functions/pincode-lookup?pin=110006
 *
 * Server-side proxy for Indian pincode → city/state lookup.
 * Tries multiple APIs so a single outage never breaks checkout.
 *
 * Response: { city, state }  or  { error: "not found" }
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

// ── Built-in table for top-40 high-traffic Indian pincodes ───────────────────
// Ensures checkout never breaks even if all external APIs are down.
const FALLBACK_TABLE = {
  '110001': { city: 'New Delhi',   state: 'Delhi' },
  '110002': { city: 'New Delhi',   state: 'Delhi' },
  '110003': { city: 'New Delhi',   state: 'Delhi' },
  '110004': { city: 'New Delhi',   state: 'Delhi' },
  '110005': { city: 'New Delhi',   state: 'Delhi' },
  '110006': { city: 'New Delhi',   state: 'Delhi' },
  '110007': { city: 'New Delhi',   state: 'Delhi' },
  '110008': { city: 'New Delhi',   state: 'Delhi' },
  '110009': { city: 'New Delhi',   state: 'Delhi' },
  '110010': { city: 'New Delhi',   state: 'Delhi' },
  '110011': { city: 'New Delhi',   state: 'Delhi' },
  '110012': { city: 'New Delhi',   state: 'Delhi' },
  '110013': { city: 'New Delhi',   state: 'Delhi' },
  '110014': { city: 'New Delhi',   state: 'Delhi' },
  '110015': { city: 'New Delhi',   state: 'Delhi' },
  '110016': { city: 'New Delhi',   state: 'Delhi' },
  '110017': { city: 'New Delhi',   state: 'Delhi' },
  '110018': { city: 'New Delhi',   state: 'Delhi' },
  '110019': { city: 'New Delhi',   state: 'Delhi' },
  '110020': { city: 'New Delhi',   state: 'Delhi' },
  '110021': { city: 'New Delhi',   state: 'Delhi' },
  '110022': { city: 'New Delhi',   state: 'Delhi' },
  '110023': { city: 'New Delhi',   state: 'Delhi' },
  '110024': { city: 'New Delhi',   state: 'Delhi' },
  '110025': { city: 'New Delhi',   state: 'Delhi' },
  '110034': { city: 'New Delhi',   state: 'Delhi' },
  '110051': { city: 'New Delhi',   state: 'Delhi' },
  '110092': { city: 'New Delhi',   state: 'Delhi' },
  '400001': { city: 'Mumbai',      state: 'Maharashtra' },
  '400050': { city: 'Mumbai',      state: 'Maharashtra' },
  '400070': { city: 'Mumbai',      state: 'Maharashtra' },
  '400076': { city: 'Mumbai',      state: 'Maharashtra' },
  '500001': { city: 'Hyderabad',   state: 'Telangana' },
  '600001': { city: 'Chennai',     state: 'Tamil Nadu' },
  '700001': { city: 'Kolkata',     state: 'West Bengal' },
  '560001': { city: 'Bengaluru',   state: 'Karnataka' },
  '380001': { city: 'Ahmedabad',   state: 'Gujarat' },
  '302001': { city: 'Jaipur',      state: 'Rajasthan' },
  '226001': { city: 'Lucknow',     state: 'Uttar Pradesh' },
  '411001': { city: 'Pune',        state: 'Maharashtra' },
  '201301': { city: 'Noida',       state: 'Uttar Pradesh' },
  '122001': { city: 'Gurugram',    state: 'Haryana' },
  '160001': { city: 'Chandigarh',  state: 'Chandigarh' },
  '800001': { city: 'Patna',       state: 'Bihar' },
  '440001': { city: 'Nagpur',      state: 'Maharashtra' },
  '208001': { city: 'Kanpur',      state: 'Uttar Pradesh' },
  '395001': { city: 'Surat',       state: 'Gujarat' },
  '282001': { city: 'Agra',        state: 'Uttar Pradesh' },
  '474001': { city: 'Gwalior',     state: 'Madhya Pradesh' },
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  const pin = (event.queryStringParameters?.pin || '').replace(/\D/g, '');
  if (pin.length !== 6) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid pincode' }) };
  }

  // ── 1. postalpincode.in ───────────────────────────────────────────────────
  try {
    const res = await fetch(`https://api.postalpincode.in/pincode/${pin}`, {
      signal: AbortSignal.timeout(4000),
    });
    if (res.ok) {
      const data = await res.json();
      if (data[0]?.Status === 'Success' && data[0].PostOffice?.length) {
        const po = data[0].PostOffice[0];
        const city  = po.District || po.Division || po.Block || po.Name || '';
        const state = po.State || '';
        if (city && state) {
          return { statusCode: 200, headers: CORS, body: JSON.stringify({ city, state }) };
        }
      }
    }
  } catch (_) { /* fall through */ }

  // ── 2. zippopotam.us ─────────────────────────────────────────────────────
  try {
    const res = await fetch(`https://api.zippopotam.us/in/${pin}`, {
      signal: AbortSignal.timeout(4000),
    });
    if (res.ok) {
      const data = await res.json();
      const place = data.places?.[0];
      if (place?.['place name'] && place?.['state']) {
        return {
          statusCode: 200,
          headers: CORS,
          body: JSON.stringify({ city: place['place name'], state: place['state'] }),
        };
      }
    }
  } catch (_) { /* fall through */ }

  // ── 3. Built-in fallback table ────────────────────────────────────────────
  if (FALLBACK_TABLE[pin]) {
    return { statusCode: 200, headers: CORS, body: JSON.stringify(FALLBACK_TABLE[pin]) };
  }

  return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: 'Pincode not found' }) };
};
