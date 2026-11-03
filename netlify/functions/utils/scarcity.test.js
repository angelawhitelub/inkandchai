'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { scarceSlugs, PINNED_SCARCE } = require('./scarcity');

function fakeDb({ on = [], pinned = [] }) {
  return {
    from() {
      let eq = false;
      const q = {
        select() { return q; },
        eq() { eq = true; return q; },
        in() { return q; },
        then(res, rej) { return Promise.resolve({ data: eq ? on : pinned, error: null }).then(res, rej); },
      };
      return q;
    },
  };
}

test('an admin tick shows the badge; an untick hides even a pinned book', async () => {
  const set = await scarceSlugs(fakeDb({
    on: [{ slug: 'Some-Book', is_active: true }, { slug: 'disabled-override', is_active: false }],
    pinned: [{ slug: PINNED_SCARCE[0], scarcity: false, is_active: true }, { slug: PINNED_SCARCE[1], scarcity: false, is_active: false }],
  }));
  assert.ok(set.has('some-book'));
  assert.ok(!set.has('disabled-override'));
  assert.ok(!set.has(PINNED_SCARCE[0]), 'unticked');
  assert.ok(set.has(PINNED_SCARCE[1]), 'a disabled override leaves the pin');
  assert.ok(set.has(PINNED_SCARCE[2]), 'no override: pinned as baked');
});
