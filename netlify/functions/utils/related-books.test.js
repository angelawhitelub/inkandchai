const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '../../..');
const rel = require(path.join(root, 'netlify/functions/utils/related-books'));
const cartJs = fs.readFileSync(path.join(root, 'public/js/cart.js'), 'utf8');

const book = (slug, title, extra = {}) => ({
  slug, url: `/product/${slug}/`, title, author: '', category: 'Fiction', tags: '', description: '',
  price: 299, img: 'x.webp', ...extra,
});

const pool = [
  book('hp1', "Harry Potter and the Philosopher's Stone by J.K. Rowling", { category: 'Kids Book', description: 'wizard school magic hogwarts' }),
  book('hp2', 'Harry Potter and the Chamber of Secrets', { author: 'J.K. Rowling', category: 'Kids Book', description: 'wizard hogwarts magic' }),
  book('hp1-hb', "Harry Potter and the Philosopher's Stone (Hardcover)", { category: 'Kids Book' }),
  book('hp-hi', 'Hindi Harry Potter aur Paras Pathar', { category: 'Hindi Books' }),
  book('colour', 'Magic Wizards Colouring Book for Kids', { category: 'Kids Book', description: 'wizard magic colouring' }),
  book('chm', "Can't Hurt Me (Paperback)", { category: 'All Self Help', description: 'discipline mental toughness navy seal goggins' }),
  book('nf', 'Never Finished', { category: 'All Self Help', description: 'discipline mental toughness goggins seal' }),
  book('chm-ta', "(Tamil) Can't Hurt Me", { category: 'All Self Help', description: 'discipline mental toughness goggins' }),
  book('cook', 'Indian Cooking Made Easy', { category: 'Cookery', description: 'recipes curry spices' }),
];

function ranked(slug, limit = 6) {
  const index = rel.buildIndex(pool);
  const base = pool.find((p) => p.slug === slug);
  return rel.rankRelated(base, pool, { index, exclude: new Set(), limit }).map((r) => r.product.slug);
}

test('a series comes first, and another format of the same book never appears', () => {
  const out = ranked('hp1');
  assert.equal(out[0], 'hp2');
  assert.ok(!out.includes('hp1-hb'), 'the hardback of the same book is not a recommendation');
});

test('another language edition is never shown on an English page', () => {
  assert.ok(!ranked('hp1').includes('hp-hi'));
  assert.ok(!ranked('chm').includes('chm-ta'));
  assert.equal(rel.langOf({ title: '(Tamil) The Psychology of Money' }), 'tamil');
  assert.equal(rel.langOf({ title: 'गोदान' }), 'hindi');
  assert.equal(rel.langOf({ title: 'Atomic Habits' }), 'english');
});

test('colouring and activity books stay off pages that are not one', () => {
  assert.ok(!ranked('hp1').includes('colour'));
});

test('an unrelated book is not shown just to fill the shelf', () => {
  assert.ok(!ranked('chm').includes('cook'));
  assert.deepEqual(ranked('chm'), ['nf']);
});

test('the author named in the title counts when the author field is blank', () => {
  assert.equal(rel.authorOf(pool[0]), 'j k rowling');
  assert.equal(rel.authorOf(pool[1]), 'j k rowling');
  assert.equal(rel.realAuthor('Various'), '');
  assert.equal(rel.realAuthor('Prakash Books'), '', 'a publisher is not an author');
});

test('"More by" only when the shelf really is that author, never with a blank name', () => {
  const rows = [pool[1], pool[1], pool[1]].map((p) => ({ product: p }));
  assert.deepEqual(rel.shelfHeading(pool[0], rows), { kind: 'author', author: 'J.K. Rowling' });
  assert.deepEqual(rel.shelfHeading(pool[5], rows), { kind: 'similar' });
});

test('format words do not make two books different', () => {
  assert.equal(rel.coreTitle("Can't Hurt Me (Paperback)"), rel.coreTitle("Can't Hurt Me (HARDCOVER)"));
  assert.equal(rel.coreTitle('Before the Coffee Gets Cold: A Novel'), 'before coffee gets cold');
});

test('the cart shows a single suggestion', () => {
  assert.match(cartJs, /&limit=1&exclude=/);
  assert.match(cartJs, /\.slice\(0, 1\);/);
});

test('product pages load the related shelf and never show an empty "More by"', () => {
  assert.match(cartJs, /initRelatedShelf\(\);/);
  assert.match(cartJs, /mode=related&limit=12/);
  const gen = fs.readFileSync(path.join(root, 'generate_site.py'), 'utf8');
  assert.match(gen, /_own_author not in \("various", "unknown"\)/);
});
