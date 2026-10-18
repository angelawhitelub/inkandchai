'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('./marketplace-links');

test('store links are accepted only for their own marketplace', () => {
  assert.equal(M.cleanStoreUrl('amazon', 'https://www.amazon.in/dp/B0ABCDEF12').url, 'https://www.amazon.in/dp/B0ABCDEF12');
  assert.equal(M.cleanStoreUrl('amazon', 'amzn.in/d/xyz').url, 'https://amzn.in/d/xyz');
  assert.equal(M.cleanStoreUrl('flipkart', 'http://www.flipkart.com/book/p/itm123?pid=X').url, 'https://www.flipkart.com/book/p/itm123?pid=X');
  assert.equal(M.cleanStoreUrl('flipkart', 'https://dl.flipkart.com/s/abc').url, 'https://dl.flipkart.com/s/abc');
  assert.match(M.cleanStoreUrl('amazon', 'https://www.flipkart.com/x').error, /amazon\.in/);
  assert.match(M.cleanStoreUrl('flipkart', 'https://flipkart.com.evil.example/x').error, /flipkart\.com/);
  assert.match(M.cleanStoreUrl('amazon', 'https://notamazon.in/x').error, /amazon\.in/);
  assert.match(M.cleanStoreUrl('amazon', 'javascript:alert(1)').error, /./);
});

test('blank clears the link', () => {
  assert.deepEqual(M.cleanStoreUrl('amazon', '  '), { url: null });
  assert.deepEqual(M.cleanStoreUrl('flipkart', null), { url: null });
});

test('the storefront gets only the links that are set, or null', () => {
  assert.deepEqual(M.publicLinks({ slug: 'a-b', amazon_url: 'https://www.amazon.in/dp/X', flipkart_url: null, updated_at: 't' }),
    { slug: 'a-b', amazon_url: 'https://www.amazon.in/dp/X', updated_at: 't' });
  assert.equal(M.publicLinks({ slug: 'a-b', amazon_url: null, flipkart_url: '' }), null);
  // A bad value that somehow reached the table is still never served.
  assert.equal(M.publicLinks({ slug: 'a-b', amazon_url: 'https://evil.example/' }), null);
  assert.equal(M.publicLinks(null), null);
});

test('a missing table is recognised', () => {
  assert.equal(M.isMissingTable({ message: 'relation "public.product_marketplace_links" does not exist' }), true);
  assert.equal(M.isMissingTable({ code: '42P01', message: 'x' }), true);
  assert.equal(M.isMissingTable({ message: 'timeout' }), false);
});
