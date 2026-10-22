const test = require('node:test');
const assert = require('node:assert');
const { cleanAdClick } = require('./ad-click');

test('keeps real Google click ids and the explicit none', () => {
  assert.equal(cleanAdClick('gclid:Cj0KCQjw_abc-123.XYZ'), 'gclid:Cj0KCQjw_abc-123.XYZ');
  assert.equal(cleanAdClick('gbraid:0AAAAA9x_abcdefg'), 'gbraid:0AAAAA9x_abcdefg');
  assert.equal(cleanAdClick('wbraid:ClkKCQjwabcdefgh'), 'wbraid:ClkKCQjwabcdefgh');
  assert.equal(cleanAdClick('none'), 'none');
});

test('anything else stays unknown (null), never "none"', () => {
  for (const v of [undefined, null, '', 'None', 'gclid:', 'gclid:short', 'fbclid:Cj0KCQjwabcdef', 'gclid:abc def ghijk', "gclid:x'); drop table orders;--", 'gclid:' + 'a'.repeat(300)]) {
    assert.equal(cleanAdClick(v), null, String(v));
  }
});
