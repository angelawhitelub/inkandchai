/**
 * The live site must match main, and must say which commit it is.
 *
 * Production was once replaced by a hand-made `netlify deploy` from a laptop
 * checkout on an old branch. It carried no commit reference, so the Netlify
 * dashboard showed a normal green deploy while weeks of work had rolled back —
 * the admin panel lost whole tabs and checkout lost WhatsApp consent capture,
 * unnoticed for a day. These tests pin the two things that make that loud.
 */
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '../..');
const gen = fs.readFileSync(path.join(root, 'generate_site.py'), 'utf8');
const toml = fs.readFileSync(path.join(root, 'netlify.toml'), 'utf8');
const fn = fs.readFileSync(path.join(root, 'netlify/functions/deploy-drift-check.js'), 'utf8');

test('every build stamps the commit it was built from', () => {
  assert.match(gen, /public" \/ "build-info\.json/);
  assert.match(gen, /"commit": os\.environ\.get\("COMMIT_REF", ""\)/);
  assert.match(gen, /"branch": os\.environ\.get\("BRANCH", ""\)/);
  // A local run stamps context "local", which is itself the signal that a
  // deploy did not come from CI.
  assert.match(gen, /os\.environ\.get\("CONTEXT", "local"\)/);
});

test('the check reads what is served, not what CI believed it built', () => {
  // The Netlify API would have reported the bad deploy as a healthy one.
  assert.match(fn, /\$\{SITE\}\/build-info\.json\?_=\$\{Date\.now\(\)\}/);
  assert.match(fn, /api\.github\.com\/repos\/\$\{REPO\}\/commits\/\$\{BRANCH\}/);
});

test('an unstamped deploy is treated as drift, not as healthy', () => {
  // The deploy that caused this had no stamp at all. Silence on a missing
  // stamp would make the whole check useless against the exact failure it
  // exists for.
  assert.match(fn, /if \(!live\) \{\s*\n\s*problems\.push/);
  assert.match(fn, /no build stamp/);
  assert.match(fn, /Live carries a build stamp with no commit/);
});

test('a check that cannot run reports healthy rather than crying wolf', () => {
  // GitHub rate limits and transient 5xx must not page anyone hourly.
  assert.match(fn, /return report\(true, \{ skipped: err\.message \}\);/);
});

test('a push still deploying is not reported as drift', () => {
  assert.match(fn, /GRACE_MINUTES/);
  assert.match(fn, /pushedAgo > GRACE_MINUTES/);
});

test('the check actually runs on a schedule', () => {
  assert.match(toml, /\[functions\."deploy-drift-check"\]\s*\n\s*schedule = "@hourly"/);
});
