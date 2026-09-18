'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

/**
 * Marking one order shipped from the admin panel threw
 * "ReferenceError: order is not defined" — a reference to a variable declared
 * in a SIBLING block, which neither `node --check` nor require() can see
 * because it only runs on the shipped-with-AWB branch.
 *
 * The damage was not the 500. The status UPDATE happens first and had already
 * committed, so the order was left marked shipped with no AWB, no courier, no
 * tracking URL and no customer notified — the exact state that looks fine on a
 * dashboard and strands a customer.
 */

const TARGET = path.join(__dirname, '..', 'update-order-status.js');

const ORDER = {
  id: '11111111-2222-4333-8444-555555555555',
  razorpay_order_id: 'IC-CW-20260916-4M3JP',
  status: 'paid',
  customer_name: 'Puneet Mandrekar',
  customer_email: 'punit.prm1@example.com',
  customer_phone: '9158494945',
  cart_items: [{ title: 'Protocols: An Operating Manual for the Human Body', qty: 1, price: 495 }],
  amount_paise: 49500,
  razorpay_payment_id: 'pay_TcocgelimWKpQ4',
};

/** Chainable Supabase double: every builder method returns itself. */
function supabaseStub(row, writes) {
  const chain = {
    from() { return chain; },
    select() { return chain; },
    eq() { return chain; },
    update(payload) { writes.push(payload); return chain; },
    maybeSingle() { return Promise.resolve({ data: row, error: null }); },
    then(resolve) { resolve({ data: row ? [row] : [], error: null }); },
  };
  return chain;
}

function runHandler(body) {
  const writes = [];
  const sent = { emails: [], whatsapps: [] };
  const inject = (spec, value) => { require.cache[require.resolve(spec)] = { id: spec, filename: spec, loaded: true, exports: value }; };

  const saved = new Map();
  for (const spec of ['@supabase/supabase-js', './whatsapp', './email', './admin-auth', TARGET]) {
    const key = require.resolve(spec);
    saved.set(spec, require.cache[key]);
  }

  inject('@supabase/supabase-js', { createClient: () => supabaseStub(ORDER, writes) });
  inject('./whatsapp', { sendWhatsApp: async (a) => { sent.whatsapps.push(a); return { ok: true }; } });
  inject('./email',    { sendEmail:    async (a) => { sent.emails.push(a);    return { ok: true }; } });
  inject('./admin-auth', { requireAdmin: () => null });
  delete require.cache[require.resolve(TARGET)];

  process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://stub.supabase.co';
  process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'stub-key';

  const { handler } = require(TARGET);
  return handler({ httpMethod: 'POST', headers: {}, body: JSON.stringify(body) })
    .then(res => ({ res, writes, sent }))
    .finally(() => {
      for (const [spec, mod] of saved) {
        const key = require.resolve(spec);
        if (mod) require.cache[key] = mod; else delete require.cache[key];
      }
    });
}

test('marking an order shipped with an AWB does not throw', async () => {
  const { res } = await runHandler({
    id: ORDER.id, status: 'shipped',
    tracking_id: '21025863355912', courier_name: 'Delhivery',
  });
  const body = JSON.parse(res.body || '{}');
  assert.notEqual(res.statusCode, 500, `handler failed: ${body.error}`);
  assert.ok(!/is not defined/.test(String(body.error || '')),
    'a ReferenceError must never reach the admin panel as an error string');
  assert.equal(res.statusCode, 200);
});

test('the AWB, courier and tracking URL are actually written', async () => {
  // The status write lands first, so a crash after it leaves an order marked
  // shipped and untrackable. Assert the tracking write happened too.
  const { writes } = await runHandler({
    id: ORDER.id, status: 'shipped',
    tracking_id: '21025863355912', courier_name: 'Delhivery',
  });
  const tracking = writes.find(w => w && w.tracking_id);
  assert.ok(tracking, 'the tracking columns were never written');
  assert.equal(tracking.tracking_id, '21025863355912');
  assert.equal(tracking.courier_name, 'Delhivery');
  assert.ok(/delhivery\.com\/track-v2\/package\/21025863355912/.test(tracking.tracking_url),
    `tracking_url was ${tracking.tracking_url}`);
  assert.ok(tracking.shipped_at, 'shipped_at was not stamped');
});

test('the customer is emailed and WhatsApped, with four template parameters', async () => {
  const { sent } = await runHandler({
    id: ORDER.id, status: 'shipped',
    tracking_id: '21025863355912', courier_name: 'Delhivery',
  });
  assert.equal(sent.emails.length, 1, 'no shipment email was sent');
  assert.equal(sent.whatsapps.length, 1, 'no shipment WhatsApp was sent');
  const wa = sent.whatsapps[0];
  assert.equal(wa.template, 'order_shipped');
  // order_shipped takes FOUR body variables. Five was rejected 132000 on every
  // one of 49 live sends; the failure is returned, not thrown, so only a
  // count assertion catches a regression here.
  assert.equal(wa.params.length, 4, `order_shipped got ${wa.params.length} params`);
  assert.equal(wa.params[0], 'Puneet');
  assert.equal(wa.params[1], 'Delhivery');
  assert.equal(wa.params[2], '21025863355912');
});
