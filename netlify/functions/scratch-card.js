/**
 * Public scratch card endpoint.
 *   GET  ?order_id=IC-XXXXX   → returns unscratched card created for that order, or null
 *   POST { action: 'scratch', code } → marks card scratched, returns the revealed value
 *   POST { action: 'validate', code, subtotal_paise } → validates a code for redemption at checkout
 */

const { createClient } = require('@supabase/supabase-js');

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

function ok(body)   { return { statusCode: 200, headers: CORS, body: JSON.stringify(body) }; }
function bad(code, msg) { return { statusCode: code, headers: CORS, body: JSON.stringify({ error: msg }) }; }

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // ── GET: fetch card for an order ───────────────────────────────────────────
  if (event.httpMethod === 'GET') {
    const orderId = (event.queryStringParameters?.order_id || '').trim();
    if (!orderId) return bad(400, 'Missing order_id');

    const { data: card, error } = await supabase
      .from('scratch_cards')
      .select('code,value_paise,min_subtotal_paise,status,expires_at,source_order_id')
      .eq('source_order_id', orderId)
      .maybeSingle();

    if (error) return bad(500, error.message);
    if (!card) return ok({ card: null });

    // Don't reveal the value if still unscratched — only after they scratch
    return ok({
      card: {
        code: card.code,
        status: card.status,
        // hide the prize until scratched
        value_paise: card.status === 'unscratched' ? null : card.value_paise,
        min_subtotal_paise: card.min_subtotal_paise,
        expires_at: card.expires_at,
      },
    });
  }

  // ── POST ───────────────────────────────────────────────────────────────────
  if (event.httpMethod !== 'POST') return bad(405, 'Method not allowed');

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return bad(400, 'Bad JSON'); }

  const action = String(body.action || '').toLowerCase();

  // ── Action: scratch ──────────────────────────────────────────────────────
  if (action === 'scratch') {
    const code = String(body.code || '').trim().toUpperCase();
    if (!code) return bad(400, 'Missing code');

    const { data: card, error: fetchErr } = await supabase
      .from('scratch_cards').select('*').eq('code', code).maybeSingle();
    if (fetchErr) return bad(500, fetchErr.message);
    if (!card)    return bad(404, 'Card not found');

    if (card.status !== 'unscratched') {
      // Already scratched — just return the value (idempotent UX)
      return ok({
        success: true,
        value_paise: card.value_paise,
        code: card.code,
        min_subtotal_paise: card.min_subtotal_paise,
        expires_at: card.expires_at,
        already_scratched: true,
      });
    }

    if (new Date(card.expires_at) < new Date()) {
      await supabase.from('scratch_cards').update({ status: 'expired' }).eq('id', card.id);
      return bad(410, 'Card expired');
    }

    const { error: updErr } = await supabase
      .from('scratch_cards')
      .update({ status: 'scratched', scratched_at: new Date().toISOString() })
      .eq('id', card.id);
    if (updErr) return bad(500, updErr.message);

    return ok({
      success: true,
      value_paise: card.value_paise,
      code: card.code,
      min_subtotal_paise: card.min_subtotal_paise,
      expires_at: card.expires_at,
    });
  }

  // ── Action: validate (for checkout coupon field) ─────────────────────────
  if (action === 'validate') {
    const code = String(body.code || '').trim().toUpperCase();
    const subtotalPaise = parseInt(body.subtotal_paise, 10) || 0;
    if (!code) return bad(400, 'Missing code');

    const { data: card } = await supabase
      .from('scratch_cards').select('*').eq('code', code).maybeSingle();
    if (!card) return ok({ valid: false, reason: 'not_found' });

    if (card.status === 'redeemed') return ok({ valid: false, reason: 'already_used' });
    if (card.status === 'unscratched') return ok({ valid: false, reason: 'not_scratched' });
    if (new Date(card.expires_at) < new Date()) return ok({ valid: false, reason: 'expired' });
    if (subtotalPaise < (card.min_subtotal_paise || 0)) {
      return ok({
        valid: false,
        reason: 'min_subtotal',
        min_subtotal_paise: card.min_subtotal_paise,
      });
    }

    return ok({
      valid: true,
      code: card.code,
      discount_paise: card.value_paise,
      min_subtotal_paise: card.min_subtotal_paise,
    });
  }

  return bad(400, 'Unknown action');
};
