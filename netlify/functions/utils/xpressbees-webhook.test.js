'use strict';
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { verify, safeEqual, header } = require('../xpressbees-webhook').__test;

const BODY = JSON.stringify({ awb_number: '4152912381315', status: 'in transit', event_time: '2021-02-26 16:19:59', location: 'Delhi', message: 'Reached at nearest hub', rto_awb: '' });
const sign = (body, secret) => crypto.createHmac('sha256', secret).update(body, 'utf8').digest('base64');

function withSecret(secret, fn) {
  const had = process.env.XPRESSBEES_WEBHOOK_SECRET;
  if (secret === null) delete process.env.XPRESSBEES_WEBHOOK_SECRET;
  else process.env.XPRESSBEES_WEBHOOK_SECRET = secret;
  try { return fn(); }
  finally {
    if (had === undefined) delete process.env.XPRESSBEES_WEBHOOK_SECRET;
    else process.env.XPRESSBEES_WEBHOOK_SECRET = had;
  }
}

test('a correctly signed event is accepted', () => {
  withSecret('s3cr3t', () => {
    const ev = { headers: { 'X-Hmac-SHA256': sign(BODY, 's3cr3t') } };
    assert.deepEqual(verify(ev, BODY), { okToProcess: true });
  });
});

test('the header is matched whatever case they send it in', () => {
  withSecret('s3cr3t', () => {
    for (const name of ['x-hmac-sha256', 'X-HMAC-SHA256', 'X-Hmac-Sha256']) {
      const ev = { headers: { [name]: sign(BODY, 's3cr3t') } };
      assert.equal(verify(ev, BODY).okToProcess, true, name);
    }
  });
});

test('a wrong secret, a tampered body and a missing header are all refused', () => {
  withSecret('s3cr3t', () => {
    assert.equal(verify({ headers: { 'x-hmac-sha256': sign(BODY, 'wrong') } }, BODY).okToProcess, false);
    // Signature computed over the real body, delivered with a doctored one:
    // this endpoint can mark an order delivered, which opens the return
    // window, so the body itself has to be what was signed.
    const tampered = BODY.replace('in transit', 'delivered');
    assert.equal(verify({ headers: { 'x-hmac-sha256': sign(BODY, 's3cr3t') } }, tampered).okToProcess, false);
    assert.equal(verify({ headers: {} }, BODY).okToProcess, false);
  });
});

test('an unset secret accepts but says so, rather than burning their 100 lives', () => {
  withSecret(null, () => {
    const v = verify({ headers: {} }, BODY);
    assert.equal(v.okToProcess, true);
    assert.match(v.note, /not set/);
    assert.match(v.note, /UNVERIFIED/);
  });
});

test('safeEqual handles unequal lengths without throwing', () => {
  assert.equal(safeEqual('abc', 'abcdef'), false);
  assert.equal(safeEqual('', ''), true);
  assert.equal(safeEqual('abc', 'abc'), true);
});

test('header() returns empty rather than undefined for an absent header', () => {
  assert.equal(header({ headers: {} }, 'x-hmac-sha256'), '');
  assert.equal(header({}, 'x-hmac-sha256'), '');
});
