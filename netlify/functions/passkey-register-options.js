/**
 * POST /.netlify/functions/passkey-register-options
 * Header: X-Admin-Key (requires existing password login first)
 *
 * Returns WebAuthn registration options so the browser can call
 * navigator.credentials.create(). Stores the challenge for later verification.
 */

const { generateRegistrationOptions } = require('@simplewebauthn/server');
const { RP_ID, RP_NAME, USERNAME, supa, json, preflight, adminAuthOk, storeChallenge } = require('./utils/passkey');

exports.handler = async (event) => {
  const pre = preflight(event); if (pre) return pre;
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });
  if (!adminAuthOk(event)) return json(401, { error: 'Unauthorized' });

  try {
    const sb = supa();
    // Don't let the same authenticator register twice — pass existing credential
    // ids so navigator.credentials.create() rejects duplicates client-side.
    const { data: existing } = await sb
      .from('admin_passkeys').select('credential_id, transports').eq('username', USERNAME);

    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID: RP_ID,
      userName: USERNAME,
      // A stable user handle so multiple passkeys link to the same admin identity.
      userID: new TextEncoder().encode(USERNAME),
      attestationType: 'none',
      authenticatorSelection: {
        residentKey: 'preferred',
        userVerification: 'preferred',
      },
      excludeCredentials: (existing || []).map(c => ({
        id: c.credential_id,
        transports: c.transports ? c.transports.split(',') : undefined,
      })),
    });

    await storeChallenge(sb, options.challenge, 'register');
    return json(200, options);
  } catch (e) {
    console.error('[passkey-register-options]', e);
    return json(500, { error: e.message });
  }
};
