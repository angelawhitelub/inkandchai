/**
 * Admin: admin-warehouse — the /admin/pick/ app (owner, 27 Nov 2026).
 *
 * The owner photographs the books that have arrived (a stack of spines, or one
 * book with a typed quantity). The photo is read by gpt-4o into titles and
 * copy counts, matched to the books waiting orders actually need, and after
 * the owner checks it, stored as the warehouse inventory. Then every order the
 * courier has not picked up is matched against that shelf (utils/warehouse-pick):
 * all books there → ready to print; some missing → flagged, printed only if
 * the owner says so. The labels themselves come from admin-order-label (bulk).
 *
 * Owner only. Stores in KV (catalog store), writes nothing to orders.
 *
 *   GET  ?action=state                     shelf + counts
 *   GET  ?action=match&dtdc=1              ready / flagged / not booked
 *   POST { action:'scan', images:[dataUrl], single?, qty? }  read a photo (saves nothing)
 *   POST { action:'add', items:[{title,qty}], mode:'add'|'set' }
 *   POST { action:'remove', title }  |  { action:'clear' }
 *   POST { action:'printed', orders:[{order_id, lines}], deduct:true }
 *   POST { action:'undo' }                  undo the last 'printed'
 *   POST { action:'reprint', order_ids:[] | all:true } let printed orders show again
 */

const { createClient } = require('@supabase/supabase-js');
const { requireAdmin } = require('./utils/admin-auth');
const { listNotPicked, REPORT_DAYS } = require('./utils/not-picked-up-list');
const wp = require('./utils/warehouse-pick');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key, X-Admin-Token',
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
};
const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });

const KEY_INV = 'warehouse:inventory';
const KEY_DONE = 'warehouse:printed';
const KEY_LAST = 'warehouse:last-print';
const DONE_DAYS = 30;
const MAX_IMAGES = 4;
const MAX_KNOWN = 700;

const store = () => require('@netlify/blobs').getStore('catalog');
const db = () => createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

async function readJSON(s, key, fallback) {
  const v = await s.get(key, { type: 'json' }).catch(() => null);
  return v && typeof v === 'object' ? v : fallback;
}
const readInv = async (s) => (await readJSON(s, KEY_INV, { items: {} })).items || {};
const writeInv = (s, items) => s.setJSON(KEY_INV, { items, updated_at: new Date().toISOString() });

async function readDone(s, now = Date.now()) {
  const d = (await readJSON(s, KEY_DONE, { orders: {} })).orders || {};
  const cut = now - DONE_DAYS * 864e5;
  for (const [k, at] of Object.entries(d)) if (Date.parse(at) < cut) delete d[k];
  return d;
}

async function waitingRows(now = Date.now()) {
  const { rows } = await listNotPicked(db(), { minHours: 0, days: REPORT_DAYS, now });
  return rows;
}

/** Titles waiting orders need, most-wanted first: the model picks from these. */
function knownTitles(rows) {
  const n = new Map();
  for (const r of rows) for (const i of r.items || []) n.set(i.title, (n.get(i.title) || 0) + i.qty);
  return [...n.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_KNOWN).map(([t]) => t);
}

const PROMPT = `You read photos taken in a small Indian bookshop's warehouse.
A photo shows either a stack or row of books (count the copies of each book by their spines) or one book's cover.
List every distinct book you can see. For each: the title as printed, the author if visible, the language if it is not English (e.g. Hindi, Urdu, Bengali, Roman Urdu), and how many copies of THAT book are in the photo.
You also get the list of titles customers are waiting for. When a book in the photo is one of them, copy that title EXACTLY into "known" (same language/edition only: a Hindi edition is not the English book). Otherwise "known" is null.
Never invent books you cannot see. If a spine is unreadable, add it with title "unreadable" so the owner knows.
Return JSON only: {"books":[{"title":"...","author":"...","language":"...","count":1,"known":"..."|null}]}`;

async function readPhotos(images, known, { fetchImpl = fetch, model = process.env.WAREHOUSE_VISION_MODEL || 'gpt-4o' } = {}) {
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is not set');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90000);
  try {
    const res = await fetchImpl('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: 2500,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: PROMPT },
          { role: 'user', content: [
            { type: 'text', text: `Titles customers are waiting for:\n${known.map((t) => '- ' + t).join('\n')}\n\n${images.length} photo(s) follow. Return the JSON.` },
            ...images.map((url) => ({ type: 'image_url', image_url: { url, detail: 'high' } })),
          ] },
        ],
      }),
      signal: controller.signal,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`OpenAI ${res.status}: ${(body.error && body.error.message) || 'request failed'}`);
    try { return JSON.parse((body.choices && body.choices[0] && body.choices[0].message && body.choices[0].message.content) || '{}'); }
    catch { throw new Error('Could not read the photo. Try a closer, sharper photo.'); }
  } finally {
    clearTimeout(timer);
  }
}

