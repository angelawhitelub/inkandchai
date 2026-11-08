const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { verdict } = require('../../netlify/functions/admin-xb-serviceability')._test;
const root = path.resolve(__dirname, '../..');

test('only an XpressBees "not serviceable" answer counts as unserviceable', () => {
  assert.equal(verdict([{ id: 1 }], null).serviceable, true);
  assert.equal(verdict([], null).serviceable, false);
  assert.equal(verdict(null, new Error('XpressBees serviceability failed for 795001: Pincode not serviceable')).serviceable, false);
  // A network or sign-in failure is "unknown", never a reason to move an order.
  assert.equal(verdict(null, new Error('fetch failed')).serviceable, null);
  assert.equal(verdict(null, new Error('XpressBees login failed')).serviceable, null);
});

test('the NimbusPost push lets a named XB-unserviceable order past only the XpressBees-queue guard', () => {
  const src = fs.readFileSync(path.join(root, 'netlify/functions/nimbuspost-order-push.js'), 'utf8');
  assert.match(src, /elsewhere === 'already queued for XpressBees'\s*&& body\.xb_unserviceable === true && !body\.all_unshipped/);
});
