const { createClient } = require('@supabase/supabase-js');
const { resolveCartPrices } = require('./utils/pricing');
const { findShippingRestriction } = require('./utils/shipping-restrictions');
const { isFakePincode } = require('./utils/pincode-valid');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const cart = Array.isArray(body.cart) ? body.cart : [];
    const pincode = String(body.pincode || '').replace(/\D/g, '');
    if (!cart.length || pincode.length !== 6 || isFakePincode(pincode)) {
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ allowed: true }) };
    }
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const priced = await resolveCartPrices(cart, supabase);
    const restriction = findShippingRestriction(priced.cart, {
      pincode,
      state: body.state || '',
      address: body.address || '',
    });
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify(restriction.blocked
        ? { allowed: false, ...restriction }
        : { allowed: true }),
    };
  } catch (err) {
    // UI validation fails open because every order endpoint repeats this check
    // and fails closed before creating an order or payment.
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
