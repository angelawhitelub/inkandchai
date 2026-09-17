/**
 * Netlify Function: whatsapp-template-diagnose
 * GET /.netlify/functions/whatsapp-template-diagnose?name=order_shipped
 *
 * Read-only. Reports what a Meta-approved WhatsApp template ACTUALLY looks
 * like, so notification code can stop guessing at it.
 *
 * WHY
 * ---
 * Five call sites send the template `order_shipped`, and they disagree about
 * how many body variables it has:
 *
 *   nimbuspost-awb-sync-background.js  4  ("the approved template currently
 *                                          has four body variables")
 *   bulk-update-orders.js             4
 *   update-order-status.js            4
 *   nimbuspost-webhook.js             5
 *   order-tracking.js                 5  ("Track here: {{5}}")
 *
 * Meta rejects the whole send when the parameter count does not match the
 * approved template, and every caller only .catch()es exceptions -- a non-ok
 * HTTP response is returned, not thrown, so the failures are invisible. One of
 * those two groups has been silently sending nothing.
 *
 * It also reports BUTTONS, because a URL button's base is fixed at approval
 * time: if the tracking button were baked to a NimbusPost URL, passing a
 * correct link as a body parameter would not change what the customer taps.
 *
 * Secrets are never echoed -- only the template structure.
 *
 * Header: X-Admin-Key / X-Admin-Token
 * Env: WHATSAPP_TOKEN, WHATSAPP_PHONE_ID
 */

const { requireAdmin } = require('./utils/admin-auth');

const API_VERSION = process.env.WHATSAPP_API_VERSION || 'v21.0';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key, X-Admin-Token',
  'Content-Type': 'application/json',
};
const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body, null, 2) });

