/**
 * Netlify Function: admin-banners
 * GET  /.netlify/functions/admin-banners            -> every slot and its state
 * POST /.netlify/functions/admin-banners            -> { action: ... }
 *
 * Actions:
 *   publish     { fields, book_slugs, label }  create a live banner
 *   set_active  { slot, is_active }            show or hide any slot
 *   delete      { slot }                       remove a published banner
 *   reorder     { slots: [...] }               set the carousel order
 *
 * Built-in slides can be hidden but never deleted: their markup ships in the
 * build, so a delete would simply come back on the next deploy. Hiding writes a
 * row saying so, which is what the homepage reads.
 *
 * FIELDS, NOT HTML
 * ----------------
 * publish stores the text fields and the book slugs. It never stores rendered
 * markup, so nothing typed into the admin is ever replayed onto the homepage as
 * live HTML -- site-banners re-renders through the shared escaper on read.
 */

'use strict';

const { createClient } = require('@supabase/supabase-js');
const { requireAdmin } = require('./utils/admin-auth');
const { BUILTIN_SLOTS, isBuiltin } = require('./utils/banner-slots');
const { purgeUrls } = require('./utils/purge-cache');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key, X-Admin-Token',
  'Content-Type': 'application/json',
};
const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });

// Every write here changes what site-banners serves, and that response is now
// edge-cached -- so without this a published or hidden banner would sit behind
// a stale cache entry and look like it had not worked.
const SITE = (process.env.SITE_URL || 'https://inkandchai.in').replace(/\/+$/, '');
const purgeBanners = async () => {
  const r = await purgeUrls([`${SITE}/.netlify/functions/site-banners`, `${SITE}/`])
    .catch(e => ({ purged: false, reason: e.message }));
  // The reason travels with it. A bare `false` is undiagnosable, and this is
  // the difference between "published, live now" and "published, live in ten
  // minutes" -- which the admin needs to be told.
  if (!r.purged) console.warn('[admin-banners] cache not purged:', r.reason);
  return r;
};

const one = (v, max = 200) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);

// The only keys a slide is rendered from. Anything else in the posted object is
// dropped rather than stored, so the row cannot accumulate whatever the admin
// page happens to be holding.
const FIELD_KEYS = [
  'eyebrow', 'title_line1', 'title_accent', 'title_line3', 'subtitle',
  'cta_label', 'cta_href', 'cta_secondary', 'cta_secondary_href', 'price_label',
];

function cleanFields(raw) {
  const f = {};
  for (const k of FIELD_KEYS) f[k] = one(raw?.[k], k === 'subtitle' ? 400 : 120);
  f.stats = (Array.isArray(raw?.stats) ? raw.stats : []).slice(0, 3)
    .map(s => ({ num: one(s?.num, 24), label: one(s?.label, 40) }))
    .filter(s => s.num || s.label);
  return f;
}

