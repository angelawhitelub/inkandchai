'use strict';
// Limited admin (customer care) logins, 16 Nov 2026.
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.ADMIN_TOKEN_SECRET = process.env.ADMIN_TOKEN_SECRET || 'test-signing-secret-for-staff-access';

const { signAdminToken, requireAdmin } = require('./admin-auth');
const { hashPassword, verifyPassword, passwordProblem } = require('./staff-password');
const ss = require('./staff-sessions');

const call = (name, token, method = 'GET') => ({
  path: `/.netlify/functions/${name}`, httpMethod: method, headers: { 'x-admin-token': token },
});
const staff = (email = 'care@example.com', iat) => {
  const t = signAdminToken({ sub: `email:${email}`, role: 'support' });
  return iat ? t : t;
};

test('staff cannot send the marketing WhatsApp broadcast', () => {
  const r = requireAdmin(call('whatsapp-broadcast', staff(), 'POST'));
  assert.equal(r && r.statusCode, 403);
});

test('the customer care screens open to staff now work for staff', () => {
  for (const name of ['admin-not-picked-up', 'admin-pickup-live', 'admin-product-search', 'get-products-admin',
    'resend-confirmation', 'admin-create-replacement', 'return-tracking-scheduled', 'admin-change-password',
    'get-orders', 'update-order-status', 'admin-support-tickets', 'bot-inbox', 'get-return-requests']) {
    assert.equal(requireAdmin(call(name, staff())), null, name);
  }
});

test('owner-only features stay closed to staff', () => {
  for (const name of ['admin-users', 'bulk-update-orders', 'delete-order', 'admin-promotions', 'update-product-override',
    'nimbuspost-order-push', 'xpressbees-ship', 'admin-cancel-window', 'bot-settings', 'admin-nimbuspost-order-cancel']) {
    assert.equal(requireAdmin(call(name, staff()))?.statusCode, 403, name);
  }
  const owner = signAdminToken({ sub: 'email:owner@example.com', role: 'owner' });
  assert.equal(requireAdmin(call('admin-users', owner)), null);
});

test('staff passwords: scrypt round trip and the simple rules', () => {
  const h = hashPassword('correct horse battery');
  assert.match(h, /^scrypt\$16384\$8\$[0-9a-f]{32}\$[0-9a-f]{128}$/);
  assert.equal(verifyPassword('correct horse battery', h), true);
  assert.equal(verifyPassword('correct horse batterz', h), false);
  assert.equal(verifyPassword('x', 'garbage'), false);
  assert.match(passwordProblem('short'), /at least 10/);
  assert.match(passwordProblem('aaaaaaaaaaaa'), /too simple/);
  assert.match(passwordProblem('priya2026!!', { email: 'priya@example.com' }), /email name/);
  assert.equal(passwordProblem('Chai-and-books-77', { email: 'priya@example.com' }), null);
});

test('a staff token issued before its revocation is refused; a new sign-in is not', () => {
  const before = staff('care@example.com');
  const claims = ss.tokenClaims(before);
  assert.equal(claims.role, 'support');
  const map = { 'care@example.com': claims.iat + 5 };
  assert.equal(ss.isRevoked(claims, map), true);
  assert.equal(ss.isRevoked({ ...claims, iat: claims.iat + 10 }, map), false);   // signed in after
  assert.equal(ss.isRevoked(claims, { 'other@example.com': claims.iat + 5 }), false);
  assert.equal(ss.isRevoked(claims, null), false);
  // Owner tokens are never revoked here, whatever the list says.
  const owner = ss.tokenClaims(signAdminToken({ sub: 'email:care@example.com', role: 'owner' }));
  assert.equal(ss.isRevoked(owner, { 'care@example.com': Date.now() + 1e6 }), false);
});

test('the Worker finds staff tokens in the header and in the session cookie', () => {
  const t = staff();
  const fromHeader = ss.requestTokens((h) => (h === 'x-admin-token' ? t : ''));
  const fromCookie = ss.requestTokens((h) => (h === 'cookie' ? `a=1; iac_admin_session=${t}; b=2` : ''));
  assert.deepEqual(fromHeader, [t]);
  assert.deepEqual(fromCookie, [t]);
  const iat = ss.tokenClaims(t).iat;
  assert.ok(ss.revokedStaffToken(fromCookie, { 'care@example.com': iat }));
  assert.equal(ss.revokedStaffToken(fromCookie, {}), null);
  assert.equal(ss.tokenClaims('not.a.token'), null);
});

test('change password: checks the current one, saves a new hash, ends the sessions', async () => {
  const { handler } = require('../admin-change-password');
  const stored = { id: 'u1', password_hash: hashPassword('Temporary-pass-1'), active: true };
  let saved = null; const revoked = [];
  const supabase = {
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: stored, error: null }) }) }),
      update: (patch) => ({ eq: async () => { saved = patch; return { error: null }; } }),
    }),
  };
  const deps = { supabase, delayMs: 0, revoke: async (e) => { revoked.push(e); } };
  const ev = (body, token = staff('care@example.com')) => ({ ...call('admin-change-password', token, 'POST'), body: JSON.stringify(body) });

  let r = await handler(ev({ current_password: 'wrong-password', new_password: 'Brand-new-pass-9' }), {}, deps);
  assert.equal(r.statusCode, 400);
  assert.equal(saved, null);

  r = await handler(ev({ current_password: 'Temporary-pass-1', new_password: 'short' }), {}, deps);
  assert.equal(r.statusCode, 400);

  r = await handler(ev({ current_password: 'Temporary-pass-1', new_password: 'Brand-new-pass-9' }), {}, deps);
  assert.equal(r.statusCode, 200);
  assert.equal(verifyPassword('Brand-new-pass-9', saved.password_hash), true);
  assert.deepEqual(revoked, ['care@example.com']);

  // The owner's password is an environment secret, not changed here.
  const owner = signAdminToken({ sub: 'email:owner@example.com', role: 'owner' });
  r = await handler(ev({ current_password: 'a', new_password: 'Brand-new-pass-9' }, owner), {}, deps);
  assert.equal(r.statusCode, 400);
});
