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
  assert.match(refused.error, /cannot be returned for a refund: no returns, only replacements/);

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

test('an all-orders book binds orders placed before the switch, and title-only lines by its pattern', () => {
  const slug = 'belonging-a-journey-of-love-by-sonia-gandhi';
  const map = { [slug]: { since: NR.ALL_ORDERS_SINCE, title: 'Belonging: A Journey of Love by Sonia Gandhi', all_orders: true, title_match: '\\bbelonging\\b|journey\\s+of\\s+love' } };
  assert.equal(NR.isNoReturnLine({ slug, title: 'Belonging: A Journey of Love by Sonia Gandhi' }, map, '2026-11-10T08:00:00Z'), true);
  for (const t of ['Belonging by Sonia Gandhi', 'A Journey of Love by Sonia Gandhi', 'The Belonging: A Journey of Love'])
    assert.equal(NR.isNoReturnLine({ title: t }, map, '2026-11-12T00:00:00Z'), true, t);
  assert.equal(NR.isNoReturnLine({ title: 'Verity' }, map, '2026-11-12T00:00:00Z'), false);
  // A line with another slug is not caught by the title pattern.
  assert.equal(NR.isNoReturnLine({ slug: 'longing-x', title: 'Belonging Elsewhere' }, map, '2026-11-12T00:00:00Z'), false);
  assert.match(NR.noticeHtml(map[slug]), /No returns on this title, only replacements/);
  assert.doesNotMatch(NR.noticeHtml(map[slug]), /clearance/);
  assert.match(NR.noticeHtml(MAP['clearance-book']), /Stock clearance sale/);
  const refused = pickReturnItems({ created_at: '2026-11-10T08:00:00Z', amount_paise: 50000, cart_items: [{ slug, title: 'Belonging: A Journey of Love by Sonia Gandhi', price: 500, qty: 1 }] }, [],
    { noReturn: (i) => NR.isNoReturnLine(i, map, '2026-11-10T08:00:00Z') });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'no_returns');
});
