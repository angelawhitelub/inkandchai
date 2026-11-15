/**
 * Staff (limited admin) passwords: salted scrypt, stored in admin_users.
 * One place for hashing and checking, shared by admin-users (owner grants or
 * resets), admin-login (sign-in) and admin-change-password (staff's own).
 */
const crypto = require('crypto');

const MIN_LENGTH = 10;

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(String(password || ''), salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$8$${salt.toString('hex')}$${derived.toString('hex')}`;
}

function verifyPassword(password, encoded) {
  try {
    const [prefix, nRaw, rRaw, saltHex, digestHex] = String(encoded || '').split('$');
    if (prefix !== 'scrypt' || !saltHex || !digestHex) return false;
    const derived = crypto.scryptSync(String(password || ''), Buffer.from(saltHex, 'hex'), digestHex.length / 2, {
      N: Number(nRaw) || 16384, r: Number(rRaw) || 8, p: 1,
    });
    const expected = Buffer.from(digestHex, 'hex');
    return expected.length === derived.length && crypto.timingSafeEqual(expected, derived);
  } catch { return false; }
}

/** null when acceptable, else the reason. */
function passwordProblem(password, { email = '' } = {}) {
  const p = String(password || '');
  if (p.length < MIN_LENGTH) return `Password must be at least ${MIN_LENGTH} characters`;
  if (p.length > 200) return 'Password is too long';
  if (/^(.)\1+$/.test(p)) return 'Password is too simple';
  const name = String(email || '').split('@')[0].toLowerCase();
  if (name.length >= 4 && p.toLowerCase().includes(name)) return 'Password must not contain the email name';
  return null;
}

module.exports = { MIN_LENGTH, hashPassword, verifyPassword, passwordProblem };
