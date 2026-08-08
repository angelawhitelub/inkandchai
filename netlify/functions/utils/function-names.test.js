const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

/**
 * Netlify derives a function name from every top-level entry in
 * netlify/functions/ — `foo.js` becomes the function "foo". Names may contain
 * only alphanumerics, hyphens and underscores, and an illegal one fails the
 * deploy for the WHOLE SITE, not just that function:
 *
 *   "Incorrect function names. Name should consist of only alphanumeric
 *    characters, hyphen & underscores"
 *
 * That is exactly what a top-level `upload-product-video.test.js` did — the dot
 * made the name "upload-product-video.test" — and it silently blocked two
 * production deploys. It is why every test in this repo lives in utils/ instead
 * of beside the function it covers: subdirectories without a matching entry file
 * are not treated as functions.
 *
 * This runs with the rest of the suite so the mistake is caught locally instead
 * of by a failed build.
 */
const FUNCTIONS_DIR = path.resolve(__dirname, '..');
const CODE_EXT = /\.(js|mjs|cjs|ts)$/;
const LEGAL_NAME = /^[A-Za-z0-9_-]+$/;

test('every top-level entry produces a legal Netlify function name', () => {
  const illegal = [];
  for (const entry of fs.readdirSync(FUNCTIONS_DIR, { withFileTypes: true })) {
    let name;
    if (entry.isFile()) {
      if (!CODE_EXT.test(entry.name)) continue;      // image-map.json and friends
      name = entry.name.replace(CODE_EXT, '');
    } else if (entry.isDirectory()) {
      name = entry.name;
    } else {
      continue;
    }
    if (!LEGAL_NAME.test(name)) illegal.push(`${entry.name} → "${name}"`);
  }
  assert.deepEqual(illegal, [],
    `These would fail the Netlify build for the entire site. Move tests into utils/:\n  ${illegal.join('\n  ')}`);
});

test('no test file sits at the top level of the functions directory', () => {
  // The specific shape of the mistake above — worth naming so the failure
  // message points straight at the fix rather than at the naming rule.
  const strays = fs.readdirSync(FUNCTIONS_DIR)
    .filter(name => /\.test\.(js|mjs|cjs|ts)$/.test(name));
  assert.deepEqual(strays, [],
    `Tests must live in netlify/functions/utils/, not beside the function: ${strays.join(', ')}`);
});
