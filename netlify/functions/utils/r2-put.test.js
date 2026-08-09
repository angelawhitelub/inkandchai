const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { signAwsV4, encodeKey, r2Configured, r2Config } = require('./r2-put');

// ── Signature correctness ───────────────────────────────────────────────────
// A wrong signature fails with an opaque 403 that says nothing about which part
// was wrong, so it is pinned against AWS's own published test vector rather
// than against itself. This is the "get-vanilla" case from the AWS SigV4 test
// suite: if this passes, the canonical request, the string to sign, the scope
// and the key derivation are all exactly right.
test('reproduces the AWS get-vanilla test vector exactly', () => {
  const auth = signAwsV4({
    method: 'GET',
    path: '/',
    query: '',
    headers: { Host: 'example.amazonaws.com', 'X-Amz-Date': '20150830T123600Z' },
    payload: '',
    accessKeyId: 'AKIDEXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
    region: 'us-east-1',
    service: 'service',
  });
  assert.equal(auth,
    'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, '
    + 'SignedHeaders=host;x-amz-date, '
    + 'Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31');
});

test('lower-cases and sorts header names before signing', () => {
  // AWS requires canonical headers sorted by lower-cased name. Feeding the same
  // headers in a different order and case must not change the signature.
  const base = {
    payload: '', accessKeyId: 'AKIDEXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
    region: 'us-east-1', service: 'service', method: 'GET', path: '/', query: '',
  };
  const a = signAwsV4({ ...base, headers: { Host: 'example.amazonaws.com', 'X-Amz-Date': '20150830T123600Z' } });
  const b = signAwsV4({ ...base, headers: { 'x-amz-date': '20150830T123600Z', HOST: 'example.amazonaws.com' } });
  assert.equal(a, b);
  assert.match(a, /SignedHeaders=host;x-amz-date/);
});

test('signs a binary payload by its own hash, not a placeholder', () => {
  const body = Buffer.from([0, 1, 2, 253, 254, 255]);
  const headers = {
    host: 'acct.r2.cloudflarestorage.com',
    'content-type': 'video/mp4',
    'x-amz-content-sha256': crypto.createHash('sha256').update(body).digest('hex'),
    'x-amz-date': '20260808T101500Z',
  };
  const auth = signAwsV4({
    method: 'PUT', path: '/bucket/videos/a.mp4', headers, payload: body,
    accessKeyId: 'AK', secretAccessKey: 'SK', region: 'auto', service: 's3',
  });
  // Flipping one byte must change the signature, or the body isn't really covered.
  const other = Buffer.from([0, 1, 2, 253, 254, 0]);
  const auth2 = signAwsV4({
    method: 'PUT', path: '/bucket/videos/a.mp4', payload: other,
    headers: { ...headers, 'x-amz-content-sha256': crypto.createHash('sha256').update(other).digest('hex') },
    accessKeyId: 'AK', secretAccessKey: 'SK', region: 'auto', service: 's3',
  });
  assert.notEqual(auth, auth2);
});

test('a different method over the same object signs differently', () => {
  const args = {
    path: '/bucket/k', headers: { host: 'h', 'x-amz-date': '20260808T101500Z' },
    payload: '', accessKeyId: 'AK', secretAccessKey: 'SK', region: 'auto', service: 's3',
  };
  assert.notEqual(signAwsV4({ ...args, method: 'PUT' }), signAwsV4({ ...args, method: 'GET' }));
});

test('uses the R2 region and service in the credential scope', () => {
  const auth = signAwsV4({
    method: 'PUT', path: '/b/k', headers: { host: 'h', 'x-amz-date': '20260808T101500Z' },
    payload: '', accessKeyId: 'AKID', secretAccessKey: 'SK', region: 'auto', service: 's3',
  });
  assert.match(auth, /Credential=AKID\/20260808\/auto\/s3\/aws4_request/);
});

// ── Key encoding ────────────────────────────────────────────────────────────
test('leaves an ordinary video key untouched', () => {
  // Keys come from safeSlug, so this is the real-world case and it must not be
  // mangled — the public URL has to match the key byte for byte.
  assert.equal(encodeKey('videos/atomic-habits-video-1786-a1b2.mp4'),
    'videos/atomic-habits-video-1786-a1b2.mp4');
});

test('keeps path separators but encodes spaces and unsafe characters', () => {
  assert.equal(encodeKey('videos/my clip.mp4'), 'videos/my%20clip.mp4');
  assert.equal(encodeKey("videos/it's (1).mp4"), 'videos/it%27s%20%281%29.mp4');
});

test('does not encode RFC 3986 unreserved characters', () => {
  assert.equal(encodeKey('videos/a-b_c.d~e.mp4'), 'videos/a-b_c.d~e.mp4');
});

