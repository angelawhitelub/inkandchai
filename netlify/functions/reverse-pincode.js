/**
 * Netlify Function: reverse-pincode
 * GET /.netlify/functions/reverse-pincode?lat=28.657&lon=77.221
 *
 * Turns browser coordinates into an Indian pincode so a shopper can get their
 * own delivery date without typing anything. The pincode then goes through the
 * normal delivery-estimate path — this function does nothing but geocode.
 *
 * Privacy: the browser only calls this after the visitor taps "Use my location"
 * and grants the permission prompt. Coordinates are rounded to 3 decimals
 * (~110 m) before they leave the page, which is far finer than a pincode needs
 * and coarse enough that the value is a neighbourhood rather than a doorstep.
 * Nothing is stored: no database write, no logging of the coordinates. The
 * rounding also makes the response cacheable per neighbourhood at the edge.
 *
 * Two providers, tried in order, because neither is ours:
 *   1. BigDataCloud reverse-geocode-client — keyless, no documented rate limit
 *   2. OpenStreetMap Nominatim — better rural coverage, but rate-limited, so it
 *      is only reached when the first has no postcode
 */
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

const TIMEOUT_MS = 4000;

/** 6-digit Indian pincode, first digit 1-8. */
function cleanPincode(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return /^[1-8]\d{5}$/.test(digits) ? digits : '';
}

function coord(value, limit) {
  // Number('') is 0, which would silently geocode the Gulf of Guinea.
  if (value === '' || value === null || value === undefined) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || Math.abs(n) > limit) return null;
  return Math.round(n * 1000) / 1000;
}

async function getJson(url, headers) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fromBigDataCloud(lat, lon) {
  const data = await getJson(
    `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=en`
  );
  if (!data) return null;
  const pincode = cleanPincode(data.postcode);
  if (!pincode) return null;
  return {
    pincode,
    city: data.city || data.locality || '',
    state: data.principalSubdivision || '',
    country: data.countryCode || '',
  };
}

async function fromNominatim(lat, lon) {
  const data = await getJson(
    `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=18&lat=${lat}&lon=${lon}`,
    { 'User-Agent': 'inkandchai.in delivery estimate (support@inkandchai.in)', 'Accept-Language': 'en' }
  );
  const address = data && data.address;
  if (!address) return null;
  const pincode = cleanPincode(address.postcode);
  if (!pincode) return null;
  return {
    pincode,
    city: address.city || address.town || address.village || address.suburb || '',
    state: address.state || '',
    country: String(address.country_code || '').toUpperCase(),
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  const params = event.queryStringParameters || {};
  const lat = coord(params.lat, 90);
  const lon = coord(params.lon, 180);
  if (lat === null || lon === null) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'lat and lon are required.' }) };
  }

  let hit = await fromBigDataCloud(lat, lon);
  if (!hit) hit = await fromNominatim(lat, lon);

  if (!hit) {
    // Soft failure on purpose: the widget falls back to the typed pincode, and
    // "we could not read your location" is a worse message than a quiet retry.
    return {
      statusCode: 200,
      headers: { ...CORS, 'Cache-Control': 'public, max-age=60' },
      body: JSON.stringify({ pincode: '', message: 'Could not find a pincode for that location.' }),
    };
  }

  // We ship within India only; a foreign fix would send the shopper down the
  // serviceability path with a pincode that means nothing here.
  if (hit.country && hit.country !== 'IN') {
    return {
      statusCode: 200,
      headers: { ...CORS, 'Cache-Control': 'public, max-age=600' },
      body: JSON.stringify({ pincode: '', message: 'We currently deliver within India only.' }),
    };
  }

  return {
    statusCode: 200,
    headers: {
      ...CORS,
      // Coordinates are already rounded to a neighbourhood, and a pincode
      // boundary does not move, so this is safe to hold for a long time.
      'Cache-Control': 'public, max-age=86400',
      'Netlify-CDN-Cache-Control': 'public, durable, s-maxage=604800',
    },
    body: JSON.stringify({ pincode: hit.pincode, city: hit.city, state: hit.state }),
  };
};

exports._test = { cleanPincode, coord };
