/**
 * POST /.netlify/functions/passkey-login-verify
 * Body: { authResp }  -- from startAuthentication()
 *
 * Verifies the signature against the stored public key. On success, returns
 * the ADMIN_SECRET so the browser can stash it as adminKey (same value the
 * password flow uses) — every existing admin function keeps working unchanged.
 */

const { verifyAuthenticationResponse } = require('@simplewebauthn/server');
const { RP_ID, RP_ORIGIN, USERNAME, supa, json, preflight, adminSessionResponse, consumeChallenge } = require('./utils/passkey');

exports.handler = async (event) => {
  const pre = preflight(event); if (pre) return pre;
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

  let body; try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: 'Invalid JSON' }); }
  const { authResp } = body;
  if (!authResp?.id || !authResp?.response?.clientDataJSON) {
    return json(400, { error: 'Missing authResp' });
  }

  try {
    const sb = supa();

    const { data: cred } = await sb
      .from('admin_passkeys')
      .select('id, credential_id, public_key, counter, transports')
      .eq('credential_id', authResp.id)
      .eq('username', USERNAME)
      .maybeSingle();
    if (!cred) return json(400, { error: 'Unknown passkey' });

    const clientData = JSON.parse(Buffer.from(authResp.response.clientDataJSON, 'base64').toString('utf8'));
    const challengeOk = await consumeChallenge(sb, clientData.challenge, 'login');
    if (!challengeOk) return json(400, { error: 'Challenge expired — try again' });

    const verification = await verifyAuthenticationResponse({
      response: authResp,
      expectedChallenge: clientData.challenge,
      expectedOrigin: RP_ORIGIN,
      expectedRPID: RP_ID,
      credential: {
        id: cred.credential_id,
        publicKey: new Uint8Array(Buffer.from(cred.public_key, 'base64url')),
        counter: Number(cred.counter || 0),
        transports: cred.transports ? cred.transports.split(',') : undefined,
      },
      requireUserVerification: false,
    });
    if (!verification.verified) return json(401, { error: 'Verification failed' });

    // Advance counter + record usage (counter==0 means the authenticator doesn't
    // track it, which is normal for platform passkeys; no replay concern there).
    await sb.from('admin_passkeys').update({
      counter: verification.authenticationInfo.newCounter || cred.counter || 0,
      last_used_at: new Date().toISOString(),
    }).eq('id', cred.id);

    // Issue a short-lived signed token (preferred) AND the legacy raw key
    // (so admin SPAs already deployed in caches keep working until refresh).
    // After one release, drop adminKey from this response.
    let session;
    try { session = adminSessionResponse(); }
    catch (e) { return json(500, { error: 'Admin auth not configured: ' + e.message }); }
    if (!session.adminKey && !session.adminToken) {
      return json(500, { error: 'ADMIN_SECRET / ADMIN_TOKEN_SECRET not configured on server' });
    }
    return json(200, { ok: true, ...session });
  } catch (e) {
    console.error('[passkey-login-verify]', e);
    return json(500, { error: e.message });
  }
};
