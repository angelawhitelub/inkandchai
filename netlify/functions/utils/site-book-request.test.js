'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseRequest, titleKey, demandByTitle } = require('./site-book-request');

test('a title and a WhatsApp number make a request', () => {
  const { row, error } = parseRequest({ title: '  The  Midnight Library ', name: 'Asha', phone: '+91 98111 22334', q: 'midnight lib', source: 'overlay', page_url: '/' });
  assert.equal(error, undefined);
  assert.equal(row.title, 'The Midnight Library');
  assert.equal(row.title_key, 'the midnight library');
  assert.equal(row.phone, '9811122334');
  assert.equal(row.contact_key, 'p:9811122334');
  assert.equal(row.email, null);
  assert.equal(row.source, 'overlay');
  assert.equal(row.search_query, 'midnight lib');
});

test('email alone is enough; neither is not', () => {
  assert.equal(parseRequest({ title: 'Sapiens', email: 'A@Gmail.com' }).row.contact_key, 'e:a@gmail.com');
  assert.match(parseRequest({ title: 'Sapiens' }).error, /WhatsApp number or email/);
});

test('bad contact details and missing titles are refused with a reason', () => {
  assert.match(parseRequest({ title: 'Sapiens', phone: '12345' }).error, /10-digit/);
  assert.match(parseRequest({ title: 'Sapiens', email: 'x@mailinator.com' }).error, /email/);
  assert.match(parseRequest({ title: ' ', phone: '9811122334' }).error, /title/);
});

test('the honeypot marks a bot', () => {
  assert.equal(parseRequest({ title: 'X Y', phone: '9811122334', website: 'http://spam' }).error, 'spam');
});

test('unknown source and off-site page urls are dropped', () => {
  const { row } = parseRequest({ title: 'Ikigai', phone: '9811122334', source: 'evil', page_url: 'https://evil.example/' });
  assert.equal(row.source, 'other');
  assert.equal(row.page_url, null);
});

test('the same book spelled differently is one title', () => {
  assert.equal(titleKey('Atomic Habits!'), titleKey('atomic   habits'));
  assert.equal(titleKey('Café'), 'cafe');
});

test('demand counts customers per book, most wanted first', () => {
  const d = demandByTitle([
    { title_key: 'a', title: 'A', status: 'new', created_at: '2026-10-01' },
    { title_key: 'b', title: 'B', status: 'closed', created_at: '2026-10-02' },
    { title_key: 'b', title: 'B', status: 'new', created_at: '2026-10-03' },
  ]);
  assert.deepEqual(d.map(x => [x.title, x.customers, x.open]), [['B', 2, 1], ['A', 1, 1]]);
});
