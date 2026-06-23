/**
 * POST /.netlify/functions/passkey-login-options
 * (No auth — this is the entry point to passkey login.)
 *
 * Returns WebAuthn authentication options. If no passkeys are registered,
 * returns { hasPasskeys: false } so the UI can hide the button.
 */

const { generateAuthenticationOptions } = require('@simplewebauthn/server');
const { RP_ID, USERNAME, supa, json, preflight, storeChallenge } = require('./utils/passkey');

exports.handler = async (event) => {
  const pre = preflight(event); if (pre) return pre;
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

  try {
    const sb = supa();
    const { data: creds } = await sb
      .from('admin_passkeys').select('credential_id, transports').eq('username', USERNAME);

    if (!creds || creds.length === 0) {
      return json(200, { hasPasskeys: false });
    }

    const options = await generateAuthenticationOptions({
      rpID: RP_ID,
      userVerification: 'preferred',
      allowCredentials: creds.map(c => ({
        id: c.credential_id,
        transports: c.transports ? c.transports.split(',') : undefined,
      })),
    });

    await storeChallenge(sb, options.challenge, 'login');
    return json(200, { hasPasskeys: true, options });
  } catch (e) {
    console.error('[passkey-login-options]', e);
    return json(500, { error: e.message });
  }
};
