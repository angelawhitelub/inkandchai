'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { runReturnPickup, INDIA_POST, customerEmailHtml } = require('../auto-return-pickup-background');

function ret(over = {}) {
  return { id: 'r1', order_display_id: 'IC-20260930-ABCDE', status: 'approved', awb: null, courier_name: null,
    customer_name: 'Asha Rao', customer_phone: '9876543210', customer_email: 'a@example.com', ...over };
}

/** return_requests with select/eq/is/or/update — enough for the job. */
function fakeSupabase(row) {
  const state = { row: row && { ...row }, updates: [] };
  function builder() {
    const q = { op: 'select', filters: [], payload: null, or: null };
    const match = (r) => r && q.filters.every(([c, k, v]) => k === 'eq' ? r[c] === v : (r[c] ?? null) === v)
      && (!q.or || r.courier_name == null || r.courier_name !== INDIA_POST);
    const run = () => {
      if (q.op === 'update') {
        const hit = match(state.row);
        if (hit) Object.assign(state.row, q.payload);
        state.updates.push(q.payload);
        return { data: hit ? [{ id: state.row.id }] : [], error: null };
      }
      return { data: match(state.row) ? { ...state.row } : null, error: null };
    };
    const api = {
      select() { return api; },
      eq(c, v) { q.filters.push([c, 'eq', v]); return api; },
      is(c, v) { q.filters.push([c, 'is', v]); return api; },
      or(expr) { q.or = expr; return api; },
      update(p) { q.op = 'update'; q.payload = p; return api; },
      maybeSingle() { return api; },
      then(res, rej) { return Promise.resolve(run()).then(res, rej); },
    };
    return api;
  }
  return { from: builder, state };
}

const booked = (awb) => ({ statusCode: 200, data: { success: true, pushed: true, awb } });
const refused = (why) => ({ statusCode: 200, data: { success: true, pushed: false, np_error: why } });

function spyProcess(replies, onCall) {
  const calls = [];
  const fn = async (body) => { calls.push(body); if (onCall) onCall(body); return replies[calls.length - 1]; };
  fn.calls = calls;
  return fn;
}
function spy() { const calls = []; const fn = async (...a) => { calls.push(a); return { email: { ok: true }, whatsapp: { ok: true } }; }; fn.calls = calls; return fn; }
const ADDR = { line: 'Ink and Chai, 2969 …, Delhi 110006. Phone 9625836117', name: 'Ink and Chai', address: '2969', city: 'Delhi', state: 'Delhi', pincode: '110006', phone: '9625836117' };

test('XpressBees is tried first and a booking there ends it', async () => {
  const processReturn = spyProcess([booked('14345XB')]);
  const notify = spy(), alert = spy();
  const out = await runReturnPickup({ supabase: fakeSupabase(ret()), processReturn, notifyCustomer: notify, alertOwner: alert, address: ADDR }, 'r1');
  assert.equal(out.outcome, 'xpressbees');
  assert.deepEqual(processReturn.calls, [{ return_request_id: 'r1', action: 'xpressbees' }]);
  assert.equal(notify.calls.length, 0);
});

test('NimbusPost is tried when XpressBees refuses', async () => {
  const processReturn = spyProcess([refused('pincode not serviceable'), booked('2364NP')]);
  const notify = spy();
  const out = await runReturnPickup({ supabase: fakeSupabase(ret()), processReturn, notifyCustomer: notify, alertOwner: spy(), address: ADDR }, 'r1');
  assert.equal(out.outcome, 'nimbuspost');
  assert.equal(processReturn.calls[1].action, undefined);
  assert.equal(notify.calls.length, 0);
});

test('both refuse: the customer is asked to use India Post, once, and the owner is told why', async () => {
  const sb = fakeSupabase(ret());
  const notify = spy(), alert = spy();
  const out = await runReturnPickup({ supabase: sb, processReturn: spyProcess([refused('xb: no service'), refused('np: no reverse courier')]), notifyCustomer: notify, alertOwner: alert, address: ADDR }, 'r1');
  assert.equal(out.outcome, 'india_post');
  assert.equal(notify.calls.length, 1);
  assert.equal(sb.state.row.courier_name, INDIA_POST);
  assert.equal(sb.state.row.status, 'approved', 'stays approved so a pickup can still be booked by hand');
  assert.match(alert.calls[0][1], /xb: no service/);
  assert.match(alert.calls[0][1], /np: no reverse courier/);

  // A second run (duplicate dispatch) sends nothing.
  const again = await runReturnPickup({ supabase: sb, processReturn: spyProcess([]), notifyCustomer: notify, alertOwner: alert, address: ADDR }, 'r1');
  assert.equal(again.outcome, 'skipped');
  assert.equal(notify.calls.length, 1);
});

test('an HTTP error from process-return is a refusal, not a booking', async () => {
  const out = await runReturnPickup({ supabase: fakeSupabase(ret()),
    processReturn: spyProcess([{ statusCode: 500, data: { error: 'boom' } }, { statusCode: 500, data: {} }]),
    notifyCustomer: spy(), alertOwner: spy(), address: ADDR }, 'r1');
  assert.equal(out.outcome, 'india_post');
  assert.match(out.nimbuspost, /HTTP 500/);
});

test('already booked, not approved, or not found: nothing is attempted', async () => {
  for (const r of [ret({ awb: '14345' }), ret({ status: 'pickup_scheduled' }), ret({ status: 'rejected' }), null]) {
    const processReturn = spyProcess([]);
    const out = await runReturnPickup({ supabase: fakeSupabase(r), processReturn, notifyCustomer: spy(), alertOwner: spy(), address: ADDR }, 'r1');
    assert.equal(out.outcome, 'skipped');
    assert.equal(processReturn.calls.length, 0);
  }
});

test('a booking that lands between the two attempts stops the fallback', async () => {
  const sb = fakeSupabase(ret());
  // XpressBees reports a refusal but a concurrent run booked it meanwhile.
  const processReturn = spyProcess([refused('Already pushed')], () => { sb.state.row.awb = '14345RACE'; });
  const notify = spy();
  const out = await runReturnPickup({ supabase: sb, processReturn, notifyCustomer: notify, alertOwner: spy(), address: ADDR }, 'r1');
  assert.equal(out.outcome, 'skipped');
  assert.equal(processReturn.calls.length, 1);
  assert.equal(notify.calls.length, 0);
});

test('the India Post email names the address, the order and that we pay', () => {
  const html = customerEmailHtml(ret(), ADDR);
  assert.match(html, /IC-20260930-ABCDE/);
  assert.match(html, /Speed Post/);
  assert.match(html, /we will pay the postage/i);
  assert.match(html, /110006/);
  assert.match(html, /UPI/);
});
