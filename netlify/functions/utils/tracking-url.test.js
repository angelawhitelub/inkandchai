'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { buildTrackingUrl } = require('./tracking-url');

const ORDER = 'IC-20260917-N2Q9H';

test('a stored link always wins', () => {
  // Written by whoever actually booked the shipment.
  assert.equal(
    buildTrackingUrl({ stored: 'https://example.com/x', courier: 'Delhivery', awb: '123', orderNumber: ORDER }),
    'https://example.com/x');
});

test('XpressBees uses the shipping-platform link, which deep-links', () => {
  // Verified live with no session: renders order number, status and scans.
  const u = buildTrackingUrl({ courier: 'Xpressbees Surface 0.5 K.G', awb: '143449610518830', orderNumber: ORDER });
  assert.equal(u, 'https://shipmentv2.xpressbees.com/orders/tracking/143449610518830');
});

test('XpressBees never uses the www.xpressbees.com pages', () => {
  // Both drop the AWB, redirect to the root, and sit behind a CAPTCHA.
  const u = buildTrackingUrl({ courier: 'Xpressbees', awb: '143449610518830', orderNumber: ORDER });
  assert.ok(!/www\.xpressbees\.com/.test(u), `got ${u}`);
  assert.ok(!/awbNo=|shipment\/tracking\?awb=/.test(u), `got ${u}`);
});

test('an XpressBees order with no AWB yet falls back to our own page', () => {
  // The platform page takes an AWB only -- our order number returns
  // "Invalid Awb no" -- so there is nothing to deep-link to yet.
  assert.equal(buildTrackingUrl({ courier: 'Xpressbees', awb: '', orderNumber: ORDER }),
    `https://inkandchai.in/track/?id=${ORDER}`);
});

test('an unknown courier never falls back to NimbusPost', () => {
  // The old default. It put a NimbusPost link on shipments NimbusPost never
  // carried, for every order whose courier name was blank or unrecognised.
  const u = buildTrackingUrl({ courier: 'Some New Courier', awb: '999', orderNumber: ORDER });
  assert.ok(!/nimbuspost/.test(u), `got ${u}`);
  assert.equal(u, `https://inkandchai.in/track/?id=${ORDER}`);
});

test('a blank courier never falls back to NimbusPost', () => {
  const u = buildTrackingUrl({ courier: '', awb: '999', orderNumber: ORDER });
  assert.ok(!/nimbuspost/.test(u), `got ${u}`);
});

test('legacy NimbusPost and Ekart shipments keep their working links', () => {
  for (const c of ['NimbusPost', 'nimbus post', 'Ekart Logistics']) {
    assert.match(buildTrackingUrl({ courier: c, awb: 'NP123', orderNumber: ORDER }),
      /ship\.nimbuspost\.com\/shipping\/tracking\/NP123/);
  }
});

test('couriers whose own pages deep-link keep their direct URLs', () => {
  assert.match(buildTrackingUrl({ courier: 'Delhivery Surface', awb: 'D1', orderNumber: ORDER }),
    /delhivery\.com\/track-v2\/package\/D1/);
  assert.match(buildTrackingUrl({ courier: 'Blue Dart', awb: 'B1', orderNumber: ORDER }),
    /bluedart\.com\/tracking\?trackingNumber=B1/);
  assert.match(buildTrackingUrl({ courier: 'Ecom Express', awb: 'E1', orderNumber: ORDER }),
    /ecomexpress\.in\/tracking\/\?awb_field=E1/);
});

test('courier names are matched past spacing and punctuation', () => {
  for (const c of ['blue dart', 'Blue-Dart', 'BLUE_DART', 'bluedart']) {
    assert.match(buildTrackingUrl({ courier: c, awb: 'B1', orderNumber: ORDER }), /bluedart\.com/);
  }
});

test('an order with no AWB still gets a usable link', () => {
  assert.equal(buildTrackingUrl({ courier: '', awb: '', orderNumber: ORDER }),
    `https://inkandchai.in/track/?id=${ORDER}`);
});

test('nothing trackable at all yields an empty string, not a dead link', () => {
  assert.equal(buildTrackingUrl({}), '');
  // An AWB on an UNKNOWN courier, with no order number, is the one case with
  // nothing honest to link to. A NimbusPost link here is what the old code
  // produced, and it was dead for anything NimbusPost did not carry.
  assert.equal(buildTrackingUrl({ courier: 'Some New Courier', awb: '123' }), '');
});

test('an XpressBees AWB deep-links even without an order number', () => {
  assert.equal(buildTrackingUrl({ courier: 'Xpressbees', awb: '143449610518830' }),
    'https://shipmentv2.xpressbees.com/orders/tracking/143449610518830');
});

test('the AWB is URL-encoded', () => {
  assert.match(buildTrackingUrl({ courier: 'Delhivery', awb: 'A B/C', orderNumber: ORDER }), /A%20B%2FC/);
});
