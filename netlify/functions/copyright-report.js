/**
 * Netlify Function: copyright-report   (public)
 * POST /.netlify/functions/copyright-report
 *   { name, email, phone?, organisation?, role: 'owner'|'agent', product_url,
 *     work, original_url?, details, good_faith, accurate, signature,
 *     images?: [{ name, data: base64 }] (≤ 3, ≤ 3 MB each), website (honeypot) }
 *   → { ok: true, ref }
 *
 * The /copyright/ form, linked from every product page. Each report is saved
 * to Supabase (sql/copyright_reports.sql), its images to the private R2 bucket
 * under copyright/<ref>/, and emailed to the owner with the images attached.
 * The reporter gets a receipt with the reference. The owner's address comes
 * from env (STORE_OWNER_EMAIL, else the support-ticket address) and never
 * appears in a response or a page.
 *
 * If Supabase cannot take the row the owner email still goes (marked "not
 * saved"); if neither works the person is asked to try again.
 */

const { createClient } = require('@supabase/supabase-js');
const { ALLOWED_ORIGINS } = require('./ink-ai');
const C = require('./utils/copyright-report');
const D = require('./utils/support-ticket-deps');
const T = require('./utils/support-ticket');

const PER_IP_PER_DAY = 5;

const headers = (origin) => ({
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
  'Access-Control-Allow-Origin': origin || ALLOWED_ORIGINS[0],
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
});

function realDeps(env = process.env) {
  const { r2PutObject, r2EbookConfig, r2EbookConfigured } = require('./utils/r2-put');
  return {
    db: env.SUPABASE_URL && env.SUPABASE_SERVICE_KEY ? createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY) : null,
    sendEmail: (m) => require('./utils/email').sendEmail(m),
    ownerEmail: String(env.STORE_OWNER_EMAIL || '').trim() || T.ownerEmail(env),
    putImage: r2EbookConfigured(env)
      ? (key, buf, type) => r2PutObject({ ...r2EbookConfig(env), publicBase: 'https://private.invalid' }, { key, body: buf, contentType: type })
      : null,
    now: () => new Date(),
  };
}

async function handle(event, injected) {
  const origin = event.headers?.origin || event.headers?.Origin || '';
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : '';
  const reply = (status, body) => ({ statusCode: status, headers: headers(allowed), body: JSON.stringify(body) });
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: headers(allowed), body: '' };
  if (event.httpMethod !== 'POST') return reply(405, { ok: false, error: 'Method Not Allowed' });
  if (origin && !allowed) return reply(403, { ok: false, error: 'Forbidden' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return reply(400, { ok: false, error: 'Something went wrong. Please try again.' }); }
  const deps = injected || realDeps();

  // Honeypot: a bot gets a convincing success and nothing is created.
  if (String(body.website || '').trim()) return reply(200, { ok: true, ref: C.newRef(deps.now()) });

  const ip = String(event.headers?.['cf-connecting-ip'] || event.headers?.['x-nf-client-connection-ip'] || event.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
  if (!injected && ip && D.throttled(ip)) return reply(429, { ok: false, error: 'Too many attempts. Please try again in a few minutes.' });
  const ipHash = ip ? D.ipHash(ip) : null;

  const parsed = C.parseReport(body);
  if (!parsed.ok) return reply(400, { ok: false, field: parsed.field, error: parsed.error });
  const { report: r, images } = parsed;

  if (deps.db && ipHash) {
    const since = new Date(deps.now().getTime() - 86400000).toISOString();
    const { count, error } = await deps.db.from('copyright_reports').select('id', { count: 'exact', head: true }).eq('source_ip_hash', ipHash).gte('created_at', since);
    if (!error && count >= PER_IP_PER_DAY) return reply(429, { ok: false, error: 'You have sent several reports today. Please wait a day, or include everything in one report.' });
  }

  const ref = C.newRef(deps.now());
  const imageKeys = [];
  if (deps.putImage) {
    for (const [i, img] of images.entries()) {
      const key = `copyright/${ref}/${i + 1}.${img.ext}`;
      try { await deps.putImage(key, img.buf, img.type); imageKeys.push(key); }
      catch (e) { console.warn('[copyright-report] image upload:', e.message); }
    }
  }

  let saved = false;
  if (deps.db) {
    const { error } = await deps.db.from('copyright_reports').insert({
      ref, status: 'new',
      product_url: r.product_url, product_slug: r.product_slug,
      reporter_name: r.name, reporter_email: r.email, reporter_phone: r.phone || null, organisation: r.organisation || null,
      role: r.role, work_description: r.work, original_url: r.original_url || null, details: r.details,
      good_faith: r.good_faith, accurate: r.accurate, signature: r.signature,
      image_keys: imageKeys, image_count: images.length,
      source_ip_hash: ipHash, user_agent: String(event.headers?.['user-agent'] || '').slice(0, 300) || null,
    });
    if (error) console.error('[copyright-report] insert:', error.message);
    else saved = true;
  }

  let mailed = false;
  try {
    const res = await deps.sendEmail({
      to: deps.ownerEmail,
      subject: `©️ Copyright report ${ref} — /product/${r.product_slug}/`,
      html: C.ownerEmailHtml(ref, r, { saved, imageCount: images.length }),
      attachments: images.map((img, i) => ({ filename: `${ref}-${i + 1}.${img.ext}`, contentType: img.type, content: img.buf })),
    });
    mailed = !!(res && res.ok !== false);
  } catch (e) { console.error('[copyright-report] owner email:', e.message); }

  if (!saved && !mailed) return reply(503, { ok: false, error: 'We could not record your report just now. Please try again in a few minutes.' });

  try {
    await deps.sendEmail({ to: r.email, subject: `We received your copyright report (${ref})`, html: C.reporterEmailHtml(ref, r) });
  } catch (e) { console.warn('[copyright-report] receipt:', e.message); }

  console.log(`[copyright-report] ${ref} /product/${r.product_slug}/ saved=${saved} mailed=${mailed} images=${images.length}`);
  return reply(200, { ok: true, ref });
}

exports.handler = (event) => handle(event);
exports.handle = handle;
