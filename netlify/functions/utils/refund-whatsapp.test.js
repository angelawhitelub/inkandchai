/**
 * Tests for the refund WhatsApp template chain — reference number + the
 * "View your order" button.
 *
 * The chain exists because templates go live one at a time in Meta: an
 * unapproved template is rejected at send time, and the customer must still get
 * their message. These tests pin the two properties that matter: the BEST
 * template Meta accepts is the one used, and a rejection never costs the
 * customer the notification.
 *
 * The other pinned rule is that no template parameter is ever empty. Meta
 * rejects the whole send on an empty variable, so "no reference available" has
 * to mean a different template, never a blank {{4}}.
 */

const test = require('node:test');
const assert = require('node:assert');
const Module = require('node:module');

// Stub ./whatsapp BEFORE refund-notifications is loaded — it destructures
// sendWhatsApp at require time, so patching the module afterwards is too late.
const waPath = require.resolve('./whatsapp');
const sent = [];
let responder = () => ({ ok: true });
require.cache[waPath] = new Module(waPath, null);
require.cache[waPath].filename = waPath;
require.cache[waPath].loaded = true;
require.cache[waPath].exports = {
  sendWhatsApp: async (opts) => { sent.push(opts); return responder(opts); },
  sendText: async () => ({ ok: true }),
  normalizePhone: (p) => p,
};

const { sendRefundWhatsApp, resolveRefundRef } = require('./refund-notifications');

const ORDER = { customer_name: 'Aman Gupta', customer_phone: '919179861214' };
const BASE = { order: ORDER, oid: 'IC-20260807-NF598', amtPlain: '149' };

function reset(fn = () => ({ ok: true })) { sent.length = 0; responder = fn; }

test('a partial with books and a reference uses refund_partial, with the button', async () => {
  reset();
  await sendRefundWhatsApp({ ...BASE, isPartial: true, itemsLine: 'Spiritual Awakening', refundRef: 'rfnd_ABC123' });

  assert.strictEqual(sent.length, 1, 'the best template was accepted, so nothing else is tried');
  assert.strictEqual(sent[0].template, 'refund_partial');
  assert.deepStrictEqual(sent[0].params,
    ['Aman', 'IC-20260807-NF598', '149', 'Spiritual Awakening', 'rfnd_ABC123']);
  assert.strictEqual(sent[0].urlButtonParam, 'IC-20260807-NF598',
    'the button deep-links to /track/?id=<order>');
});

test('a full refund with a reference uses refund_processed_ref, with the button', async () => {
  reset();
  await sendRefundWhatsApp({ ...BASE, isPartial: false, itemsLine: '', refundRef: 'rfnd_ABC123' });

  assert.strictEqual(sent[0].template, 'refund_processed_ref');
  assert.deepStrictEqual(sent[0].params, ['Aman', 'IC-20260807-NF598', '149', 'rfnd_ABC123']);
  assert.strictEqual(sent[0].urlButtonParam, 'IC-20260807-NF598');
});

test('no reference falls back to the long-approved template, and sends no button param', async () => {
  reset();
  await sendRefundWhatsApp({ ...BASE, isPartial: false, itemsLine: '', refundRef: null });

  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].template, 'refund_processed');
  assert.deepStrictEqual(sent[0].params, ['Aman', 'IC-20260807-NF598', '149']);
  assert.ok(!('urlButtonParam' in sent[0]),
    'refund_processed has no button defined in Meta — sending one would be rejected');
});

test('CRITICAL: no template parameter is ever empty, whatever is missing', async () => {
  for (const args of [
    { isPartial: true,  itemsLine: '',   refundRef: 'rfnd_1' },
    { isPartial: true,  itemsLine: 'x',  refundRef: null },
    { isPartial: false, itemsLine: '',   refundRef: null },
    { isPartial: true,  itemsLine: '',   refundRef: null },
  ]) {
    reset();
    await sendRefundWhatsApp({ ...BASE, ...args });
    for (const call of sent) {
      for (const p of call.params) {
        assert.ok(String(p).trim().length > 0,
          `empty param in ${call.template} — Meta rejects the whole send`);
      }
    }
  }
});

test('an unapproved template falls through to the next one, so the customer still hears', async () => {
  reset(({ template }) => (template === 'refund_partial'
    ? { ok: false, status: 400, data: { error: { message: 'template name does not exist' } } }
    : { ok: true }));

  const res = await sendRefundWhatsApp({
    ...BASE, isPartial: true, itemsLine: 'Spiritual Awakening', refundRef: 'rfnd_ABC123',
  });

  assert.deepStrictEqual(sent.map(s => s.template), ['refund_partial', 'refund_processed_ref']);
  assert.strictEqual(res.ok, true, 'the fallback delivered');
});

test('every template unapproved still ends on refund_processed', async () => {
  reset(({ template }) => (template === 'refund_processed'
    ? { ok: true }
    : { ok: false, status: 400, data: { error: { message: 'does not exist' } } }));

  const res = await sendRefundWhatsApp({
    ...BASE, isPartial: true, itemsLine: 'Spiritual Awakening', refundRef: 'rfnd_ABC123',
  });

  assert.deepStrictEqual(sent.map(s => s.template),
    ['refund_partial', 'refund_processed_ref', 'refund_processed']);
  assert.strictEqual(res.ok, true);
});

test('a missing token stops the chain instead of failing three times', async () => {
  reset(() => ({ ok: false, skipped: true }));
  await sendRefundWhatsApp({ ...BASE, isPartial: true, itemsLine: 'x', refundRef: 'rfnd_1' });
  assert.strictEqual(sent.length, 1, 'no token / bad phone fails every template identically');
});

// ── the reference itself ────────────────────────────────────────────────────
test('resolveRefundRef prefers the reference the caller just got from the gateway', () => {
  assert.strictEqual(
    resolveRefundRef({ phonepe_refund_id: 'PP1', refund_id: 'rfnd_1' }, 'FRESH'), 'FRESH');
  assert.strictEqual(resolveRefundRef({ phonepe_refund_id: 'PP1', refund_id: 'rfnd_1' }), 'PP1');
  assert.strictEqual(resolveRefundRef({ refund_id: 'rfnd_1' }), 'rfnd_1',
    'Razorpay refunds live in refund_id — they were previously ignored');
});

test('resolveRefundRef returns null (never "") when there is no reference', () => {
  for (const o of [{}, { refund_id: '' }, { refund_id: '   ' }, null, undefined]) {
    assert.strictEqual(resolveRefundRef(o, null), null,
      'an empty string would be passed to Meta as a variable and rejected');
  }
});
