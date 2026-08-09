/**
 * Cloudflare R2 object upload — S3-compatible PUT signed with SigV4 using node's
 * crypto, no AWS SDK.
 *
 * WHY R2
 *   Cloudflare charges ZERO egress. A product video played a few thousand times
 *   costs nothing, whereas the same file on Supabase Storage eats the 5 GB/month
 *   cached-egress cap and on Netlify is billed bandwidth. Covers already live
 *   here (scripts/upload-images-r2.mjs) — same bucket, same public origin.
 *
 * WHY NOT @aws-sdk/client-s3
 *   It is a devDependency, so it is not installed in the functions runtime, and
 *   pulling it in would add ~15 MB to every bundle to do what amounts to four
 *   HMACs and a PUT. ses-send.js signs SES the same way for the same reason.
 *
 * Env (all four required, else the caller should fall back):
 *   R2_ACCOUNT_ID
 *   R2_ACCESS_KEY_ID
 *   R2_SECRET_ACCESS_KEY
 *   R2_PUBLIC_BASE        public origin for reads, e.g. https://pub-….r2.dev
 *                         (IMAGE_CDN_BASE is accepted as an alias — same origin)
 *   R2_BUCKET             optional, defaults to inkandchai-images
 */

const crypto = require('crypto');

const sha256hex = (data) => crypto.createHash('sha256').update(data).digest('hex');
const hmac = (key, s) => crypto.createHmac('sha256', key).update(s, 'utf8').digest();

/**
 * Generic SigV4 signer. Headers are entirely caller-supplied — the signature
 * covers exactly what is passed and nothing is added behind the caller's back,
 * because a signed header that isn't sent (or vice versa) fails with an opaque
 * 403. `host` must be among them.
 *
 * @returns {string} the Authorization header value
 */
function signAwsV4({ method, path, query = '', headers, payload = '',
  accessKeyId, secretAccessKey, region, service, now }) {
  // Lower-case the header map BEFORE reading anything out of it. Header names
  // are case-insensitive, so a caller passing "X-Amz-Date" must be found — miss
  // it and the credential scope silently gets today's date instead of the
  // request's, which fails as an unexplained 403.
  const lower = {};
  for (const k of Object.keys(headers)) lower[k.toLowerCase()] = headers[k];
  const names = Object.keys(lower).sort();

  const amzDate = String(lower['x-amz-date'] || '')
    || (now || new Date()).toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = lower['x-amz-content-sha256'] || sha256hex(payload);

  // Canonical headers: lower-cased names, sorted, values trimmed.
  const signedHeaders = names.join(';');
  const canonicalHeaders = names.map(k => `${k}:${String(lower[k]).trim()}\n`).join('');

  const canonicalRequest = [method, path, query, canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonicalRequest)].join('\n');

  let key = hmac(`AWS4${secretAccessKey}`, dateStamp);
  key = hmac(key, region);
  key = hmac(key, service);
  key = hmac(key, 'aws4_request');
  const signature = crypto.createHmac('sha256', key).update(stringToSign, 'utf8').digest('hex');

  return `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, `
       + `SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

/**
 * Percent-encode an object key for the canonical URI. S3 encodes each path
 * segment but leaves the separators, and leaves RFC 3986 unreserved characters
 * alone — encodeURIComponent over-encodes ! * ' ( ) so those are put back.
 */
function encodeKey(key) {
  return String(key).split('/').map(segment =>
    encodeURIComponent(segment).replace(/[!'()*]/g, c =>
      `%${c.charCodeAt(0).toString(16).toUpperCase()}`)).join('/');
}

/** True only when every variable needed to both write and read is present. */
function r2Configured(env = process.env) {
  return Boolean(env.R2_ACCOUNT_ID && env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY
    && (env.R2_PUBLIC_BASE || env.IMAGE_CDN_BASE));
}

function r2Config(env = process.env) {
  return {
    accountId: env.R2_ACCOUNT_ID,
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    bucket: env.R2_BUCKET || 'inkandchai-images',
    publicBase: String(env.R2_PUBLIC_BASE || env.IMAGE_CDN_BASE || '').replace(/\/+$/, ''),
  };
}

/**
 * PUT one object and return its public URL.
 * @throws on any non-2xx, so the caller can fall back or report.
 */
async function r2PutObject(config, { key, body, contentType }) {
  const { accountId, accessKeyId, secretAccessKey, bucket, publicBase } = config;
  if (!accountId || !accessKeyId || !secretAccessKey) throw new Error('R2 credentials are not configured');
  if (!publicBase) throw new Error('R2_PUBLIC_BASE (or IMAGE_CDN_BASE) is not set — uploads would have no readable URL');

  const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const host = `${accountId}.r2.cloudflarestorage.com`;
  // Path-style addressing: R2 supports it and it avoids a bucket name with dots
  // breaking TLS on the virtual-host form.
  const path = `/${bucket}/${encodeKey(key)}`;
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');

  // Content-Length is deliberately NOT signed: fetch sets it itself, and a
  // mismatch between the signed and sent value fails as an opaque 403.
  const headers = {
    host,
    'content-type': contentType || 'application/octet-stream',
    'x-amz-content-sha256': sha256hex(buffer),
    'x-amz-date': amzDate,
  };

  headers.authorization = signAwsV4({
    method: 'PUT',
    path,
    headers: { ...headers },   // sign before authorization is added to the set
    payload: buffer,
    accessKeyId,
    secretAccessKey,
    region: 'auto',            // R2 is region-less; 'auto' is what it expects
    service: 's3',
  });

  const res = await fetch(`https://${host}${path}`, { method: 'PUT', headers, body: buffer });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`R2 ${res.status}: ${detail.slice(0, 300) || res.statusText}`);
  }
  return `${publicBase}/${encodeKey(key)}`;
}

