/**
 * Netlify Function: admin-ebook-upload-url  (admin only)
 * POST { slug, content_type, size_bytes } → { key, upload_url, expires_in }
 *
 * Hands the admin browser a URL it can PUT one PDF to, straight into the
 * PRIVATE eBook bucket.
 *
 * WHY PRESIGNED RATHER THAN POSTING THE FILE HERE
 * A function body is capped at ~6 MB and base64 inflates a file by a third, so
 * anything past ~4 MB could not even arrive. Ebooks are routinely 5-50 MB. The
 * same reasoning as sign-product-video-upload.js, which this mirrors.
 *
 * The credentials never reach the browser: the signature is good for one key,
 * one method, one content type, and ten minutes.
 */

const crypto = require('crypto');
const { requireAdmin } = require('./utils/admin-auth');
const { r2PresignPut, r2EbookConfig, r2EbookConfigured } = require('./utils/r2-put');
const { normaliseSlug, validatePdfUpload, ebookKey } = require('./utils/ebook');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key, X-Admin-Token',
  'Content-Type': 'application/json',
};
const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  const block = requireAdmin(event);
  if (block) return block;
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

  if (!r2EbookConfigured()) {
    return json(503, { error: 'R2 is not configured — set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY.' });
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: 'Invalid JSON' }); }

  const slug = normaliseSlug(body.slug);
  if (!slug) return json(400, { error: 'Pick a book first.' });

  const check = validatePdfUpload({ contentType: body.content_type, sizeBytes: body.size_bytes });
  if (!check.ok) return json(400, { error: check.error });

  // A fresh random key every upload, so replacing a PDF never overwrites the
  // one customers who already paid are still downloading.
  const key = ebookKey(slug, crypto.randomBytes(16).toString('hex'));

  try {
    const { uploadUrl } = r2PresignPut(
      { ...r2EbookConfig(), publicBase: 'https://private.invalid' },  // see note below
      { key, contentType: 'application/pdf', expiresIn: 600 },
    );
    // r2PresignPut also returns a publicUrl built from publicBase. This bucket
    // HAS no public base, so a placeholder is passed to satisfy its guard and
    // the returned publicUrl is deliberately discarded — publishing it is the
    // one thing that would make the whole feature pointless.
    return json(200, { key, upload_url: uploadUrl, expires_in: 600 });
  } catch (e) {
    console.error('[admin-ebook-upload-url]', e.message);
    return json(500, { error: e.message });
  }
};
