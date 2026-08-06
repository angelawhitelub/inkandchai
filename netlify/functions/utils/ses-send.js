/**
 * Amazon SES v2 sender — signed with SigV4 using node's crypto, no AWS SDK.
 *
 * The SDK would add ~15 MB to every function bundle to do what amounts to four
 * HMACs and a POST, and every other integration in this codebase already talks
 * to its provider over plain fetch. So this signs the request directly.
 *
 * Env:
 *   AWS_SES_ACCESS_KEY_ID
 *   AWS_SES_SECRET_ACCESS_KEY
 *   AWS_SES_REGION            (default ap-south-1 — the Mumbai identity)
 *
 * Deliberately NOT named AWS_ACCESS_KEY_ID: that name is picked up implicitly
 * by AWS tooling, and this key should only ever be able to send email.
 */

const crypto = require('crypto');

const sha256hex = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const hmac = (key, s) => crypto.createHmac('sha256', key).update(s, 'utf8').digest();

/**
 * SigV4-sign a POST and return the headers to send with it.
 * `now` is injectable so the signature is testable.
 */
function signRequest({ accessKeyId, secretAccessKey, region, service, host, path, body, now }) {
  const amzDate = (now || new Date()).toISOString().replace(/[:-]|\.\d{3}/g, '');  // 20260807T044200Z
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256hex(body);

  const headers = {
    'content-type': 'application/json',
    host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  };

  const names = Object.keys(headers).sort();
  const signedHeaders = names.join(';');
  const canonicalHeaders = names.map((k) => `${k}:${String(headers[k]).trim()}\n`).join('');
  const canonicalRequest = ['POST', path, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');

  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonicalRequest)].join('\n');

  let key = hmac(`AWS4${secretAccessKey}`, dateStamp);
  key = hmac(key, region);
  key = hmac(key, service);
  key = hmac(key, 'aws4_request');
  const signature = crypto.createHmac('sha256', key).update(stringToSign, 'utf8').digest('hex');

  return {
    ...headers,
    authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, `
                 + `SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

/** Fold base64 to 76-column lines, as MIME requires. */
const fold = (b64) => String(b64).replace(/(.{76})/g, '$1\r\n');

/**
 * Build a base64 MIME message. Only needed when there are attachments — SES's
 * Simple content shape has no portable attachment field, so those go out as
 * raw multipart/mixed.
 */
function buildRawMime({ from, to, subject, html, attachments }) {
  const boundary = `----=_Part_${crypto.randomBytes(12).toString('hex')}`;
  const lines = [
    `From: ${from}`,
    `To: ${to}`,
    // RFC 2047 — a subject with an emoji or a rupee sign must not go out raw.
    `Subject: =?UTF-8?B?${Buffer.from(String(subject), 'utf8').toString('base64')}?=`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    fold(Buffer.from(String(html || ''), 'utf8').toString('base64')),
  ];
  for (const a of attachments) {
    lines.push(
      `--${boundary}`,
      `Content-Type: ${a.contentType}; name="${a.filename}"`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${a.filename}"`,
      '',
      fold(a.base64),
    );
  }
  lines.push(`--${boundary}--`, '');
  return Buffer.from(lines.join('\r\n'), 'utf8').toString('base64');
}

/**
 * @param {{accessKeyId, secretAccessKey, region}} creds
 * @param {{to, subject, html, from, attachments}} msg  attachments pre-normalised
 *        to [{filename, contentType, base64}]
 * @throws on any non-2xx, so sendEmail falls through to the next provider.
 */
async function sendViaSes(creds, { to, subject, html, from, attachments = [] }) {
  const region = creds.region || 'ap-south-1';
  const host = `email.${region}.amazonaws.com`;
  const path = '/v2/email/outbound-emails';

  const payload = attachments.length
    ? {
      FromEmailAddress: from,
      Destination: { ToAddresses: [to] },
      Content: { Raw: { Data: buildRawMime({ from, to, subject, html, attachments }) } },
    }
    : {
      FromEmailAddress: from,
      Destination: { ToAddresses: [to] },
      Content: {
        Simple: {
          Subject: { Data: String(subject), Charset: 'UTF-8' },
          Body: { Html: { Data: String(html || ''), Charset: 'UTF-8' } },
        },
      },
    };

  const body = JSON.stringify(payload);
  const headers = signRequest({
    accessKeyId: creds.accessKeyId,
    secretAccessKey: creds.secretAccessKey,
    region,
    service: 'ses',
    host,
    path,
    body,
  });

  const res = await fetch(`https://${host}${path}`, { method: 'POST', headers, body });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`SES ${res.status}: ${data?.message || data?.Message || JSON.stringify(data)}`);
  }
  console.log('Email sent via SES:', data?.MessageId, '→', to);
}

module.exports = { sendViaSes, signRequest, buildRawMime };
