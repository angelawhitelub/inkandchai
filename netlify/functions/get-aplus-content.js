const { createClient } = require('@supabase/supabase-js');

const HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'public, max-age=0, must-revalidate',
  'Netlify-CDN-Cache-Control': 'public, durable, s-maxage=300, stale-while-revalidate=86400',
};

function cleanSlug(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 160);
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: HEADERS, body: '' };
  if (event.httpMethod !== 'GET') return { statusCode: 405, headers: HEADERS, body: JSON.stringify({ error: 'Method Not Allowed' }) };

  const slug = cleanSlug(event.queryStringParameters?.slug);
  if (!slug) return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Missing product slug' }) };
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ content: null }) };
  }

  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const { data, error } = await supabase
      .from('product_aplus_content')
      .select('slug,heading,intro,blocks,is_active,updated_at')
      .eq('slug', slug)
      .eq('is_active', true)
      .maybeSingle();
    if (error) throw error;
    return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ content: data || null }) };
  } catch (err) {
    // A missing migration must not break product pages.
    console.warn('A+ content unavailable:', err.message);
    return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ content: null }) };
  }
};
