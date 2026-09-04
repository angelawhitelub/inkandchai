/**
 * Minimal `fs` stand-in for the Workers runtime.
 *
 * Every fs call in netlify/functions reads one of three build-time JSON data
 * files through a list of candidate paths (process.cwd(), __dirname/../.., and
 * /var/task). None of those exist on Workers, so rather than rewrite fifteen
 * handlers we alias `fs` to this module and resolve by basename against the
 * bundled JSON. Aliased in wrangler.toml.
 *
 * Anything outside that set behaves as "not found", which is what the callers
 * already handle — they all fall back to an empty catalogue.
 */
const ALL_BOOKS = require('../../data/ALL_BOOKS.json');
const FBT_SIGNALS = require('../../data/fbt-signals.json');
const SOCIAL_PROOF = require('../../data/social_proof.json');
const CATALOG_INDEX = require('../../data/catalog-index.json');

const FILES = {
  'ALL_BOOKS.json': ALL_BOOKS,
  'fbt-signals.json': FBT_SIGNALS,
  'social_proof.json': SOCIAL_PROOF,
  'catalog-index.json': CATALOG_INDEX,
};

function basename(p) {
  const s = String(p || '');
  const i = s.lastIndexOf('/');
  return i === -1 ? s : s.slice(i + 1);
}

function lookup(p) {
  return Object.prototype.hasOwnProperty.call(FILES, basename(p)) ? FILES[basename(p)] : undefined;
}

function existsSync(p) {
  return lookup(p) !== undefined;
}

// Callers immediately JSON.parse the result, so hand back a string. Stringify
// once per file and cache it: these are megabytes and the handlers call this
// on every cold start.
const _serialised = new Map();
function readFileSync(p, _enc) {
  const data = lookup(p);
  if (data === undefined) {
    const err = new Error(`ENOENT: no such file or directory, open '${p}'`);
    err.code = 'ENOENT';
    throw err;
  }
  const key = basename(p);
  if (!_serialised.has(key)) _serialised.set(key, JSON.stringify(data));
  return _serialised.get(key);
}

const promises = {
  readFile: async (p, enc) => readFileSync(p, enc),
  access: async (p) => { if (!existsSync(p)) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; } },
};

// Writes have nowhere to go in an isolate; no caller depends on the result.
function writeFileSync() {}
function mkdirSync() {}
function readdirSync() { return []; }
function statSync(p) { if (!existsSync(p)) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; } return { isFile: () => true, isDirectory: () => false }; }

module.exports = {
  existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, promises,
  default: { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, promises },
};
