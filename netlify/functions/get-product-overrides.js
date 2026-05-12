const { createClient } = require('@supabase/supabase-js');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key',
  'Content-Type': 'application/json',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'GET') return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method Not Allowed' }) };

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ overrides: [], warning: 'Supabase not configured' }) };
  }

  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const { data, error } = await supabase
      .from('product_overrides')
      .select('slug,title,author,category,price_inr,original_price_inr,is_active,updated_at')
      .eq('is_active', true);

    if (error) {
      console.warn('product_overrides unavailable:', error.message);
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ overrides: [], warning: error.message }) };
    }

    return { statusCode: 200, headers: CORS, body: JSON.stringify({ overrides: data || [] }) };
  } catch (err) {
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ overrides: [], warning: err.message }) };
  }
};
