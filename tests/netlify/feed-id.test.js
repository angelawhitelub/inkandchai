'use strict';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

const { feedId, legacyFeedId, MAX_ID_LEN } = require('../../netlify/functions/utils/feed-id');
const { feedOfferId, offerIdsForSlug, offerMatchesSlug } = require('../../netlify/functions/utils/google-discount');

test('short slugs go out verbatim as cp-<slug>', () => {
  assert.strictEqual(feedId('ikigai'), 'cp-ikigai');
  assert.strictEqual(feedId('the-alchemist'), 'cp-the-alchemist');
  const at = 'a'.repeat(MAX_ID_LEN - 3);
  assert.strictEqual(feedId(at), `cp-${at}`);
  assert.strictEqual(feedId(at).length, MAX_ID_LEN);
});

test('long slugs stay readable instead of collapsing to a bare hash', () => {
  const slug = 'protocols-an-operating-manual-for-the-human-body';
  const id = feedId(slug);
  assert.strictEqual(id, 'cp-protocols-an-operating-manual-for-the-7028c1d2');
  assert.ok(id.startsWith('cp-protocols-an-operating-manual'), id);
  assert.notStrictEqual(id, legacyFeedId(slug));
  assert.strictEqual(legacyFeedId(slug), 'cp-7028c1d20f0a498f462f');
});

test("no id ever exceeds Google's 50-character cap", () => {
  const cases = [
    'x'.repeat(200),
    'a-' + 'b'.repeat(200),
    Array.from({ length: 40 }, (_, i) => `word${i}`).join('-'),
    'protocols-an-operating-manual-for-the-human-body',
    '-'.repeat(80),
  ];
  for (const slug of cases) assert.ok(feedId(slug).length <= MAX_ID_LEN, `${slug.slice(0, 20)} -> ${feedId(slug).length}`);
});

test('ids are truncated on a word boundary, with no trailing hyphen', () => {
  const id = feedId('protocols-an-operating-manual-for-the-human-body');
  assert.ok(!/--/.test(id), id);
  assert.match(id, /-[0-9a-f]{8}$/);
});

test('a hyphenless long slug is hard-cut rather than thrown away', () => {
  const id = feedId('a-verylongsinglewordwithoutanyhyphensatallgoeshere');
  assert.ok(id.length <= MAX_ID_LEN, id);
  assert.ok(id.startsWith('cp-a-verylongsingleword'), id);
});

test('shortening stays unique for slugs sharing a long prefix', () => {
  const base = 'the-complete-illustrated-encyclopaedia-of-';
  const ids = new Set(['world-history', 'world-geography', 'world-mythology'].map(t => feedId(base + t)));
  assert.strictEqual(ids.size, 3);
  for (const id of ids) assert.ok(id.length <= MAX_ID_LEN, id);
});

test('empty and nullish slugs produce no id', () => {
  for (const v of [null, undefined, '', '   ']) {
    assert.strictEqual(feedId(v), '');
    assert.strictEqual(legacyFeedId(v), '');
  }
});

test('feedOfferId mirrors the feed for custom products and the bare slug otherwise', () => {
  const slug = 'protocols-an-operating-manual-for-the-human-body';
  assert.strictEqual(feedOfferId(slug, { custom: true }), feedId(slug));
  assert.strictEqual(feedOfferId(slug), slug);
  assert.strictEqual(feedOfferId(''), '');
});

test('offer matching still accepts the ids Merchant Center already holds', () => {
  const slug = 'protocols-an-operating-manual-for-the-human-body';
  assert.ok(offerMatchesSlug(legacyFeedId(slug), slug));
  assert.ok(offerMatchesSlug(feedId(slug), slug));
  assert.ok(offerMatchesSlug(slug, slug));
  assert.ok(offerMatchesSlug(`cp-${slug}`, slug));
  assert.ok(!offerMatchesSlug('cp-something-else', slug));
  assert.strictEqual(new Set(offerIdsForSlug(slug)).size, offerIdsForSlug(slug).length, 'no duplicate candidates');
});

test('the feeds and the discount util cannot drift apart', () => {
  const fs = require('fs');
  const src = fs.readFileSync(require.resolve('../../netlify/functions/custom-products-feed.js'), 'utf8');
  const bulk = fs.readFileSync(require.resolve('../../netlify/functions/custom-products-feed-bulk.js'), 'utf8');
  for (const [name, s] of [['feed', src], ['bulk feed', bulk]]) {
    assert.ok(s.includes("require('./utils/feed-id')"), `${name} must use the shared feed-id util`);
    assert.ok(!/function feedId\(/.test(s), `${name} must not redefine feedId`);
  }
  const slug = 'x'.repeat(60);
  assert.strictEqual(legacyFeedId(slug), 'cp-' + crypto.createHash('sha1').update(slug).digest('hex').slice(0, 20));
});
