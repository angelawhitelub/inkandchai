/**
 * Netlify Function: get-abandoned-checkouts
 * GET /.netlify/functions/get-abandoned-checkouts
 *
 * Admin endpoint for checkout leads that did not convert.
 */

const { createClient } = require('@supabase/supabase-js');
const { classifyLead } = require('./utils/spam-filter');
const { requireAdmin } = require('./utils/admin-auth');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key',
  'Content-Type': 'application/json',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  const _adminBlock = requireAdmin(event, CORS); if (_adminBlock) return _adminBlock;
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'SUPABASE_URL and SUPABASE_SERVICE_KEY environment variables are not set in Netlify.' }) };
  }

  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const page = Math.max(1, parseInt(event.queryStringParameters?.page || '1', 10));
    const limit = Math.min(500, Math.max(1, parseInt(event.queryStringParameters?.limit || '100', 10)));
    const minAgeMinutes = Math.max(0, parseInt(event.queryStringParameters?.min_age_minutes || '30', 10));
    const from = (page - 1) * limit;
    const cutoff = new Date(Date.now() - minAgeMinutes * 60 * 1000).toISOString();

    let query = supabase
      .from('abandoned_checkouts')
      .select('*', { count: 'exact' })
      .eq('status', 'open')
      .or('source.is.null,source.neq.paperbound')  // exclude paperbound leads
      .lte('updated_at', cutoff)
      .order('updated_at', { ascending: false })
      .range(from, from + limit - 1);

    const q = String(event.queryStringParameters?.q || '').trim();
    if (q) {
      query = query.or(`customer_name.ilike.%${q}%,customer_email.ilike.%${q}%,customer_phone.ilike.%${q}%`);
    }

    const { data, error, count } = await query;
    if (error) throw error;

    // Hide spam/bot leads from the admin view (existing junk already in the DB
    // is filtered out here so the list is clean without a migration).
    const includeSpam = event.queryStringParameters?.include_spam === '1';
    const rows = data || [];
    const clean = includeSpam ? rows : rows.filter(r => !classifyLead({
      name: r.customer_name, email: r.customer_email, phone: r.customer_phone,
    }).spam);
    const hiddenSpam = rows.length - clean.length;

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ checkouts: clean, total: count || 0, hidden_spam: hiddenSpam, page, limit, min_age_minutes: minAgeMinutes }),
    };
  } catch (err) {
    console.error('get-abandoned-checkouts error:', err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
