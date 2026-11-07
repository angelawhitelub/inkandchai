'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const INV = require('./inventory');

const cat = (slug, price, mrp, extra = {}) => ({ slug, title: slug.toUpperCase(), author: 'A', category: 'Fiction', price_inr: price, original_price_inr: mrp, image_url: 'x.jpg', ...extra });

test('buildRows: product_settings price beats override and custom; stock only from an active override', () => {
  const rows = INV.buildRows({
    catalogue: [cat('a', '300', '400'), cat('b', '250', '350'), cat('c', '199', null)],
    custom: [{ slug: 'd', title: 'D', price_inr: '500', original_price_inr: '700', is_active: true, tags: 'crossword-catalog', updated_at: '2026-01-01' }],
    overrides: [
      { slug: 'a', price_inr: '280', stock_qty: 4, is_active: true, scarcity: true, updated_at: '2026-02-01' },
      { slug: 'b', price_inr: '150', stock_qty: 0, is_active: false },
      { slug: 'd', price_inr: '450', is_active: true, updated_at: '2025-12-01' },
    ],
    settings: { a: { slug: 'a', price_inr: '260', original_price_inr: null } },
    codOff: { c: 'note' },
    free: new Set(['c']),
    searchHidden: new Set(['b']),
    deleted: new Set(['c']),
    sold: (k) => ({ a: 12 }[k] || 0),
  });
  const by = Object.fromEntries(rows.map((r) => [r.slug, r]));
  assert.equal(by.a.price, 260);
  assert.equal(by.a.mrp, 400);
  assert.equal(by.a.stock, 4);
  assert.equal(by.a.sold, 12);
  assert.ok(by.a.flags & INV.F.SCARCITY && by.a.flags & INV.F.PRICE_SET && by.a.flags & INV.F.OVERRIDE);
  // Switched-off override: catalogue price, no stock, flagged.
  assert.equal(by.b.price, 250);
  assert.equal(by.b.stock, null);
  assert.ok(by.b.flags & INV.F.OVERRIDE_OFF && by.b.flags & INV.F.SEARCH_HIDDEN);
  assert.ok(!(by.b.flags & INV.F.OVERRIDE));
  assert.ok(by.c.flags & INV.F.COD_OFF && by.c.flags & INV.F.FREE_DELIVERY && by.c.flags & INV.F.DELETED);
  // Newer custom row beats the older override, as pricing.js does.
  assert.equal(by.d.price, 500);
  assert.equal(by.d.source, 'crossword');
});

test('packRows keeps column order and encodes the source', () => {
  const [row] = INV.packRows(INV.buildRows({ catalogue: [cat('a', '300', '400')] }));
  assert.equal(row.length, INV.COLS.length);
  assert.equal(row[INV.COLS.indexOf('source')], 0);
  assert.equal(row[INV.COLS.indexOf('price')], 300);
});

const item = (slug, over = {}) => ({ slug, title: slug, author: 'A', category: 'Fiction', price: 300, mrp: 400, stock: null, override: null, setting: null, ...over });

test('planFields: percent, MRP discount, rounding, above-MRP refusal', () => {
  let p = INV.planFields('price_pct', -10, [item('a'), item('b', { price: 199 })]);
  assert.deepEqual(p.changes.map((c) => c.after.price), [270, 179]);
  p = INV.planFields('price_from_mrp', 40, [item('a'), item('b', { mrp: null })]);
  assert.equal(p.changes[0].after.price, 240);
  assert.match(p.skipped[0].reason, /no MRP/);
  p = INV.planFields('price_set', 450, [item('a')]);
  assert.equal(p.changes.length, 0);
  assert.match(p.skipped[0].reason, /above its MRP/);
  p = INV.planFields('price_set', 300, [item('a')]);
  assert.match(p.skipped[0].reason, /already set/);
});

test('planFields: stock add needs a counted book; switched-off override refuses stock', () => {
  const on = { slug: 'a', is_active: true, stock_qty: 3 };
  let p = INV.planFields('stock_add', 5, [item('a', { stock: 3, override: on }), item('b')]);
  assert.equal(p.changes[0].after.stock, 8);
  assert.match(p.skipped[0].reason, /not counted/);
  p = INV.planFields('stock_add', -10, [item('a', { stock: 3, override: on })]);
  assert.equal(p.changes[0].after.stock, 0);
  p = INV.planFields('sold_out', null, [item('a', { override: { slug: 'a', is_active: false } })]);
  assert.match(p.skipped[0].reason, /switched off/);
});

