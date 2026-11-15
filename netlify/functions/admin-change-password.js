/**
 * Netlify Function: admin-change-password
 * POST /.netlify/functions/admin-change-password   (staff login)
 *   { current_password, new_password }
 *
 * A staff member replaces the temporary password the owner gave them. The
 * owner's own password is an environment secret and is not changed here.
 *
 * On success every session of that login ends (utils/staff-sessions), this one
 * included, so they sign in again with the new password -- and anyone who saw
 * the temporary password is locked out.
 */
const { createClient } = require('@supabase/supabase-js');
const { requireAdmin, getAdminPayload } = require('./utils/admin-auth');
const { hashPassword, verifyPassword, passwordProblem } = require('./utils/staff-password');
const { revokeStaffSessions, staffEmail } = require('./utils/staff-sessions');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Token',
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
};
const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });

exports.handler = async (event, _context, deps = {}) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });
  const blocked = requireAdmin(event, CORS); if (blocked) return blocked;

  const email = staffEmail(getAdminPayload(event));
  if (!email) return json(400, { error: 'Only staff logins change their password here. The owner password is set on the server.' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }
  const current = String(body.current_password || '');
  const next = String(body.new_password || '');
  if (!current || !next) return json(400, { error: 'Current and new password are required' });
  if (next === current) return json(400, { error: 'The new password must be different' });
  const weak = passwordProblem(next, { email });
  if (weak) return json(400, { error: weak });

  const sb = deps.supabase || createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const { data: row, error } = await sb.from('admin_users')
    .select('id, password_hash, active').eq('email', email).maybeSingle();
  if (error) return json(500, { error: 'Could not read the login' });
  if (!row || !row.active) return json(403, { error: 'This login is disabled' });

  // Same small floor as admin-login against guessing.
  await new Promise((r) => setTimeout(r, deps.delayMs ?? 250));
  if (!verifyPassword(current, row.password_hash)) return json(400, { error: 'Current password is wrong' });   // not 401: that signs the admin page out

  const { error: uErr } = await sb.from('admin_users')
    .update({ password_hash: hashPassword(next), updated_at: new Date().toISOString() })
    .eq('id', row.id);
  if (uErr) return json(500, { error: 'Could not save the new password' });

  await (deps.revoke || revokeStaffSessions)(email).catch((e) => console.error('[admin-change-password] revoke:', e.message));
  return json(200, { ok: true, sign_in_again: true });
};