/** Model output → rows for the owner to check: our own title where we can find it. */
function scanRows(read, known, { single, qty } = {}) {
  const knownSet = new Set(known);
  const books = Array.isArray(read && read.books) ? read.books : [];
  return books.map((b) => {
    const seen = String(b.title || '').trim();
    const lang = String(b.language || '').trim();
    let match = null;
    if (b.known && knownSet.has(b.known)) match = { title: b.known, score: 1, by: 'photo' };
    if (!match && seen && seen.toLowerCase() !== 'unreadable') {
      const withLang = lang && !/english/i.test(lang) && !new RegExp(lang, 'i').test(seen) ? `${seen} (${lang})` : seen;
      const m = wp.bestMatch(withLang, known);
      if (m) match = { ...m, by: 'title' };
    }
    const count = single && qty ? Math.max(1, Math.round(Number(qty))) : Math.max(1, Math.round(Number(b.count) || 1));
    return { seen, author: String(b.author || '').trim(), language: lang, count, match, unreadable: !seen || /^unreadable$/i.test(seen) };
  });
}

async function handle(event, deps = {}) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  const blocked = requireAdmin(event, CORS);
  if (blocked) return blocked;
  const s = deps.store || store();
  const rowsFn = deps.waitingRows || waitingRows;
  const q = event.queryStringParameters || {};

  try {
    if (event.httpMethod === 'GET') {
      const inv = await readInv(s);
      if (q.action === 'match') {
        const done = await readDone(s);
        const out = wp.allocate(await rowsFn(), inv, { extracted: done, skipDtdc: q.dtdc !== '1' });
        const last = await readJSON(s, KEY_LAST, null);
        return json(200, { ok: true, ...out, printed_count: Object.keys(done).length, last_print: last ? { at: last.at, orders: (last.order_ids || []).length } : null });
      }
      const items = Object.values(inv).sort((a, b) => a.title.localeCompare(b.title));
      return json(200, { ok: true, inventory: items, books: items.reduce((n, i) => n + i.qty, 0) });
    }
    if (event.httpMethod !== 'POST') return json(405, { error: 'GET or POST' });

    let body;
    try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }
    const action = body.action;

    if (action === 'scan') {
      const images = (Array.isArray(body.images) ? body.images : []).filter((u) => /^data:image\/(jpeg|png|webp);base64,/.test(String(u))).slice(0, MAX_IMAGES);
      if (!images.length) return json(400, { error: 'Add a photo first' });
      const known = knownTitles(await rowsFn());
      const read = await (deps.readPhotos || readPhotos)(images, known);
      return json(200, { ok: true, books: scanRows(read, known, { single: !!body.single, qty: body.qty }), known_titles: known.length });
    }

    if (action === 'titles') {
      return json(200, { ok: true, titles: knownTitles(await rowsFn()) });
    }

    if (action === 'add') {
      const items = (Array.isArray(body.items) ? body.items : []).slice(0, 200);
      if (!items.length) return json(400, { error: 'Nothing to add' });
      const r = wp.applyToInventory(await readInv(s), items, { mode: body.mode === 'set' ? 'set' : 'add' });
      await writeInv(s, r.inventory);
      return json(200, { ok: true, changed: r.changed, books: Object.values(r.inventory).reduce((n, i) => n + i.qty, 0) });
    }

    if (action === 'remove') {
      const inv = await readInv(s);
      delete inv[wp.keyOf(body.title)];
      await writeInv(s, inv);
      return json(200, { ok: true });
    }

    if (action === 'clear') {
      if (body.confirm !== true) return json(400, { error: 'confirm:true required' });
      await writeInv(s, {});
      return json(200, { ok: true });
    }

    if (action === 'printed') {
      const orders = (Array.isArray(body.orders) ? body.orders : []).filter((o) => o && o.order_id).slice(0, 300);
      if (!orders.length) return json(400, { error: 'No orders' });
      const inv = await readInv(s);
      const done = await readDone(s);
      const at = new Date().toISOString();
      let taken = [];
      let after = inv;
      if (body.deduct !== false) ({ inventory: after, taken } = wp.deduct(inv, orders));
      for (const o of orders) done[o.order_id] = at;
      await s.setJSON(KEY_LAST, { at, order_ids: orders.map((o) => o.order_id), inventory_before: inv });
      await writeInv(s, after);
      await s.setJSON(KEY_DONE, { orders: done });
      return json(200, { ok: true, taken, books_left: Object.values(after).reduce((n, i) => n + i.qty, 0) });
    }

    if (action === 'undo') {
      const last = await readJSON(s, KEY_LAST, null);
      if (!last) return json(400, { error: 'Nothing to undo' });
      const done = await readDone(s);
      for (const id of last.order_ids || []) delete done[id];
      await writeInv(s, last.inventory_before || {});
      await s.setJSON(KEY_DONE, { orders: done });
      await s.delete(KEY_LAST).catch(() => {});
      return json(200, { ok: true, restored: (last.order_ids || []).length });
    }

    if (action === 'reprint') {
      const done = body.all === true ? {} : await readDone(s);
      for (const id of body.order_ids || []) delete done[id];
      await s.setJSON(KEY_DONE, { orders: done });
      return json(200, { ok: true });
    }

    return json(400, { error: 'Unknown action' });
  } catch (e) {
    console.error('[admin-warehouse]', e);
    return json(500, { error: e.message });
  }
}

exports.handler = (event) => handle(event);
exports._test = { handle, scanRows, knownTitles };