test('writesFor: carries stored fields, writes settings for prices, undo has the stored rows', () => {
  const o = { slug: 'a', title: 'Stored', author: null, category: null, price_inr: '320.00', original_price_inr: null, stock_qty: 7, scarcity: true, is_active: false };
  const s = { slug: 'a', price_inr: '320.00', original_price_inr: null, handling_days: 3 };
  const it = item('a', { override: o, setting: s, price: 320 });
  const plan = INV.planFields('price_set', 299, [it]);
  const w = INV.writesFor('price_set', plan.changes, new Map([['a', it]]), 'now');
  assert.equal(w.overrides[0].price_inr, '299.00');
  assert.equal(w.overrides[0].stock_qty, 7, 'a price change keeps the stored stock');
  assert.equal(w.overrides[0].scarcity, true);
  assert.equal(w.overrides[0].is_active, false);
  assert.equal(w.overrides[0].title, 'Stored');
  assert.deepEqual(w.settings[0], { slug: 'a', price_inr: '299.00', original_price_inr: '400.00', handling_days: 3, updated_at: 'now' });
  assert.equal(w.undo[0].override.price_inr, '320.00');
  assert.equal(w.undo[0].setting.handling_days, 3);

  // New row: listing title, no settings write for stock, undo says "no row before".
  const fresh = item('b');
  const plan2 = INV.planFields('stock_set', 5, [fresh]);
  const w2 = INV.writesFor('stock_set', plan2.changes, new Map([['b', fresh]]), 'now');
  assert.equal(w2.overrides[0].title, 'b');
  assert.equal(w2.overrides[0].stock_qty, 5);
  assert.equal(w2.overrides[0].is_active, true);
  assert.equal(w2.settings.length, 0);
  assert.equal(w2.undo[0].override, null);
  assert.equal(w2.undo[0].setting, undefined);
  // Every override row has the same keys (one PostgREST column list).
  assert.deepEqual(Object.keys(w.overrides[0]).sort(), Object.keys(w2.overrides[0]).sort());
});

test('writesFor: category also updates the custom row', () => {
  const it = item('c', { custom_slug: 'C-Up', custom_category: 'Old' });
  const plan = INV.planFields('category_set', 'Self Help', [it]);
  const w = INV.writesFor('category_set', plan.changes, new Map([['c', it]]));
  assert.deepEqual(w.customCategory, { 'Self Help': ['C-Up'] });
  assert.equal(w.undo[0].custom_category, 'Old');
});

test('checkValue and cleanUndoItem reject junk', () => {
  assert.ok(INV.checkValue('price_pct', 0));
  assert.ok(INV.checkValue('stock_set', 1.5));
  assert.equal(INV.checkValue('stock_set', 0), '');
  assert.equal(INV.cleanUndoItem({ slug: 'a b' }), null);
  assert.equal(INV.cleanUndoItem({ slug: 'a' }), null);
  const u = INV.cleanUndoItem({ slug: 'A', override: { price_inr: '-4', stock_qty: '12', is_active: 'x', evil: 1 }, setting: null });
  assert.deepEqual(u.override, { title: null, author: null, category: null, price_inr: null, original_price_inr: null, stock_qty: 12, scarcity: false, is_active: true });
  assert.equal(u.slug, 'a');
  assert.equal(u.setting, null);
});

test('buildRows: a stranded upper-case override row at 0 makes the book sold out, as readers see it', () => {
  const rows = INV.buildRows({
    catalogue: [cat('set-age-4', '599', '1499')],
    overrides: [
      { slug: 'set-age-4', price_inr: '529', stock_qty: null, is_active: true },
      { slug: 'set-AGE-4', price_inr: '599', stock_qty: 0, is_active: true },
    ],
  });
  assert.equal(rows[0].stock, 0);
  assert.equal(rows[0].price, 529, 'fields still come from the lower-case row');
});
