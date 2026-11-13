/**
 * Netlify Function: admin-update-review   (admin only)
 * POST /.netlify/functions/admin-update-review
 *
 * Edit an existing review from the admin Reviews tab: name, rating, text,
 * date, Verified Buyer, approval, photos and video.
 *
 * Body: {
 *   review_id,                       required
 *   customer_name?, rating?, comment?, created_at?, verified_buyer?, approved?,
 *   photos?: [ existing https URL | new data URL ]   final list, ≤ 4, in order.
 *            Existing URLs must already be on this review; new data URLs are
 *            uploaded like add-review's. Omit to leave photos as they are.
 *   video?:  undefined = keep, null = remove, {url, poster} = replace
 *            (uploaded first through sign-product-video-upload).
 * }
 */

const { createClient } = require('@supabase/supabase-js');
const { purgeCacheTags, TAGS } = require('./utils/purge-cache');
const { requireAdmin } = require('./utils/admin-auth');
const RP = require('./utils/review-photos');
const { r2PutObject, r2Config, r2Configured } = require('./utils/r2-put');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key, X-Admin-Token',
  'Content-Type': 'application/json',
};
const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });

/**
 * Split the requested photo list into kept URLs and new uploads, refusing any
 * URL that is not already on the review (so an edit cannot point a review at
 * an arbitrary image). Returns { order: [{keep:url}|{add:index}], add: parsed[] }.
 */
function planPhotos(list, existing) {
  if (!Array.isArray(list)) throw new Error('photos must be a list');
  if (list.length > RP.MAX_PHOTOS) throw new Error(`At most ${RP.MAX_PHOTOS} photos per review`);
  const have = new Set(RP.cleanPhotoUrls(existing));
  const order = [];
  const fresh = [];
  for (const item of list) {
    const s = String(item || '');
    if (s.startsWith('data:')) { order.push({ add: fresh.length }); fresh.push(s); }
    else if (have.has(s)) order.push({ keep: s });
    else throw new Error('A photo on this review was not recognised — reload and try again');
  }
  return { order, add: RP.parsePhotos(fresh) };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });
  const block = requireAdmin(event, CORS); if (block) return block;

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Bad JSON' }); }
  const id = String(body.review_id || '').trim();
  if (!/^[0-9a-f-]{36}$/i.test(id)) return json(400, { error: 'review_id is required' });

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  try {
    const { data: row, error: readErr } = await supabase
      .from('product_reviews').select('*').eq('id', id).maybeSingle();
    if (readErr) throw readErr;
    if (!row) return json(404, { error: 'Review not found — it may have been deleted' });

    const patch = {};
    if ('customer_name' in body) {
      const n = String(body.customer_name || '').trim().slice(0, 80);
      if (!n) return json(400, { error: 'Customer name cannot be empty' });
      patch.customer_name = n;
    }
    if ('rating' in body) {
      const r = parseInt(body.rating, 10);
      if (!(r >= 1 && r <= 5)) return json(400, { error: 'rating must be 1–5' });
      patch.rating = r;
    }
    if ('comment' in body) patch.comment = String(body.comment || '').trim().slice(0, 1000);
    if ('verified_buyer' in body) patch.verified_buyer = !!body.verified_buyer;
    if ('approved' in body) patch.approved = !!body.approved;
    if (body.created_at) {
      const d = new Date(String(body.created_at));
      if (isNaN(d.getTime()) || d.getTime() > Date.now()) return json(400, { error: 'Review date must be today or earlier' });
      patch.created_at = d.toISOString();
    }

    let plan = null;
    if ('photos' in body) {
      try { plan = planPhotos(body.photos, row.photos); }
      catch (e) { return json(400, { error: e.message }); }
      if (plan.add.length && !r2Configured()) return json(500, { error: 'Photo storage (R2) is not configured' });
    }
    if ('video' in body) {
      if (body.video === null) { patch.video_url = null; patch.video_poster = null; }
      else {
        let v;
        try { v = RP.parseVideo(body.video, r2Configured() ? r2Config().publicBase : ''); }
        catch (e) { return json(400, { error: e.message }); }
        if (v) { patch.video_url = v.url; patch.video_poster = v.poster || null; }
      }
    }

    if (plan) {
      const urls = plan.add.length
        ? await RP.uploadPhotos(row.product_slug, plan.add, {
            put: (key, buf, type) => r2PutObject(r2Config(), { key, body: buf, contentType: type }),
          })
        : [];
      patch.photos = plan.order.map((o) => (o.keep ? o.keep : urls[o.add]));
    }

    if (!Object.keys(patch).length) return json(200, { success: true, unchanged: true });

    const { data, error } = await supabase
      .from('product_reviews').update(patch).eq('id', id).select('*').single();
    if (error) {
      if (RP.isMissingPhotosColumn(error)) {
        return json(400, { error: 'Photos and videos need one SQL step first (sql/product_reviews_photos.sql).' });
      }
      throw error;
    }
    await purgeCacheTags([TAGS.REVIEWS]);
    return json(200, { success: true, review: data });
  } catch (err) {
    console.error('[admin-update-review]', err.message);
    return json(500, { error: err.message });
  }
};

exports._test = { planPhotos };
