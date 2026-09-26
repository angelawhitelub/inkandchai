const test = require('node:test');
const assert = require('node:assert');
const { parseFeedback, summarise, MAX_COMMENT } = require('./ink-ai-feedback');

test('accepts a whole-star rating with a comment', () => {
  const { row, error } = parseFeedback({ session_id: 'smf3k2abc123', rating: 4, comment: '  Helpful  ', page_url: '/product/x/', turns: 3 });
  assert.equal(error, undefined);
  assert.equal(row.rating, 4);
  assert.equal(row.comment, 'Helpful');
  assert.equal(row.page_url, '/product/x/');
  assert.equal(row.turns, 3);
});

test('refuses ratings nobody could have given', () => {
  for (const rating of [0, 6, 4.5, '5', null, undefined, NaN]) {
    assert.ok(parseFeedback({ session_id: 'smf3k2abc123', rating }).error, `rating ${rating}`);
  }
});

test('needs a plausible session id', () => {
  assert.ok(parseFeedback({ rating: 5 }).error);
  assert.ok(parseFeedback({ session_id: 'a b<script>', rating: 5 }).error);
  assert.ok(parseFeedback({ session_id: 'x'.repeat(65), rating: 5 }).error);
});

test('clips the comment and drops foreign page urls', () => {
  const { row } = parseFeedback({ session_id: 'smf3k2abc123', rating: 2, comment: 'a'.repeat(5000), page_url: 'https://evil.example/' });
  assert.equal(row.comment.length, MAX_COMMENT);
  assert.equal(row.page_url, null);
});

test('an empty comment is stored as null, not an empty string', () => {
  assert.equal(parseFeedback({ session_id: 'smf3k2abc123', rating: 5, comment: '   ' }).row.comment, null);
});

test('summarise averages only valid ratings', () => {
  const s = summarise([5, 5, 4, 1, 7, null]);
  assert.equal(s.count, 4);
  assert.equal(s.average, 3.75);
  assert.deepEqual(s.distribution, { 1: 1, 2: 0, 3: 0, 4: 1, 5: 2 });
  assert.equal(summarise([]).average, null);
});