// ── Configuration gate ──────────────────────────────────────────────────────
const FULL = {
  R2_ACCOUNT_ID: 'acct', R2_ACCESS_KEY_ID: 'ak', R2_SECRET_ACCESS_KEY: 'sk',
  R2_PUBLIC_BASE: 'https://pub-abc.r2.dev',
};

test('reports configured only when writing AND reading are both possible', () => {
  assert.equal(r2Configured(FULL), true);
  // Keys without a public base would upload to a URL nobody can read.
  const { R2_PUBLIC_BASE, ...noBase } = FULL;
  assert.equal(r2Configured(noBase), false);
  for (const key of ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY']) {
    const partial = { ...FULL };
    delete partial[key];
    assert.equal(r2Configured(partial), false, `${key} missing must not count as configured`);
  }
  assert.equal(r2Configured({}), false);
});

test('accepts IMAGE_CDN_BASE as the public origin', () => {
  const { R2_PUBLIC_BASE, ...rest } = FULL;
  assert.equal(r2Configured({ ...rest, IMAGE_CDN_BASE: 'https://img.inkandchai.in' }), true);
});

test('strips a trailing slash so URLs never double up', () => {
  const cfg = r2Config({ ...FULL, R2_PUBLIC_BASE: 'https://pub-abc.r2.dev/' });
  assert.equal(cfg.publicBase, 'https://pub-abc.r2.dev');
});

test('defaults to the bucket the covers already use', () => {
  assert.equal(r2Config(FULL).bucket, 'inkandchai-images');
  assert.equal(r2Config({ ...FULL, R2_BUCKET: 'other' }).bucket, 'other');
});

// ── presigned PUT (direct browser upload) ────────────────────────────────────
// Added when book videos stayed blurry: the base64-through-a-function route
// capped a 20 s clip near 1.3 Mbps, so the original file could never be kept.
const { r2PresignPut } = require('./r2-put');

const PRESIGN_CFG = {
  accountId: 'acct123', accessKeyId: 'AKIATEST', secretAccessKey: 'secret',
  bucket: 'inkandchai-images', publicBase: 'https://pub-test.r2.dev',
};

test('presign returns an upload URL and the matching public URL', () => {
  const { uploadUrl, publicUrl } = r2PresignPut(PRESIGN_CFG, { key: 'videos/a b.mp4', contentType: 'video/mp4' });
  assert.match(uploadUrl, /^https:\/\/acct123\.r2\.cloudflarestorage\.com\/inkandchai-images\/videos\/a%20b\.mp4\?/);
  assert.strictEqual(publicUrl, 'https://pub-test.r2.dev/videos/a%20b.mp4');
});

test('presign signs content-type;host and nothing else', () => {
  // The browser sends only Content-Type; any other signed header would 403.
  const { uploadUrl } = r2PresignPut(PRESIGN_CFG, { key: 'v.mp4', contentType: 'video/mp4' });
  const q = new URL(uploadUrl).searchParams;
  assert.strictEqual(q.get('X-Amz-SignedHeaders'), 'content-type;host');
  assert.strictEqual(q.get('X-Amz-Algorithm'), 'AWS4-HMAC-SHA256');
  assert.match(q.get('X-Amz-Credential'), /^AKIATEST\/\d{8}\/auto\/s3\/aws4_request$/);
  assert.match(q.get('X-Amz-Signature'), /^[0-9a-f]{64}$/);
});

test('the secret never appears in the URL', () => {
  const { uploadUrl } = r2PresignPut(PRESIGN_CFG, { key: 'v.mp4', contentType: 'video/mp4' });
  assert.ok(!uploadUrl.includes('secret'), 'secret key leaked into the presigned URL');
});

test('a different content-type produces a different signature', () => {
  const a = r2PresignPut(PRESIGN_CFG, { key: 'v.mp4', contentType: 'video/mp4' }).uploadUrl;
  const b = r2PresignPut(PRESIGN_CFG, { key: 'v.mp4', contentType: 'image/webp' }).uploadUrl;
  const sig = (u) => new URL(u).searchParams.get('X-Amz-Signature');
  assert.notStrictEqual(sig(a), sig(b), 'content-type must be covered by the signature');
});

test('expiry is clamped to a sane window', () => {
  const exp = (n) => new URL(r2PresignPut(PRESIGN_CFG, { key: 'v.mp4', contentType: 'video/mp4', expiresIn: n }).uploadUrl).searchParams.get('X-Amz-Expires');
  assert.strictEqual(exp(5), '60');
  assert.strictEqual(exp(999999), '3600');
  assert.strictEqual(exp(600), '600');
});

test('presign refuses to run without credentials or a public base', () => {
  assert.throws(() => r2PresignPut({ ...PRESIGN_CFG, accessKeyId: '' }, { key: 'v.mp4', contentType: 'video/mp4' }), /credentials/i);
  assert.throws(() => r2PresignPut({ ...PRESIGN_CFG, publicBase: '' }, { key: 'v.mp4', contentType: 'video/mp4' }), /R2_PUBLIC_BASE/);
});
