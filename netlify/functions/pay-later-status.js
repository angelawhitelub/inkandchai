/**
 * Netlify Function: pay-later-status   (public, checkout)
 *   POST { phone, slugs: [..] } → { enabled, cart: 'all'|'some'|'none', eligible, checked, message, why, consent }
 *
 * Says whether the checkout should show Pay Later (utils/pay-later) and
 * whether this phone is eligible. It answers only yes/no, never the number of
 * orders, and nothing at all while the owner has the feature switched off.
 */
const { createClient } = require('@supabase/supabase-js');
const PL = require('./utils/pay-later');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
};
const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });
  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }

  const cfg = await PL.config();
  if (!cfg.enabled) return json(200, { enabled: false });
  const slugs = (Array.isArray(body.slugs) ? body.slugs : []).slice(0, 50).map((slug) => ({ slug }));
  const cart = PL.cartCoverage(slugs, cfg);
  const out = { enabled: true, cart, min_orders: PL.MIN_DELIVERED, due_days: PL.DUE_DAYS, why: PL.WHY_TEXT, consent: PL.CONSENT_TEXT };
  if (cart === 'none') return json(200, out);
  if (cart === 'some') return json(200, { ...out, eligible: false, message: 'Pay Later works only when every book in your cart is a Pay Later title.' });

  const ten = PL.phone10(body.phone);
  if (ten.length !== 10) return json(200, { ...out, eligible: false, checked: false, message: 'Enter your 10-digit mobile number above to see if you are eligible for Pay Later.' });
  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const n = await PL.deliveredCount(supabase, ten);
    const eligible = n >= PL.MIN_DELIVERED;
    return json(200, { ...out, eligible, checked: true, message: eligible ? '' : PL.NOT_ELIGIBLE });
  } catch (e) {
    console.error('[pay-later-status]', e.message);
    return json(200, { ...out, eligible: false, checked: false, message: 'We could not check Pay Later right now. Please try again in a minute.' });
  }
};
