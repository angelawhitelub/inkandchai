const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(
  path.join(__dirname, '../../netlify/functions/bot-inbox.js'),
  'utf8',
);

test('thread query limits the newest messages, not the oldest messages', () => {
  assert.match(
    source,
    /\.order\('created_at', \{ ascending: false \}\)\s*\.limit\(200\)/,
  );
});

test('thread response restores chronological display order', () => {
  assert.match(source, /messages: \(data \|\| \[\]\)\.reverse\(\)/);
});
