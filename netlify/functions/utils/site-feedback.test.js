const test = require('node:test');
const assert = require('node:assert');
const { parseFeedback, summarise, MAX_COMMENT } = require('./site-feedback');

const V = 'vmf3k2abc123';

test('website feedback is keyed by the visitor, so rating again updates it', () => {
  const { row, error } = parseFeedback({ kind: 'website', rating: 4, visitor_id: V, comment: '  Easy to find books  ', page_url: '/books/', device: 'mobile' });
  assert.equal(error, undefined);
  assert.equal(row.feedback_key, 'web:' + V);
  assert.equal(row.comment, 'Easy to find books');
  assert.equal(row.order_id, null);
  assert.equal(row.device, 'mobile');
});

test('order feedback is keyed by the order, one rating per order', () => {
  const { row } = parseFeedback({ kind: 'order', rating: 5, visitor_id: V, order_id: 'IC-20260926-AB12C' });
  assert.equal(row.feedback_key, 'order:IC-20260926-AB12C');
  assert.equal(row.order_id, 'IC-20260926-AB12C');
});

test('order feedback without an order id is refused', () => {
  assert.ok(parseFeedback({ kind: 'order', rating: 5, visitor_id: V }).error);
  assert.ok(parseFeedback({ kind: 'order', rating: 5, visitor_id: V, order_id: "x' or 1=1" }).error);
});

test('refuses ratings nobody could have given', () => {
  for (const rating of [0, 6, 4.5, '5', null, undefined, NaN]) {
    assert.ok(parseFeedback({ kind: 'website', rating, visitor_id: V }).error, `rating ${rating}`);
  }
});

test('refuses unknown kinds and missing visitor ids', () => {
  assert.ok(parseFeedback({ kind: 'ai', rating: 5, visitor_id: V }).error);
  assert.ok(parseFeedback({ kind: 'website', rating: 5 }).error);
  assert.ok(parseFeedback({ kind: 'website', rating: 5, visitor_id: 'a b<script>' }).error);
});

test('clips the comment, drops foreign page urls and unknown devices', () => {
  const { row } = parseFeedback({ kind: 'website', rating: 2, visitor_id: V, comment: 'a'.repeat(5000), page_url: 'https://evil.example/', device: 'fridge' });
  assert.equal(row.comment.length, MAX_COMMENT);
  assert.equal(row.page_url, null);
  assert.equal(row.device, null);
});

test('an empty comment is stored as null, not an empty string', () => {
  assert.equal(parseFeedback({ kind: 'website', rating: 5, visitor_id: V, comment: '   ' }).row.comment, null);
});

test('summarise averages only valid ratings', () => {
  const s = summarise([5, 5, 4, 1, 7, null]);
  assert.equal(s.count, 4);
  assert.equal(s.average, 3.75);
  assert.deepEqual(s.distribution, { 1: 1, 2: 0, 3: 0, 4: 1, 5: 2 });
  assert.equal(summarise([]).average, null);
});
