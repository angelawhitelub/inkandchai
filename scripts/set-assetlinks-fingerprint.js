#!/usr/bin/env node
/**
 * Write the Play app-signing certificate into public/.well-known/assetlinks.json.
 *
 *   node scripts/set-assetlinks-fingerprint.js A1:B2:...:FF
 *
 * Get the value from Play Console → your app → Test and release → Setup →
 * App integrity → App signing key certificate → SHA-256 certificate fingerprint.
 *
 * It has to be the APP SIGNING key, not the upload key. Play re-signs every
 * build with its own key, so the certificate that reaches a phone is Google's.
 * Publishing the upload key's fingerprint is the usual reason a TWA installs
 * fine and then opens with a browser address bar across the top.
 */
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'public', '.well-known', 'assetlinks.json');
const raw = (process.argv[2] || '').trim().toUpperCase();

if (!/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(raw)) {
  console.error('Expected a SHA-256 fingerprint: 32 hex pairs separated by colons.');
  console.error('Got: ' + (raw || '(nothing)'));
  process.exit(1);
}

const doc = JSON.parse(fs.readFileSync(FILE, 'utf8'));
doc[0].target.sha256_cert_fingerprints = [raw];
fs.writeFileSync(FILE, JSON.stringify(doc, null, 2) + '\n');

console.log('Wrote ' + doc[0].target.package_name + ' → ' + raw);
console.log('\nNow deploy, then confirm Google can read it:');
console.log('  npm run deploy');
console.log('  curl -s https://inkandchai.in/.well-known/assetlinks.json');
console.log('  open "https://developers.google.com/digital-asset-links/tools/generator"');
