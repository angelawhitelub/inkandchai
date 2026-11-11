'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const NR = require('./no-returns');
const { pickReturnItems } = require('./return-refund');

const MAP = { 'clearance-book': { since: '2026-11-11T10:00:00Z', title: 'Clearance Book' } };

test('a stamped line is non-returnable whatever the switch says now', () => {
  assert.equal(NR.isNoReturnLine({ slug: 'x', _no_returns: true }, {}, '2026-11-01T00:00:00Z'), true);
  assert.equal(NR.isNoReturnLine({ slug: 'clearance-book', _no_returns: false }, MAP, '2026-11-12T00:00:00Z'), false);
});

test('an unstamped line counts only for orders placed after the switch', () => {
  assert.equal(NR.isNoReturnLine({ slug: 'clearance-book' }, MAP, '2026-11-12T00:00:00Z'), true);
  assert.equal(NR.isNoReturnLine({ slug: 'clearance-book' }, MAP, '2026-11-10T00:00:00Z'), false);
  assert.equal(NR.isNoReturnLine({ slug: 'other' }, MAP, '2026-11-12T00:00:00Z'), false);
  // WhatsApp lines carry only a title.
  assert.equal(NR.isNoReturnLine({ title: 'Clearance  Book!' }, MAP, '2026-11-12T00:00:00Z'), true);
});

test('noReturnTitles lists them', () => {
  const order = { created_at: '2026-11-12T00:00:00Z', cart_items: [{ slug: 'clearance-book', title: 'Clearance Book' }, { slug: 'v', title: 'Verity' }] };
  assert.deepEqual(NR.noReturnTitles(order, MAP), ['Clearance Book']);
  assert.deepEqual(NR.noReturnTitles({ cart_items: null }, MAP), []);
});

test('a return of a clearance book is refused; the rest of the order can still go back', () => {
  const order = { amount_paise: 100000, cart_items: [
    { title: 'Clearance Book', qty: 1, price: 400, _no_returns: true },
    { title: 'Verity', qty: 1, price: 600 },
  ] };
  const refused = pickReturnItems(order, [{ title: 'Clearance Book', qty: 1 }]);
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'no_returns');
  assert.match(refused.error, /stock clearance sale: no returns, only replacements/);

  const ok = pickReturnItems(order, [{ title: 'Verity', qty: 1 }]);
  assert.equal(ok.ok, true);
  assert.equal(ok.whole, false);
  assert.deepEqual(ok.items.map((i) => i.title), ['Verity']);

  // Nothing picked = everything returnable, which leaves the clearance book out.
  const all = pickReturnItems(order, []);
  assert.deepEqual(all.items.map((i) => i.title), ['Verity']);
  assert.equal(all.whole, false);

  const onlyClearance = pickReturnItems({ amount_paise: 40000, cart_items: [{ title: 'Clearance Book', qty: 1, _no_returns: true }] }, []);
  assert.equal(onlyClearance.code, 'no_returns');
});

test('the notice carries the exact wording', () => {
  assert.match(NR.noticeHtml(), /Stock clearance sale: no returns, only replacements\./);
});
