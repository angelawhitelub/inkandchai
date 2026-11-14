const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('./first-order');
const endpoint = require('../first-order-offer');

function db(rows, { fail = false } = {}) {
  const seen = [];
  return {
    seen,
    from() {
      let ors = [];
      const api = {
        select() { return api; },
        or(s) { ors = s.split(','); seen.push(s); return api; },
        limit() { return api; },
        then(res) {
          if (fail) return Promise.resolve({ data: null, error: { message: 'boom' } }).then(res);
          const hit = rows.filter((r) => ors.some((o) => {
            const m = o.match(/^(customer_phone|customer_email)\.ilike\.(.*)$/);
            const re = new RegExp('^' + m[2].replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.') + '$', 'i');
            return re.test(String(r[m[1]] || ''));
          }));
          return Promise.resolve({ data: hit, error: null }).then(res);
        },
      };
      return api;
    },
  };
}

const ROWS = [
  { customer_phone: '+91 98765 43210', customer_email: 'old@x.com', status: 'delivered' },
  { customer_phone: '9000000001', customer_email: '', status: 'pending_phonepe' },
  { customer_phone: '9000000002', customer_email: '', status: 'cancelled', cancellation_reason: 'payment_failed' },
  { customer_phone: '9000000003', customer_email: '', status: 'cancelled', cancellation_reason: 'customer_request' },
  { customer_phone: '9111113210', customer_email: '', status: 'delivered' },
];

test('a phone that has ordered before (stored with +91 and spaces) is not new', async () => {
  assert.equal(await F.hasOrderedBefore(db(ROWS), { phone: '9876543210' }), true);
});

test('another number sharing the last four digits is still new', async () => {
  assert.equal(await F.hasOrderedBefore(db(ROWS), { phone: '9222223210' }), false);
});

test('unpaid and failed checkout attempts do not count; a cancelled order does', async () => {
  assert.equal(await F.hasOrderedBefore(db(ROWS), { phone: '9000000001' }), false);
  assert.equal(await F.hasOrderedBefore(db(ROWS), { phone: '9000000002' }), false);
  assert.equal(await F.hasOrderedBefore(db(ROWS), { phone: '9000000003' }), true);
});

test('the same e-mail on a new phone is not new', async () => {
  assert.equal(await F.hasOrderedBefore(db(ROWS), { phone: '9333333333', email: 'OLD@x.com' }), true);
});

test('no phone or a failed lookup means no discount', async () => {
  assert.equal(await F.hasOrderedBefore(db(ROWS), { phone: '123' }), null);
  assert.equal(await F.hasOrderedBefore(db(ROWS, { fail: true }), { phone: '9333333333' }), null);
  assert.deepEqual(await F.firstOrderOffer(db(ROWS, { fail: true }), { phone: '9333333333' }, 1000), { code: '', discount: 0, source: '' });
  assert.equal((await F.firstOrderOffer(undefined, { phone: '9333333333' }, 1000)).discount, 0);
});

test('a new customer gets 5% rounded down', async () => {
  const hit = await F.firstOrderOffer(db(ROWS), { phone: '9333333333' }, 599);
  assert.equal(hit.code, 'FIRST5');
  assert.equal(hit.discount, 29);
  assert.equal(hit.source, 'first_order');
});

test('never stacks: the bigger single discount wins, the chosen one wins a tie', () => {
  const first = { code: 'FIRST5', discount: 50, source: 'first_order' };
  assert.equal(F.better({ code: 'SAVE15', discount: 225 }, first).code, 'SAVE15');
  assert.equal(F.better({ code: 'INKLOVE10', discount: 30 }, first).code, 'FIRST5');
  assert.equal(F.better({ code: 'X', discount: 50 }, first).code, 'X');
  assert.equal(F.better({ code: '', discount: 0 }, first).code, 'FIRST5');
  assert.equal(F.better({ code: 'X', discount: 10 }, { discount: 0 }).code, 'X');
});

test('the checkout endpoint answers eligible only for a new phone, POST only', async () => {
  const post = (body) => endpoint._test.handle({ httpMethod: 'POST', headers: {}, body: JSON.stringify(body) }, { supabase: db(ROWS) });
  assert.equal(JSON.parse((await post({ phone: '9333333333' })).body).eligible, true);
  assert.equal(JSON.parse((await post({ phone: '98765 43210' })).body).eligible, false);
  assert.equal(JSON.parse((await post({ phone: '12' })).body).eligible, false);
  assert.equal((await endpoint._test.handle({ httpMethod: 'GET', headers: {} }, { supabase: db(ROWS) })).statusCode, 405);
});
