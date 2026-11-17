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

test('demand sums every ask (asking again counts) and sorts by it', () => {
  const d = demandByTitle([
    { title_key: 'a', title: 'A', status: 'new', request_count: 1, created_at: '2026-10-01' },
    { title_key: 'a', title: 'A', status: 'new', request_count: 1, created_at: '2026-10-02' },
    { title_key: 'b', title: 'B', status: 'new', request_count: 4, created_at: '2026-10-03' },
    { title_key: 'c', title: 'C', status: 'closed', created_at: '2026-10-04' },
  ]);
  assert.deepEqual(d.map(x => [x.title, x.requests, x.customers, x.open]), [['B', 4, 1, 1], ['A', 2, 2, 2], ['C', 1, 1, 0]]);
});

test('groupByBook lists each book once, most requested first, with its askers', () => {
  const { groupByBook } = require('./site-book-request');
  const g = groupByBook([
    { title_key: 'x', title: 'X', request_count: 1, created_at: '2026-10-01' },
    { title_key: 'y', title: 'Y', request_count: 1, created_at: '2026-10-01', customer_name: 'P' },
    { title_key: 'y', title: 'Y', request_count: 3, created_at: '2026-10-02', customer_name: 'Q' },
  ]);
  assert.deepEqual(g.map(b => [b.title, b.requests, b.rows.map(r => r.customer_name || '')]), [['Y', 4, ['Q', 'P']], ['X', 1, ['']]]);
});

test('the requests PDF builds, counts per book and survives Hindi titles', async () => {
  const { buildBookRequestsPdf } = require('./book-requests-pdf');
  const rows = [];
  for (let i = 0; i < 120; i += 1) rows.push({ id: i, title: `Book ${i % 7}`, title_key: `book ${i % 7}`, customer_name: `Cust ${i}`, phone: '9811122334', email: i % 2 ? 'a@b.in' : null, status: 'new', request_count: 1 + (i % 3), note: 'please get it — soon ₹', created_at: '2026-11-01T10:00:00Z' });
  rows.push({ id: 999, title: 'गुनाहों का देवता', title_key: 'गुनाहों का देवता', search_query: 'gunahon ka devta', phone: '9811122334', status: 'sourcing', created_at: '2026-11-02T10:00:00Z' });
  const { bytes, summary } = await buildBookRequestsPdf({ rows, status: 'open', generatedAt: new Date('2026-11-18T06:00:00Z') });
  assert.ok(bytes.length > 2000);
  assert.equal(Buffer.from(bytes.slice(0, 5)).toString(), '%PDF-');
  assert.equal(summary.books, 8);
  assert.equal(summary.customers, 121);
  assert.equal(summary.requests, rows.reduce((s, r) => s + (r.request_count || 1), 0));
  assert.ok(summary.top[0].requests >= summary.top[1].requests);
  const empty = await buildBookRequestsPdf({ rows: [] });
  assert.equal(empty.summary.books, 0);
});
