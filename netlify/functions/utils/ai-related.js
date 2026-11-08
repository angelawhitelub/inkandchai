/**
 * AI book similarity for "You may also like".
 *
 * Every active book (baked catalogue + admin-added) is turned into a 256-number
 * "meaning" vector by OpenAI text-embedding-3-small, from its title, author,
 * category, tags and the start of its description. Two books about the same
 * kind of thing get vectors that point the same way, even when they share no
 * words -- "Before the Coffee Gets Cold" lands next to other quiet Japanese
 * fiction, not next to "A Cold Season".
 *
 * Stored in KV (catalog:ai-emb-meta + catalog:ai-emb-vec) as int8, ~9 MB for
 * 35k books. ai-related-scheduled refreshes it nightly and only embeds books
 * whose text changed, so a normal night costs a fraction of a cent.
 * frequently-bought.js loads it once per isolate and, for the book being
 * viewed, scores every other book in ~10 ms.
 */
const crypto = require('crypto');

const MODEL = 'text-embedding-3-small';
const DIMS = 256;
const STORE = 'catalog';
const META_KEY = 'ai-emb-meta';
const VEC_KEY = 'ai-emb-vec';

function stripHtml(s) {
  return String(s || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Shop buckets say nothing about the book.
const BUCKET_CAT = /preloved|on sale|combo|boxset|box set|deals?|offers?|clearance|special|new arrivals|bestsellers?|trending/i;

/** The text a book is embedded from. Short and about the book, not the shop. */
function textFor(p) {
  const title = String(p.title || '').replace(/#\w+/g, '').replace(/\s+/g, ' ').trim();
  const author = String(p.author || '').trim();
  const cat = String(p.category || '').trim();
  const tags = String(p.tags || '').split(/[,|]/).map((t) => t.trim())
    .filter((t) => t && !/\d/.test(t) && t.length < 40).slice(0, 12).join(', ');
  const desc = stripHtml(p.description).slice(0, 700);
  return [
    title,
    author && !/^various$/i.test(author) ? `by ${author}` : '',
    cat && !BUCKET_CAT.test(cat) ? `Category: ${cat}` : '',
    tags ? `Tags: ${tags}` : '',
    desc,
  ].filter(Boolean).join('\n');
}

function hashText(s) {
  return crypto.createHash('sha1').update(String(s), 'utf8').digest('hex').slice(0, 12);
}

/** float vector -> int8, scaled per vector (cosine does not care about scale). */
function quantize(vec, out, offset) {
  let max = 0;
  for (let i = 0; i < vec.length; i++) { const a = Math.abs(vec[i]); if (a > max) max = a; }
  const k = max > 0 ? 127 / max : 0;
  for (let i = 0; i < vec.length; i++) out[offset + i] = Math.max(-127, Math.min(127, Math.round(vec[i] * k)));
}

function toBase64(int8) {
  return Buffer.from(int8.buffer, int8.byteOffset, int8.byteLength).toString('base64');
}

function fromBase64(b64) {
  const buf = Buffer.from(String(b64 || ''), 'base64');
  return new Int8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

/** OpenAI returns base64 float32 when asked; much cheaper to parse than JSON floats. */
function decodeFloat32(b64) {
  const buf = Buffer.from(b64, 'base64');
  const copy = new ArrayBuffer(buf.byteLength);
  new Uint8Array(copy).set(buf);
  return new Float32Array(copy);
}

/** Build a searchable index from stored meta + int8 vectors. */
function buildIndex(meta, vec) {
  const n = meta && Array.isArray(meta.slugs) ? meta.slugs.length : 0;
  const dims = (meta && meta.dims) || DIMS;
  if (!n || !vec || vec.length !== n * dims) return null;
  const norms = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    const o = i * dims;
    for (let d = 0; d < dims; d++) s += vec[o + d] * vec[o + d];
    norms[i] = Math.sqrt(s) || 1;
  }
  const pos = new Map();
  meta.slugs.forEach((slug, i) => pos.set(slug, i));
  return { n, dims, vec, norms, pos, slugs: meta.slugs, updatedAt: meta.updated_at || null };
}

/**
 * The `k` books nearest in meaning to `slug` (any of its aliases), best first,
 * as [{ slug, sim }] with sim the cosine similarity (-1..1).
 */
function neighbours(index, slugs, k = 80, minSim = 0.3) {
  if (!index) return [];
  let i = -1;
  for (const s of [].concat(slugs || [])) { if (index.pos.has(s)) { i = index.pos.get(s); break; } }
  if (i < 0) return [];
  const { n, dims, vec, norms } = index;
  const base = i * dims;
  const top = []; // small sorted list, ascending by sim
  for (let j = 0; j < n; j++) {
    if (j === i) continue;
    const o = j * dims;
    let dot = 0;
    for (let d = 0; d < dims; d++) dot += vec[base + d] * vec[o + d];
    const sim = dot / (norms[i] * norms[j]);
    if (sim < minSim) continue;
    if (top.length < k) { top.push([sim, j]); if (top.length === k) top.sort((a, b) => a[0] - b[0]); continue; }
    if (sim <= top[0][0]) continue;
    top[0] = [sim, j];
    // restore ascending order (one bubble pass from the front)
    for (let x = 0; x < k - 1 && top[x][0] > top[x + 1][0]; x++) { const t = top[x]; top[x] = top[x + 1]; top[x + 1] = t; }
  }
  return top.sort((a, b) => b[0] - a[0]).map(([sim, j]) => ({ slug: index.slugs[j], sim: Math.round(sim * 1000) / 1000 }));
}

/**
 * Score bonus for "You may also like" from an AI similarity, by rank among this
 * book's neighbours and by how close it is. The nearest few are near-certain
 * matches; by rank 80 it is a nudge.
 */
function aiBonus(sim, rank) {
  if (!(sim > 0)) return 0;
  const closeness = Math.max(0, Math.min(1, (sim - 0.3) / 0.4)); // 0.3 -> 0, 0.7 -> 1
  const rankFactor = 1 - Math.min(rank, 80) / 100;               // 1 .. 0.2
  return Math.round(320 * closeness * rankFactor);
}

module.exports = {
  MODEL, DIMS, STORE, META_KEY, VEC_KEY,
  textFor, hashText, quantize, toBase64, fromBase64, decodeFloat32, buildIndex, neighbours, aiBonus, stripHtml,
};
