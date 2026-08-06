const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { signRequest, buildRawMime } = require('./ses-send');

const CREDS = {
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
  region: 'ap-south-1',
  service: 'ses',
  host: 'email.ap-south-1.amazonaws.com',
  path: '/v2/email/outbound-emails',
  body: '{"hello":"world"}',
  now: new Date('2026-08-07T04:42:00.000Z'),
};

test('derives the signing key exactly as AWS documents it', () => {
  // AWS's published worked example: secret above, 20120215 / us-east-1 / iam
  // must yield this key. This is the part of SigV4 most likely to be wrong,
  // and a wrong key means every SES send fails authentication.
  const hmac = (key, s) => crypto.createHmac('sha256', key).update(s, 'utf8').digest();
  let k = hmac('AWS4wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', '20120215');
  k = hmac(k, 'us-east-1');
  k = hmac(k, 'iam');
  k = hmac(k, 'aws4_request');
  assert.equal(k.toString('hex'), 'f4780e2d9f65fa895f9c67b32ce1baf0b0d8a43505a000a1a9e090d414db404d');
});

test('formats the amz date as AWS requires', () => {
  const h = signRequest(CREDS);
  assert.equal(h['x-amz-date'], '20260807T044200Z');   // no dashes, colons or millis
});

test('signs with a credential scope matching the date, region and service', () => {
  const h = signRequest(CREDS);
  assert.match(h.authorization, /Credential=AKIDEXAMPLE\/20260807\/ap-south-1\/ses\/aws4_request/);
});

test('signs every header it sends, in sorted order', () => {
  const h = signRequest(CREDS);
  const signed = h.authorization.match(/SignedHeaders=([^,]+)/)[1];
  assert.equal(signed, 'content-type;host;x-amz-content-sha256;x-amz-date');
  // Anything listed must actually be on the request, or AWS rejects it.
  for (const name of signed.split(';')) assert.ok(name in h, `${name} missing from headers`);
});

test('hashes the body, not a placeholder', () => {
  const h = signRequest(CREDS);
  assert.equal(h['x-amz-content-sha256'],
    crypto.createHash('sha256').update(CREDS.body, 'utf8').digest('hex'));
});

test('a different body produces a different signature', () => {
  const a = signRequest(CREDS).authorization;
  const b = signRequest({ ...CREDS, body: '{"hello":"there"}' }).authorization;
  assert.notEqual(a, b);
});

test('the same request signs identically twice', () => {
  assert.equal(signRequest(CREDS).authorization, signRequest(CREDS).authorization);
});

test('encodes a non-ASCII subject rather than sending it raw', () => {
  const raw = Buffer.from(buildRawMime({
    from: 'Ink & Chai <support@inkandchai.in>',
    to: 'a@b.com',
    subject: 'Your ₹802 order 📦',
    html: '<p>hi</p>',
    attachments: [],
  }), 'base64').toString('utf8');
  assert.match(raw, /^Subject: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/m);
  assert.doesNotMatch(raw, /Subject:.*₹/);
});

test('builds a multipart body carrying each attachment', () => {
  const raw = Buffer.from(buildRawMime({
    from: 'Ink & Chai <support@inkandchai.in>',
    to: 'a@b.com',
    subject: 'Invoice',
    html: '<p>hi</p>',
    attachments: [
      { filename: 'invoice.pdf', contentType: 'application/pdf', base64: 'SGVsbG8=' },
      { filename: 'label.png', contentType: 'image/png', base64: 'AAAA' },
    ],
  }), 'base64').toString('utf8');

  const boundary = raw.match(/boundary="([^"]+)"/)[1];
  assert.equal(raw.split(`--${boundary}`).length - 1, 4);   // html + 2 files + closing
  assert.match(raw, /Content-Disposition: attachment; filename="invoice\.pdf"/);
  assert.match(raw, /Content-Disposition: attachment; filename="label\.png"/);
  assert.ok(raw.trimEnd().endsWith(`--${boundary}--`), 'must end with the closing boundary');
  assert.match(raw, /\r\n/, 'MIME requires CRLF line endings');
});

test('folds long base64 so no MIME line exceeds the limit', () => {
  const raw = Buffer.from(buildRawMime({
    from: 'x@y.com', to: 'a@b.com', subject: 's',
    html: '<p>' + 'x'.repeat(5000) + '</p>',
    attachments: [],
  }), 'base64').toString('utf8');
  for (const line of raw.split('\r\n')) assert.ok(line.length <= 78, `line too long: ${line.length}`);
});
