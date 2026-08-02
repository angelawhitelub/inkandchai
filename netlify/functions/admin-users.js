/** Owner-only management of limited admin accounts. */
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { requireAdmin, getAdminPayload } = require('./utils/admin-auth');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key, X-Admin-Token',
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
};

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(String(password || ''), salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$8$${salt.toString('hex')}$${derived.toString('hex')}`;
}

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
      const { error } = await sb.from('admin_users').update({ active: false, updated_at: new Date().toISOString() }).eq('id', id);
      if (error) throw error;
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
    }
    if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method Not Allowed' }) };
    let body; try { body = JSON.parse(event.body || '{}'); } catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }
    const email = String(body.email || '').trim().toLowerCase();
    const role = String(body.role || 'support').trim().toLowerCase();
    const password = String(body.password || '');
    if (!/^\S+@\S+\.\S+$/.test(email)) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Valid email required' }) };
    if (role !== 'support') return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Only the support role is available' }) };
    if (password.length < 10) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Temporary password must be at least 10 characters' }) };
    const ownerEmail = String(process.env.ADMIN_EMAIL || process.env.STORE_OWNER_EMAIL || '').trim().toLowerCase();
    if (email === ownerEmail) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Owner email cannot be added as staff' }) };
    const { data, error } = await sb.from('admin_users').upsert({
      email, role, password_hash: hashPassword(password), active: true,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'email' }).select('id,email,role,active,created_at,updated_at').single();
    if (error) throw error;
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, user: data }) };
  } catch (e) {
    console.error('[admin-users]', e.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: e.message }) };
  }
};

