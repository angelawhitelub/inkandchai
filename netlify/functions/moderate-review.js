/**
 * Netlify Function: moderate-review
 * POST /.netlify/functions/moderate-review
 *
 * Approve or reject a product review (admin only).
 * Body: { review_id, action: 'approve' | 'reject' }
 */

const { createClient } = require('@supabase/supabase-js');

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  let body;
  try { body = JSON.parse(event.body); } catch {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { review_id, action } = body || {};
  if (!review_id || !['approve', 'reject'].includes(action)) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'review_id and action (approve/reject) required' }) };
  }

  if (action === 'reject') {
    const { error } = await supabase.from('product_reviews').delete().eq('id', review_id);
    if (error) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: error.message }) };
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ success: true, action: 'deleted' }) };
  }

  // approve
  const { error } = await supabase
    .from('product_reviews')
    .update({ approved: true })
    .eq('id', review_id);

  if (error) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: error.message }) };
  return { statusCode: 200, headers: CORS, body: JSON.stringify({ success: true, action: 'approved' }) };
};