/**
 * A presigned PUT URL the BROWSER can upload to directly.
 *
 * Why this exists: a clip posted through a Netlify function is base64 in the
 * request body, which inflates it by a third against a 6 MB limit — about
 * 3.2 MB of video, or ~1.3 Mbps for a 20 s clip. That is not enough bitrate for
 * printed text, so book videos came out blurry however the encoder was tuned.
 * Uploading straight to R2 removes the ceiling entirely, which lets the ORIGINAL
 * phone file be stored with no re-encode and no generation loss at all.
 *
 * Credentials never reach the browser: this signs a URL that is only good for
 * one key, one method, and a few minutes.
 */
function r2PresignPut(config, { key, contentType, expiresIn = 600 }) {
  const { accountId, accessKeyId, secretAccessKey, bucket, publicBase } = config;
  if (!accountId || !accessKeyId || !secretAccessKey) throw new Error('R2 credentials are not configured');
  if (!publicBase) throw new Error('R2_PUBLIC_BASE (or IMAGE_CDN_BASE) is not set — uploads would have no readable URL');

  const host = `${accountId}.r2.cloudflarestorage.com`;
  const path = `/${bucket}/${encodeKey(key)}`;
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/auto/s3/aws4_request`;

  // Query-string signing, not a header: the browser cannot attach an
  // Authorization header to a cross-origin PUT without a second preflight.
  // Content-Type is the only signed header, so the browser must send exactly it.
  //
  // The canonical request is built here rather than through signAwsV4, which
  // derives SignedHeaders from whatever headers it is handed — that would
  // disagree with the content-type;host promised in the query string and fail
  // as an opaque 403.
  const ct = contentType || 'application/octet-stream';
  const query = [
    ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
    ['X-Amz-Credential', `${accessKeyId}/${scope}`],
    ['X-Amz-Date', amzDate],
    ['X-Amz-Expires', String(Math.max(60, Math.min(3600, expiresIn)))],
    ['X-Amz-SignedHeaders', 'content-type;host'],
  ].map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).sort().join('&');

  const canonicalRequest = [
    'PUT',
    path,
    query,
    `content-type:${ct}\nhost:${host}\n`,
    'content-type;host',
    'UNSIGNED-PAYLOAD',
  ].join('\n');

  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonicalRequest)].join('\n');
  let signingKey = hmac(`AWS4${secretAccessKey}`, dateStamp);
  for (const part of ['auto', 's3', 'aws4_request']) signingKey = hmac(signingKey, part);
  const signature = crypto.createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');

  return {
    uploadUrl: `https://${host}${path}?${query}&X-Amz-Signature=${signature}`,
    publicUrl: `${publicBase}/${encodeKey(key)}`,
  };
}

module.exports = { r2PutObject, r2PresignPut, r2Configured, r2Config, signAwsV4, encodeKey };
