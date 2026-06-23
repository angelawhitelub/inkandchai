/**
 * POST /.netlify/functions/passkey-register-verify
 * Header: X-Admin-Key
 * Body: { attResp, deviceLabel? }  -- attResp from startRegistration()
 *
 * Verifies the attestation and stores the new credential.
 */

const { verifyRegistrationResponse } = require('@simplewebauthn/server');
const { RP_ID, RP_ORIGIN, USERNAME, supa, json, preflight, adminAuthOk, consumeChallenge } = require('./utils/passkey');

exports.handler = async (event) => {
  const pre = preflight(event); if (pre) return pre;
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });
  if (!adminAuthOk(event))         return json(401, { error: 'Unauthorized' });

  let body; try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: 'Invalid JSON' }); }
  const { attResp, deviceLabel } = body;
  if (!attResp?.response?.clientDataJSON) return json(400, { error: 'Missing attResp' });

  try {
    const sb = supa();

    // Pull the challenge from clientDataJSON so we can check it was issued by us
    // within the TTL — then verify the attestation against that challenge.
    const clientData = JSON.parse(Buffer.from(attResp.response.clientDataJSON, 'base64').toString('utf8'));
    const challengeOk = await consumeChallenge(sb, clientData.challenge, 'register');
    if (!challengeOk) return json(400, { error: 'Challenge expired or invalid — try again' });

    const verification = await verifyRegistrationResponse({
      response: attResp,
      expectedChallenge: clientData.challenge,
      expectedOrigin: RP_ORIGIN,
      expectedRPID: RP_ID,
      requireUserVerification: false,
    });
    if (!verification.verified || !verification.registrationInfo) {
      return json(400, { error: 'Verification failed' });
    }

    const { credential } = verification.registrationInfo;
    const transports = (attResp.response.transports || []).join(',');

    const { error } = await sb.from('admin_passkeys').insert({
      username: USERNAME,
      credential_id: credential.id,        // base64url string
      public_key: Buffer.from(credential.publicKey).toString('base64url'),
      counter: credential.counter || 0,
      transports,
      device_label: String(deviceLabel || '').slice(0, 80) || null,
    });
    if (error) {
      if (error.code === '23505') return json(200, { ok: true, already: true });
      throw error;
    }
    return json(200, { ok: true });
  } catch (e) {
    console.error('[passkey-register-verify]', e);
    return json(500, { error: e.message });
  }
};
