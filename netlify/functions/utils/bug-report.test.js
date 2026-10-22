const test = require('node:test');
const assert = require('node:assert/strict');
const { parseBugReport, refFor } = require('./bug-report');

test('a real report is kept, capped and typed', () => {
  const { row, error } = parseBugReport({
    message: '  I pressed Remove and the book stayed\r\n\n\n\nstill there  ',
    contact: ' 98765 43210 ', page_url: '/cart/?x=1', device: 'mobile', viewport: '375x812',
    user_agent: 'Mozilla/5.0', visitor_id: 'vabc',
    cart: [{ title: 'Atomic Habits', qty: '2', price: '299' }, { title: '' }, null],
    errors: [{ msg: 'TypeError: x is undefined', src: 'cart.js', line: 58 }],
  });
  assert.equal(error, undefined);
  assert.equal(row.message, 'I pressed Remove and the book stayed\n\nstill there');
  assert.equal(row.contact, '98765 43210');
  assert.deepEqual(row.cart, [{ title: 'Atomic Habits', qty: 2, price: 299 }]);
  assert.equal(row.errors[0].line, 58);
  assert.equal(row.page_url, '/cart/?x=1');
  assert.equal(refFor(42), 'BUG-42');
});

test('junk is refused or dropped, never stored as given', () => {
  assert.ok(parseBugReport({ message: 'hi' }).error);
  assert.ok(parseBugReport(null).error);
  const { row } = parseBugReport({
    message: 'x'.repeat(5000), page_url: 'https://evil.example/', device: 'fridge', viewport: '1e9',
    cart: 'not a list', errors: Array.from({ length: 50 }, (_, i) => ({ msg: 'e' + i })),
  });
  assert.equal(row.message.length, 2000);
  assert.equal(row.page_url, null);                  // only our own paths
  assert.equal(parseBugReport({ message: 'broken page', page_url: '//evil.example' }).row.page_url, null);
  assert.equal(row.device, null);
  assert.equal(row.viewport, null);
  assert.equal(row.cart, null);
  assert.equal(row.errors.length, 8);               // the last few only
  assert.equal(row.errors[7].msg, 'e49');
});
