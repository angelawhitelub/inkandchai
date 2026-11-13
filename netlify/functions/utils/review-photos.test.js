'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('./review-photos');

const webp = 'data:image/webp;base64,' + Buffer.from('RIFF....WEBP').toString('base64');

test('parsePhotos accepts small JPG/PNG/WebP and refuses the rest', () => {
  assert.deepEqual(P.parsePhotos(undefined), []);
  const out = P.parsePhotos([webp, webp.replace('webp', 'jpeg')]);
  assert.equal(out.length, 2);
  assert.equal(out[0].ext, 'webp');
  assert.equal(out[1].ext, 'jpg');
  assert.throws(() => P.parsePhotos([webp, webp, webp, webp, webp]), /At most 4/);
  assert.throws(() => P.parsePhotos(['https://x.example/a.jpg']), /not an image/);
  assert.throws(() => P.parsePhotos(['data:image/svg+xml;base64,PHN2Zz4=']), /JPG, PNG or WebP/);
  const big = 'data:image/png;base64,' + Buffer.alloc(3 * 1024 * 1024 + 1).toString('base64');
  assert.throws(() => P.parsePhotos([big]), /over 3 MB/);
});

test('uploadPhotos stores under reviews/<slug>/ and returns URLs in order', async () => {
  const keys = [];
  const urls = await P.uploadPhotos('The Book/../x', P.parsePhotos([webp, webp]), {
    now: () => 1,
    put: async (key) => { keys.push(key); return 'https://img.example/' + key; },
  });
  assert.equal(urls.length, 2);
  assert.match(keys[0], /^reviews\/the-book-x\/[a-z0-9]+-1\.webp$/);
  assert.match(keys[1], /-2\.webp$/);
});

test('cleanPhotoUrls keeps only https URLs; missing-column errors are recognised', () => {
  assert.deepEqual(P.cleanPhotoUrls(['https://a/b.webp', 'javascript:alert(1)', 'http://x', 'https://a/"x']), ['https://a/b.webp']);
  assert.deepEqual(P.cleanPhotoUrls(null), []);
  assert.equal(P.isMissingPhotosColumn({ message: "Could not find the 'photos' column of 'product_reviews' in the schema cache" }), true);
  assert.equal(P.isMissingPhotosColumn({ message: 'column product_reviews.photos does not exist' }), true);
  assert.equal(P.isMissingPhotosColumn({ message: 'timeout' }), false);
});

test('add-review uploads photos and saves their URLs; a missing column gives the SQL hint', async () => {
  const path = require('node:path');
  process.env.ADMIN_SECRET = process.env.ADMIN_SECRET || 'test-admin-key';
  process.env.SUPABASE_URL = 'https://example.invalid';
  process.env.SUPABASE_SERVICE_KEY = 'x';
  Object.assign(process.env, { R2_ACCOUNT_ID: 'a', R2_ACCESS_KEY_ID: 'b', R2_SECRET_ACCESS_KEY: 'c', R2_PUBLIC_BASE: 'https://img.example' });

  let inserted = null;
  let insertError = null;
  const db = {
    from: () => ({
      insert: (row) => { inserted = row; return { select: () => ({ single: async () => (insertError ? { data: null, error: insertError } : { data: { id: 7 }, error: null }) }) }; },
    }),
  };
  const sbPath = require.resolve('@supabase/supabase-js');
  const r2Path = require.resolve('./r2-put');
  const pcPath = require.resolve('./purge-cache');
  const saved = [sbPath, r2Path, pcPath].map((p) => require.cache[p]);
  const realR2 = require('./r2-put');
  const realPc = require('./purge-cache');
  const puts = [];
  require.cache[sbPath] = { id: sbPath, filename: sbPath, loaded: true, exports: { createClient: () => db } };
  require.cache[r2Path] = { id: r2Path, filename: r2Path, loaded: true, exports: { ...realR2, r2PutObject: async (cfg, o) => { puts.push(o.key); return cfg.publicBase + '/' + o.key; } } };
  require.cache[pcPath] = { id: pcPath, filename: pcPath, loaded: true, exports: { ...realPc, purgeCacheTags: async () => {} } };
  const fn = path.join(__dirname, '..', 'add-review.js');
  delete require.cache[fn];
  try {
    const { handler } = require(fn);
    const call = (photos) => handler({ httpMethod: 'POST', headers: { 'x-admin-key': process.env.ADMIN_SECRET },
      body: JSON.stringify({ product_slug: 'some-book', customer_name: 'SriMurli', rating: 5, comment: 'ok', photos }) });

    let res = await call([webp, webp]);
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(puts.length, 2);
    assert.deepEqual(inserted.photos, puts.map((k) => 'https://img.example/' + k));
    assert.equal(JSON.parse(res.body).photos.length, 2);

    res = await call(undefined);
    assert.equal(res.statusCode, 200);
    assert.equal('photos' in inserted, false, 'no photos → column not written (works before the SQL)');

    res = await call(['data:image/gif;base64,R0lGOD==']);
    assert.equal(res.statusCode, 400);

    insertError = { message: "Could not find the 'photos' column of 'product_reviews' in the schema cache" };
    res = await call([webp]);
    assert.equal(res.statusCode, 400);
    assert.match(JSON.parse(res.body).error, /product_reviews_photos\.sql/);
  } finally {
    [sbPath, r2Path, pcPath].forEach((p, i) => { if (saved[i]) require.cache[p] = saved[i]; else delete require.cache[p]; });
    delete require.cache[fn];
  }
});

test('parseVideo only accepts our own bucket videos/ URLs', () => {
  const B = 'https://img.example';
  assert.equal(P.parseVideo(undefined, B), null);
  assert.deepEqual(P.parseVideo({ url: B + '/videos/review-x-video-1.mp4', poster: B + '/videos/review-x-video-1-poster.webp' }, B),
    { url: B + '/videos/review-x-video-1.mp4', poster: B + '/videos/review-x-video-1-poster.webp' });
  assert.deepEqual(P.parseVideo({ url: B + '/videos/a.webm' }, B), { url: B + '/videos/a.webm', poster: '' });
  assert.throws(() => P.parseVideo({ url: 'https://evil.example/videos/a.mp4' }, B), /not recognised/);
  assert.throws(() => P.parseVideo({ url: B + '/reviews/a.mp4' }, B), /not recognised/);
  assert.throws(() => P.parseVideo({ url: B + '/videos/a.mp4', poster: 'https://evil.example/p.webp' }, B), /poster/);
  assert.throws(() => P.parseVideo({ url: B + '/videos/a.mp4' }, ''), /not configured/);
  assert.equal(P.isMissingPhotosColumn({ message: 'column product_reviews.video_url does not exist' }), true);
});
