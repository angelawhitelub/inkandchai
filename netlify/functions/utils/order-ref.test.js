const test = require('node:test');
const assert = require('node:assert/strict');
const { parseOrderRef, findOrderByRef, shortCode } = require('./order-ref');

test('reads the ways customers type an order id', () => {
  assert.deepEqual(parseOrderRef('IC-20261109-AB3CD'), { kind: 'datecode', date: '20261109', code: 'AB3CD' });
  assert.deepEqual(parseOrderRef(' ic- 20261109 - ab3cd '), { kind: 'datecode', date: '20261109', code: 'AB3CD' });
  assert.deepEqual(parseOrderRef('IC20261109AB3CD'), { kind: 'datecode', date: '20261109', code: 'AB3CD' });
  assert.deepEqual(parseOrderRef('20261109AB3CD'), { kind: 'datecode', date: '20261109', code: 'AB3CD' });
  assert.deepEqual(parseOrderRef('20261109_AB3CD'), { kind: 'datecode', date: '20261109', code: 'AB3CD' });
  assert.deepEqual(parseOrderRef('ab3cd'), { kind: 'code', code: 'AB3CD' });
  assert.deepEqual(parseOrderRef('#AB3CD'), { kind: 'code', code: 'AB3CD' });
  assert.deepEqual(parseOrderRef('20261109'), { kind: 'date', date: '20261109' });
  assert.deepEqual(parseOrderRef('IC-W-20261109-AB3CD'), { kind: 'exact', id: 'IC-W-20261109-AB3CD' });
  assert.deepEqual(parseOrderRef('ic-20261109-ab3cd-s2'), { kind: 'exact', id: 'IC-20261109-AB3CD-S2' });
  assert.deepEqual(parseOrderRef('order_SsW3Rzrk7HkHdT'), { kind: 'exact', id: 'order_SsW3Rzrk7HkHdT' });
  assert.deepEqual(parseOrderRef('   '), { kind: 'empty' });
});

test('short code of a full id', () => {
  assert.equal(shortCode('IC-20261109-AB3CD'), 'AB3CD');
  assert.equal(shortCode('IC-W-20261109-AB3CD'), 'AB3CD');
  assert.equal(shortCode('IC-20261109-AB3CD-S2'), 'AB3CD');
  assert.equal(shortCode('order_x'), '');
});

function db(rows) {
  const asRe = (v) => new RegExp('^' + String(v).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.') + '$', 'i');
  return {
    calls: [],
    from() {
      const f = [];
      let one = false;
      const self = this;
      const api = {
        select() { return api; },
        eq(c, v) { f.push((r) => r[c] === v); return api; },
        ilike(c, v) { self.calls.push(v); const re = asRe(v); f.push((r) => re.test(r[c])); return api; },
        order() { return api; },
        limit() { return api; },
        maybeSingle() { one = true; return api; },
        then(res) {
          const hit = rows.filter((r) => f.every((fn) => fn(r)));
          return Promise.resolve(one ? { data: hit[0] || null, error: null } : { data: hit, error: null }).then(res);
        },
      };
      return api;
    },
  };
}

const ROWS = [
  { razorpay_order_id: 'IC-20261109-AB3CD', customer_phone: '+91 98765 43210' },
  { razorpay_order_id: 'IC-20261110-AB3CD', customer_phone: '9000000000' },
  { razorpay_order_id: 'IC-20261109-AB3CD-S2', customer_phone: '+91 98765 43210' },
  { razorpay_order_id: 'IC-W-20261111-QQ7PX', customer_phone: '9876543210' },
];
const phoneIs = (p) => (o) => String(o.customer_phone).replace(/\D/g, '').slice(-10) === p;

test('the short code finds only the order the phone owns', async () => {
  const a = await findOrderByRef(db(ROWS), 'ab3cd', phoneIs('9876543210'));
  assert.equal(a.order.razorpay_order_id, 'IC-20261109-AB3CD');
  const b = await findOrderByRef(db(ROWS), 'AB3CD', phoneIs('9000000000'));
  assert.equal(b.order.razorpay_order_id, 'IC-20261110-AB3CD');
  assert.deepEqual(await findOrderByRef(db(ROWS), 'AB3CD', phoneIs('9111111111')), {});
});

test('a full id typed any way finds a bot order too', async () => {
  const r = await findOrderByRef(db(ROWS), '20261111qq7px', phoneIs('9876543210'));
  assert.equal(r.order.razorpay_order_id, 'IC-W-20261111-QQ7PX');
});

test('an exact id still reports a contact mismatch to the caller', async () => {
  const r = await findOrderByRef(db(ROWS), 'IC-20261109-AB3CD-S2', phoneIs('9111111111'));
  assert.equal(r.order.razorpay_order_id, 'IC-20261109-AB3CD-S2');
  assert.equal(r.owned, false);
});

test('the date alone gets a hint, not a lookup', async () => {
  const d = db(ROWS);
  const r = await findOrderByRef(d, '20261109', phoneIs('9876543210'));
  assert.match(r.hint, /order date/);
  assert.equal(d.calls.length, 0);
});
