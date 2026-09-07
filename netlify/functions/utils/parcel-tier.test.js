'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { parcelTier, booksInTitle } = require('./parcel-tier');

const item = (title, qty) => ({ title, qty });

/* -- counting books in one title ----------------------------------------- */

test('a plain single book counts as one', () => {
  assert.strictEqual(booksInTitle('Atomic Habits by James Clear').books, 1);
  assert.strictEqual(booksInTitle('DISCIPLINE IS DESTINY').books, 1);
});

test('an explicit count wins over the bundle word', () => {
  assert.strictEqual(booksInTitle('5 Hindi Bestsellers Combo (Set of 5 Books)').books, 5);
  assert.strictEqual(booksInTitle('Ana Huang Kings of Sin — Combo of 3').books, 3);
  assert.strictEqual(booksInTitle('Off Campus Complete 5 Book Collection').books, 5);
});

test('titles joined by + are counted by their parts', () => {
  const r = booksInTitle('Atomic Habits + Psychology of Money + Ikigai');
  assert.strictEqual(r.books, 3);
  assert.match(r.reason, /joined by/);
});

test('a trailing or bare plus does not create a phantom book', () => {
  // "A +" splits to one non-empty part, so there is no second title.
  assert.strictEqual(booksInTitle('Atomic Habits +').books, 1);
  assert.strictEqual(booksInTitle('+').books, 1);
});

test('a plus inside a word is not a separator', () => {
  // Requires whitespace on one side, so "C++" and "A+ Grades" stay single.
  assert.strictEqual(booksInTitle('Programming in C++').books, 1);
  assert.strictEqual(booksInTitle('A+ Certification Guide').books, 1);
});

test('a bundle word with no number means at least two', () => {
  assert.strictEqual(booksInTitle('David Goggins Boxset').books, 2);
  assert.strictEqual(booksInTitle('Kings of Sin Complete Series').books, 2);
});

test('a bundle word inside a longer word does not match', () => {
  // Word boundaries: these are ordinary titles, not bundles.
  assert.strictEqual(booksInTitle('The Comboni Missionaries').books, 1);
  assert.strictEqual(booksInTitle('Backpacking Across India').books, 1);
});

test('an absurd count falls back to "more than one", not to the number', () => {
  // 99 is not a believable book count, so it is discarded -- but "set of" still
  // proves a bundle, so the answer is the conservative 2, never 99 and never 1.
  const r = booksInTitle('Set of 99 Books');
  assert.strictEqual(r.books, 2);
  assert.strictEqual(r.reason, 'set of');
});

/* -- classifying a whole order ------------------------------------------- */

test('one single book is a standard parcel', () => {
  const r = parcelTier([item('The First 90 Days', 1)]);
  assert.strictEqual(r.tier, 'standard');
  assert.strictEqual(r.books, 1);
});

test('a combo line is heavy and says why', () => {
  const r = parcelTier([item('Rich Dad Poor Dad + The Psychology of Money + The Almanack', 1)]);
  assert.strictEqual(r.tier, 'heavy');
  assert.strictEqual(r.books, 3);
  assert.match(r.reason, /joined by/);
});

test('quantity multiplies the count', () => {
  const r = parcelTier([item('Atomic Habits', 2)]);
  assert.strictEqual(r.tier, 'heavy');
  assert.strictEqual(r.books, 2);
  assert.match(r.reason, /×2/);
});

test('several separate single books is heavy on its own', () => {
  // Three paperbacks in one box weigh what a three-book combo weighs.
  const r = parcelTier([
    item('Not Quite Dead Yet', 1), item('Train To Pakistan', 1), item('The God of Small Things', 1),
  ]);
  assert.strictEqual(r.tier, 'heavy');
  assert.strictEqual(r.books, 3);
  assert.match(r.reason, /separate items/);
});

test('an order with no cart items stays standard', () => {
  // No evidence is not evidence of weight -- never deduct more on a guess.
  const r = parcelTier([]);
  assert.strictEqual(r.tier, 'standard');
  assert.strictEqual(r.books, 0);
  assert.match(r.reason, /no cart items/);
  assert.strictEqual(parcelTier(null).tier, 'standard');
  assert.strictEqual(parcelTier('not an array').tier, 'standard');
});

test('a missing or junk qty is treated as one, never zero', () => {
  assert.strictEqual(parcelTier([{ title: 'Ikigai' }]).books, 1);
  assert.strictEqual(parcelTier([{ title: 'Ikigai', qty: 0 }]).books, 1);
  assert.strictEqual(parcelTier([{ title: 'Ikigai', qty: 'abc' }]).books, 1);
  assert.strictEqual(parcelTier([{ title: 'Ikigai', quantity: 3 }]).books, 3);
});

test('the heavy threshold is configurable', () => {
  const cart = [item('Atomic Habits', 2)];
  assert.strictEqual(parcelTier(cart, { heavyAtBooks: 3 }).tier, 'standard');
  assert.strictEqual(parcelTier(cart, { heavyAtBooks: 2 }).tier, 'heavy');
  // Never below 2: a single book must never be billed as heavy.
  assert.strictEqual(parcelTier([item('Ikigai', 1)], { heavyAtBooks: 1 }).tier, 'standard');
});