async function graph(path, token) {
  const res = await fetch(`https://graph.facebook.com/${API_VERSION}/${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body };
}

/** Count distinct {{n}} placeholders in a template body. */
function countVars(text) {
  const seen = new Set((String(text || '').match(/\{\{\s*\d+\s*\}\}/g) || [])
    .map((m) => m.replace(/\D/g, '')));
  return seen.size;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  const denied = requireAdmin(event, CORS);
  if (denied) return denied;

  const token = process.env.WHATSAPP_TOKEN;
  const phoneId = process.env.WHATSAPP_PHONE_ID;
  if (!token || !phoneId) {
    return json(500, { error: 'WHATSAPP_TOKEN or WHATSAPP_PHONE_ID is not configured' });
  }

  const want = (event.queryStringParameters || {}).name || '';
  const envWaba = process.env.WHATSAPP_WABA_ID || '';

  // The template list lives on the WhatsApp Business Account, and the WABA id
  // is not configured anywhere. Two ways to find it, tried in order.
  const attempts = [];
  let waba = envWaba ? { id: envWaba, name: null } : null;

  // 1. Ask the phone number who owns it. Not a field in every API version.
  const owner = waba ? { ok: false, status: 0, body: {} } : await graph(`${phoneId}?fields=whatsapp_business_account{id,name}`, token);
  attempts.push({ via: 'phone.whatsapp_business_account', status: owner.status });
  if (owner.ok && owner.body && owner.body.whatsapp_business_account) {
    waba = owner.body.whatsapp_business_account;
  }

  // 2. Ask the token what it can reach. granular_scopes for
  //    whatsapp_business_management carries the WABA ids as target_ids.
  if (!waba) {
    const dbg = await graph(`debug_token?input_token=${encodeURIComponent(token)}`, token);
    attempts.push({ via: 'debug_token.granular_scopes', status: dbg.status });
    const d = (dbg.body && dbg.body.data) || {};
    // Echo the SHAPE so a failure says why, without echoing the token.
    attempts.push({
      via: 'debug_token.shape',
      type: d.type || null,
      app_id: d.app_id || null,
      is_valid: d.is_valid,
      scopes: Array.isArray(d.scopes) ? d.scopes : undefined,
      granular: (d.granular_scopes || []).map((g) => ({ scope: g.scope, target_ids: g.target_ids })),
    });
    const scopes = d.granular_scopes || [];
    const hit = scopes.find((s) => /whatsapp_business_(management|messaging)/.test(String(s.scope)))
             || scopes.find((s) => Array.isArray(s.target_ids) && s.target_ids.length);
    if (hit && Array.isArray(hit.target_ids) && hit.target_ids.length) {
      waba = { id: hit.target_ids[0], name: null };
      attempts.push({ via: 'debug_token', target_ids: hit.target_ids });
    }
  }

  // 3. A SYSTEM_USER token has no target_ids when it is unrestricted, but the
  //    system user itself lists the WABAs assigned to it.
  if (!waba) {
    const me = await graph('me?fields=id,name', token);
    attempts.push({ via: 'me', status: me.status, id: (me.body && me.body.id) || null });
    if (me.ok && me.body && me.body.id) {
      const assigned = await graph(`${me.body.id}/assigned_whatsapp_business_accounts?fields=id,name`, token);
      attempts.push({ via: 'assigned_whatsapp_business_accounts', status: assigned.status,
        count: ((assigned.body || {}).data || []).length });
      const first = ((assigned.body || {}).data || [])[0];
      if (first && first.id) waba = { id: first.id, name: first.name || null };
    }
  }

  // 4. The WABA is usually owned by the BUSINESS the system user belongs to,
  //    not assigned to the user directly.
  if (!waba) {
    const me2 = await graph('me?fields=id,name,business{id,name}', token);
    const biz = (me2.body && me2.body.business) || null;
    attempts.push({ via: 'me.business', status: me2.status, business_id: biz && biz.id });
    if (biz && biz.id) {
      for (const edge of ['owned_whatsapp_business_accounts', 'client_whatsapp_business_accounts']) {
        if (waba) break;
        const r = await graph(`${biz.id}/${edge}?fields=id,name`, token);
        const rows = ((r.body || {}).data || []);
        attempts.push({ via: `business.${edge}`, status: r.status, count: rows.length,
          ids: rows.map((x) => x.id) });
        if (rows[0] && rows[0].id) waba = { id: rows[0].id, name: rows[0].name || null };
      }
    }
  }

  if (!waba || !waba.id) {
    return json(502, {
      error: 'could not resolve the WhatsApp Business Account',
      attempts,
      hint: 'set WHATSAPP_WABA_ID if the token cannot self-describe',
    });
  }

  const list = await graph(`${waba.id}/message_templates?limit=200`, token);
  if (!list.ok) {
    return json(502, {
      error: 'could not list templates',
      status: list.status,
      detail: (list.body && list.body.error && list.body.error.message) || null,
    });
  }

  const all = Array.isArray(list.body.data) ? list.body.data : [];
  const chosen = want ? all.filter((t) => t.name === want) : all;

  const described = chosen.map((t) => {
    const comps = Array.isArray(t.components) ? t.components : [];
    const body = comps.find((c) => String(c.type).toUpperCase() === 'BODY');
    const buttons = comps.find((c) => String(c.type).toUpperCase() === 'BUTTONS');
    return {
      name: t.name,
      language: t.language,
      status: t.status,
      category: t.category,
      body_text: body ? body.text : null,
      body_variable_count: body ? countVars(body.text) : 0,
      // A URL button's base is fixed at approval. This is the field that
      // decides whether a tracking link can be changed from code at all.
      buttons: buttons ? (buttons.buttons || []).map((b) => ({
        type: b.type,
        text: b.text,
        url: b.url || null,
        url_is_nimbuspost: /nimbuspost/i.test(String(b.url || '')),
      })) : [],
      has_header: comps.some((c) => String(c.type).toUpperCase() === 'HEADER'),
    };
  });

  return json(200, {
    waba: { id: waba.id, name: waba.name || null },
    templates_total: all.length,
    filter: want || '(all)',
    matched: described.length,
    templates: described,
  });
};
