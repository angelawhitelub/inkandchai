/** Owner-only management of limited admin accounts. */
const { createClient } = require('@supabase/supabase-js');
const { requireAdmin, getAdminPayload } = require('./utils/admin-auth');
const { hashPassword, passwordProblem } = require('./utils/staff-password');
const { revokeStaffSessions } = require('./utils/staff-sessions');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key, X-Admin-Token',
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
};

function ownerOnly(event) {
  const block = requireAdmin(event, CORS);
  if (block) return block;
  const payload = getAdminPayload(event);
  // The legacy shared key is accepted by requireAdmin and is owner access.
  if (payload && payload.role && payload.role !== 'owner') {
    return { statusCode: 403, headers: CORS, body: JSON.stringify({ error: 'Owner access required' }) };
  }
  return null;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  const blocked = ownerOnly(event); if (blocked) return blocked;
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return { statusCode: 503, headers: CORS, body: JSON.stringify({ error: 'Supabase is not configured' }) };
  }
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  try {
    if (event.httpMethod === 'GET') {
      const { data, error } = await sb.from('admin_users')
        .select('id,email,role,active,created_at,updated_at').order('created_at', { ascending: false });
      if (error) throw error;
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ users: data || [] }) };
    }
    if (event.httpMethod === 'DELETE') {
      const id = String(event.queryStringParameters?.id || '');
      if (!id) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'id required' }) };
      const { data: row, error } = await sb.from('admin_users').update({ active: false, updated_at: new Date().toISOString() })
        .eq('id', id).select('email').maybeSingle();
      if (error) throw error;
      if (!row) return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: 'No such staff login' }) };
      // Signed out everywhere within about a minute, not when the token expires.
      const signedOut = await revokeStaffSessions(row.email).catch((e) => { console.error('[admin-users] revoke:', e.message); return false; });
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, signed_out: signedOut }) };
    }
    if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method Not Allowed' }) };
    let body; try { body = JSON.parse(event.body || '{}'); } catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }
    const email = String(body.email || '').trim().toLowerCase();
    const role = String(body.role || 'support').trim().toLowerCase();
    const password = String(body.password || '');
    if (!/^\S+@\S+\.\S+$/.test(email)) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Valid email required' }) };
    if (role !== 'support') return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Only the support role is available' }) };
    const weak = passwordProblem(password, { email });
    if (weak) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: weak }) };
    const ownerEmail = String(process.env.ADMIN_EMAIL || process.env.STORE_OWNER_EMAIL || '').trim().toLowerCase();
    if (email === ownerEmail) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Owner email cannot be added as staff' }) };
    const { data, error } = await sb.from('admin_users').upsert({
      email, role, password_hash: hashPassword(password), active: true,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'email' }).select('id,email,role,active,created_at,updated_at').single();
    if (error) throw error;
    // Granting again is how a password is reset: any session on the old
    // password ends now.
    await revokeStaffSessions(email).catch((e) => console.error('[admin-users] revoke:', e.message));
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, user: data }) };
  } catch (e) {
    console.error('[admin-users]', e.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: e.message }) };
  }
};

