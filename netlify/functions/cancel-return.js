/**
 * Netlify Function: cancel-return
 * POST /.netlify/functions/cancel-return
 *
 * Lets a signed-in customer cancel their own PENDING return request.
 * Only works while status = 'pending' — once the admin has started
 * processing (approved/rejected), the customer can no longer cancel.
 */

const { createClient } = require('@supabase/supabase-js');

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Supabase not configured.' }) };
    }

    // Verify JWT
    const authHeader = event.headers.authorization || event.headers.Authorization || '';
    const token = authHeader.replace(/^Bearer\s+/i, '').trim();
    if (!token) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Please sign in first.' }) };

    const body = JSON.parse(event.body || '{}');
    const orderId = String(body.order_id || '').trim().slice(0, 120);
    if (!orderId) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Missing order_id.' }) };

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // Verify user identity
    const { data: userResult, error: userError } = await supabase.auth.getUser(token);
    if (userError || !userResult?.user?.email) {
      return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Please sign in again.' }) };
    }
    const email = userResult.user.email.toLowerCase();

    // Find the return request — verify it belongs to this customer
    const { data: retReq, error: fetchErr } = await supabase
      .from('return_requests')
      .select('id, status, customer_email, order_id')
      .eq('order_id', orderId)
      .maybeSingle();

    if (fetchErr) throw fetchErr;

    if (!retReq) {
      return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: 'No return request found for this order.' }) };
    }
    if (String(retReq.customer_email || '').toLowerCase() !== email) {
      return { statusCode: 403, headers: CORS, body: JSON.stringify({ error: 'This return request does not belong to your account.' }) };
    }
    if (retReq.status !== 'pending') {
      return {
        statusCode: 400,
        headers: CORS,
        body: JSON.stringify({ error: `This return request has already been ${retReq.status} and can no longer be cancelled. Please contact support.` }),
      };
    }

    // Delete the return request — customer can submit a new one if needed
    const { error: delErr } = await supabase
      .from('return_requests')
      .delete()
      .eq('id', retReq.id);

    if (delErr) throw delErr;

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ success: true, message: 'Return request cancelled successfully.' }),
    };

  } catch (err) {
    console.error('cancel-return error:', err);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message || 'Could not cancel return request.' }) };
  }
};