// Only ever site-relative, so a banner cannot send the homepage's biggest link
// to somewhere else entirely.
const safeHref = (href, fallback) => {
  const h = one(href, 300);
  return /^\/[^/\\]/.test(h) || h === '/' ? h : fallback;
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  const block = requireAdmin(event, CORS); if (block) return block;

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return json(500, { error: 'Supabase is not configured on this deploy.' });
  }
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const readRows = async () => {
    const { data, error } = await supabase
      .from('site_banners')
      .select('slot,kind,label,is_active,sort_order,fields,book_slugs,updated_at')
      .order('sort_order', { ascending: true });
    if (error) throw error;
    return data || [];
  };

  // ── list ────────────────────────────────────────────────────────────────
  if (event.httpMethod === 'GET') {
    let rows;
    try { rows = await readRows(); }
    catch (e) {
      // The most likely cause by far is the migration not having been run.
      return json(500, { error: e.message, needs_migration: /site_banners/.test(e.message || '') });
    }
    const bySlot = new Map(rows.map(r => [r.slot, r]));
    // Built-ins are listed whether or not a row exists: no row means showing.
    const builtins = BUILTIN_SLOTS.map(b => ({
      slot: b.slot, label: b.label, note: b.note, kind: 'builtin',
      is_active: bySlot.get(b.slot)?.is_active !== false,
      sort_order: bySlot.get(b.slot)?.sort_order ?? 0,
    }));
    const published = rows.filter(r => r.kind === 'custom').map(r => ({
      slot: r.slot, label: r.label || r.fields?.eyebrow || 'Untitled banner', kind: 'custom',
      is_active: r.is_active !== false, sort_order: r.sort_order ?? 100,
      book_slugs: r.book_slugs || [], updated_at: r.updated_at,
    }));
    return json(200, { builtins, published });
  }

  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: 'Method Not Allowed' };

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }
  const action = one(body.action, 20);

  try {
    if (action === 'publish') {
      const slugs = (Array.isArray(body.book_slugs) ? body.book_slugs : [])
        .map(s => one(s, 200)).filter(Boolean).slice(0, 6);
      if (!slugs.length) return json(400, { error: 'A banner needs at least one book.' });

      const fields = cleanFields(body.fields);
      if (!fields.title_line1 && !fields.title_accent) {
        return json(400, { error: 'Draft the copy first — the headline is empty.' });
      }
      fields.cta_href = safeHref(fields.cta_href, '/bestsellers/');
      fields.cta_secondary_href = safeHref(fields.cta_secondary_href, '/bestsellers/');

      const slot = 'custom:' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
      const { error } = await supabase.from('site_banners').insert({
        slot, kind: 'custom', is_active: true, sort_order: 50,
        label: one(body.label, 120) || fields.eyebrow || 'Banner',
        fields, book_slugs: slugs,
      });
      if (error) throw error;
      const purge = await purgeBanners();
      return json(200, { published: true, slot, cache_purged: purge.purged === true, cache_purge_reason: purge.reason || null });
    }

    if (action === 'set_active') {
      const slot = one(body.slot, 120);
      if (!slot) return json(400, { error: 'Which banner?' });
      const isActive = body.is_active !== false;

      if (isBuiltin(slot)) {
        // A built-in has no row until it is first hidden, so this has to upsert.
        const { error } = await supabase.from('site_banners')
          .upsert({ slot, kind: 'builtin', is_active: isActive, label: slot, updated_at: new Date().toISOString() },
                  { onConflict: 'slot' });
        if (error) throw error;
        const purge = await purgeBanners();
        return json(200, { slot, is_active: isActive, cache_purged: purge.purged === true, cache_purge_reason: purge.reason || null });
      }
      const { error } = await supabase.from('site_banners')
        .update({ is_active: isActive, updated_at: new Date().toISOString() }).eq('slot', slot);
      if (error) throw error;
      const purged = await purgeBanners();
      return json(200, { slot, is_active: isActive, cache_purged: purged.purged === true, cache_purge_reason: purged.reason || null });
    }

    if (action === 'delete') {
      const slot = one(body.slot, 120);
      if (!slot) return json(400, { error: 'Which banner?' });
      if (isBuiltin(slot)) {
        return json(400, {
          error: 'A built-in slide cannot be deleted here — its markup is in the build and would return on the next deploy. Hide it instead.',
        });
      }
      const { error } = await supabase.from('site_banners').delete().eq('slot', slot).eq('kind', 'custom');
      if (error) throw error;
      const purge = await purgeBanners();
      return json(200, { deleted: slot, cache_purged: purge.purged === true, cache_purge_reason: purge.reason || null });
    }

    if (action === 'reorder') {
      const slots = (Array.isArray(body.slots) ? body.slots : []).map(s => one(s, 120)).filter(Boolean).slice(0, 40);
      if (!slots.length) return json(400, { error: 'Nothing to reorder.' });
      for (let i = 0; i < slots.length; i++) {
        const slot = slots[i];
        const patch = { sort_order: i * 10, updated_at: new Date().toISOString() };
        if (isBuiltin(slot)) {
          await supabase.from('site_banners')
            .upsert({ slot, kind: 'builtin', is_active: true, label: slot, ...patch }, { onConflict: 'slot' });
        } else {
          await supabase.from('site_banners').update(patch).eq('slot', slot);
        }
      }
      const purge = await purgeBanners();
      return json(200, { reordered: slots.length, cache_purged: purge.purged === true, cache_purge_reason: purge.reason || null });
    }

    return json(400, { error: `Unknown action "${action}".` });
  } catch (e) {
    console.error('[admin-banners]', action, e.message);
    return json(500, { error: e.message, needs_migration: /site_banners/.test(e.message || '') });
  }
};
