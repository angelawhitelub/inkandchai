/**
 * Netlify Function: admin-address-audit
 * POST /.netlify/functions/admin-address-audit
 *
 * Scans the delivery addresses of every UNSHIPPED order and reports the ones
 * that will probably fail -- before a label is bought, not after the parcel
 * comes back. Two undeliverable pincodes (206014, 364042) shipped and could
 * not be delivered; a handful of replacements sat stuck for 4-11 days with no
 * pincode at all. Both classes are visible in the address text the whole time.
 *
 * DETERMINISTIC FIRST, AI SECOND -- deliberately, in that order:
 *
 *   Rules decide anything a rule can decide (missing pincode, junk pincode,
 *   pincode no courier serves, pincode whose real state contradicts the state
 *   written in the address, unusable phone). These are cheap, repeatable and
 *   need no API key, so the tool is useful even with OPENAI_API_KEY unset --
 *   which matters, because that key migrated to Cloudflare EMPTY.
 *
 *   The model is then asked only the question rules are bad at: does this text
 *   describe a place a courier could actually find? Missing house/flat number,
 *   a line truncated mid-word, "same as above", a locality that is really a
 *   landmark. It is given the pincode's TRUE city/state as ground truth so it
 *   judges the address, not the geography.
 *
 * FLAGS, NEVER EDITS. Nothing here writes to an order, cancels anything or
 * messages a customer. It produces a list for the admin to act on by hand via
 * "Edit details" -- the pincodes it cannot guess have to come from the customer.
 *
 * Body (all optional):
 *   limit      max orders to scan, default 250, hard cap 500
 *   use_ai     default true; false runs the deterministic pass alone
 *   ai_limit   max orders sent to the model, default 120
 *   order_ids  scan exactly these instead of "everything unshipped"
 *
 * Header: X-Admin-Token (or legacy X-Admin-Key).
 */

const { createClient } = require('@supabase/supabase-js');
const { requireAdmin } = require('./utils/admin-auth');
const { isFakePincode, extractPincode, pincodeDeliverable } = require('./utils/pincode-valid');
const { normalizeIndianPhone } = require('./utils/np-normalize');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key, X-Admin-Token',
  'Content-Type': 'application/json',
};
const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });

// Same list the courier pusher uses. Keep them identical: an order this tool
// declares clean must be one that push actually attempts.
const UNSHIPPED_STATUSES = [
  'paid', 'confirmed', 'cod_pending', 'partial_cod_pending', 'replacement_pending',
];

const INDIA_POST_URL = 'https://api.postalpincode.in/pincode/';

/* -- state names ----------------------------------------------------------
 * Only used to catch a pincode that belongs to a different state than the one
 * written in the address -- the classic "typed my old pincode" error. Aliases
 * matter: India Post says "Odisha" where customers still write "Orissa", and a
 * false mismatch on that would be worse than no check at all.
 * ------------------------------------------------------------------------ */
const STATE_ALIASES = {
  'andhra pradesh': 'andhra pradesh', 'arunachal pradesh': 'arunachal pradesh',
  'assam': 'assam', 'bihar': 'bihar', 'chhattisgarh': 'chhattisgarh',
  'chattisgarh': 'chhattisgarh', 'goa': 'goa', 'gujarat': 'gujarat',
  'haryana': 'haryana', 'himachal pradesh': 'himachal pradesh',
  'jharkhand': 'jharkhand', 'karnataka': 'karnataka', 'kerala': 'kerala',
  'madhya pradesh': 'madhya pradesh', 'maharashtra': 'maharashtra',
  'manipur': 'manipur', 'meghalaya': 'meghalaya', 'mizoram': 'mizoram',
  'nagaland': 'nagaland', 'odisha': 'odisha', 'orissa': 'odisha',
  'punjab': 'punjab', 'rajasthan': 'rajasthan', 'sikkim': 'sikkim',
  'tamil nadu': 'tamil nadu', 'tamilnadu': 'tamil nadu',
  'telangana': 'telangana', 'tripura': 'tripura',
  'uttar pradesh': 'uttar pradesh', 'uttarakhand': 'uttarakhand',
  'uttaranchal': 'uttarakhand', 'west bengal': 'west bengal',
  'delhi': 'delhi', 'new delhi': 'delhi', 'nct of delhi': 'delhi',
  'jammu and kashmir': 'jammu and kashmir', 'jammu & kashmir': 'jammu and kashmir',
  'ladakh': 'ladakh', 'puducherry': 'puducherry', 'pondicherry': 'puducherry',
  'chandigarh': 'chandigarh', 'andaman and nicobar islands': 'andaman and nicobar islands',
  'dadra and nagar haveli': 'dadra and nagar haveli and daman and diu',
  'daman and diu': 'dadra and nagar haveli and daman and diu',
  'dadra and nagar haveli and daman and diu': 'dadra and nagar haveli and daman and diu',
  'lakshadweep': 'lakshadweep',
};
// Longest first so "andhra pradesh" wins over a bare "pradesh"-style prefix and
// "new delhi" is not shadowed by "delhi".
const STATE_KEYS = Object.keys(STATE_ALIASES).sort((a, b) => b.length - a.length);

function canonicalState(value) {
  const t = String(value || '').toLowerCase().replace(/[^a-z& ]+/g, ' ').replace(/\s+/g, ' ').trim();
  return STATE_ALIASES[t] || null;
}

/** Every state named anywhere in the address text, canonicalised and deduped. */
function statesMentioned(address) {
  const hay = ` ${String(address || '').toLowerCase().replace(/[^a-z& ]+/g, ' ').replace(/\s+/g, ' ').trim()} `;
  const found = new Set();
  for (const key of STATE_KEYS) {
    if (hay.includes(` ${key} `)) found.add(STATE_ALIASES[key]);
  }
  return [...found];
}

/* -- pincode lookup -------------------------------------------------------
 * One India Post call per UNIQUE pincode, returning existence AND city/state
 * together. Calling pincodeExists() and cityStateFromPincode() separately
 * would double the request count for the same answer, and a 250-order scan
 * already touches ~150 distinct pincodes.
 *
 * `found: null` means we could not tell (network, timeout, odd shape) and is
 * treated as "no opinion" everywhere below -- this tool must never invent a
 * problem out of its own failure to reach an API.
 * ------------------------------------------------------------------------ */
async function lookupPincode(pin, timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${INDIA_POST_URL}${pin}`, { signal: controller.signal });
    if (!res || !res.ok) return { found: null, city: '', state: '' };
    const data = await res.json().catch(() => null);
    const row = Array.isArray(data) ? data[0] : null;
    if (!row || typeof row.Status !== 'string') return { found: null, city: '', state: '' };
    if (/^no records? found$/i.test(row.Status) || row.Status === 'Error') {
      return { found: false, city: '', state: '' };
    }
    if (row.Status !== 'Success') return { found: null, city: '', state: '' };
    const po = (row.PostOffice || [])[0];
    if (!po) return { found: null, city: '', state: '' };
    return { found: true, city: po.District || po.Block || po.Name || '', state: po.State || '' };
  } catch (_) {
    return { found: null, city: '', state: '' };
  } finally {
    clearTimeout(timer);
  }
}

/** Run `worker` over `items` with a bounded number in flight. */
async function mapLimit(items, limit, worker) {
  const out = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return out;
}

function parseItems(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return [];
  try { const p = JSON.parse(value); return Array.isArray(p) ? p : []; } catch { return []; }
}

const clean = (v, max = 400) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);

/* -- deterministic checks ------------------------------------------------ */

// 'critical' = will not ship, or will ship to the wrong place. 'warn' = worth
// a human glance. Nothing here is auto-acted on, so a warn costs only attention.
function addressShapeIssues(addressText, pincode) {
  const issues = [];
  // Strip the pincode before judging length/digits, otherwise "560001" alone
  // reads as a 6-character address that contains a number.
  const body = String(addressText || '').replace(pincode || ' ', ' ').replace(/\s+/g, ' ').trim();

  if (!body) {
    issues.push({ code: 'empty_address', severity: 'critical', label: 'No address text', detail: 'The order has a pincode but no street line.' });
    return issues;
  }
  if (body.length < 20) {
    issues.push({ code: 'address_too_short', severity: 'critical', label: 'Address is too short to deliver', detail: `Only ${body.length} characters once the pincode is removed: "${body}"` });
  } else if (body.length < 35) {
    issues.push({ code: 'address_thin', severity: 'warn', label: 'Very short address', detail: `${body.length} characters once the pincode is removed.` });
  }
  // No digit anywhere usually means no house/flat/plot number. Real, and the
  // single most common reason a courier calls the customer from the street.
  if (!/\d/.test(body)) {
    issues.push({ code: 'no_house_number', severity: 'warn', label: 'No house or flat number', detail: 'Nothing numeric in the address apart from the pincode.' });
  }
  // A line that stops on a separator is the signature of a truncated field.
  if (/[,\-/]$/.test(body.trim())) {
    issues.push({ code: 'address_truncated', severity: 'warn', label: 'Address looks cut off', detail: 'Ends on a comma, dash or slash.' });
  }
  return issues;
}

function phoneIssues(rawPhone) {
  const raw = String(rawPhone == null ? '' : rawPhone).replace(/\D/g, '');
  // normalizeIndianPhone returns '' both for "nothing here" and for "digits I
  // could not turn into a mobile number". Those read very differently to the
  // admin, so split them on whether the field held any digits at all.
  if (!raw) {
    return [{ code: 'no_phone', severity: 'critical', label: 'No phone number', detail: 'The courier cannot book a delivery without one.' }];
  }
  const digits = normalizeIndianPhone(rawPhone);
  if (!digits || digits.length !== 10 || !/^[6-9]/.test(digits)) {
    return [{
      code: 'bad_phone', severity: 'critical',
      label: 'Phone number is not a valid Indian mobile',
      detail: `"${clean(rawPhone, 40)}" does not normalise to a 10-digit mobile starting 6-9${digits ? ` (best reading: ${digits})` : ''}.`,
    }];
  }
  return [];
}

/* -- AI pass ------------------------------------------------------------- */

const AI_SYSTEM_PROMPT = `You audit Indian delivery addresses for an online bookstore. A courier executive must be able to find the door from the text alone.

For each address decide whether a delivery would realistically FAIL.

Flag an address only for problems like:
- no house / flat / plot / door number and no building name (nothing to knock on)
- text that stops mid-word or mid-phrase, clearly truncated
- placeholder or nonsense text ("same as above", "abc", "test", "na", repeated characters)
- only a landmark or a locality, with no street, building or number
- the address plainly describes a different city or district from the true city given for the pincode (not a spelling variation, not a suburb of the same city, not a nearby village in the same district)

Do NOT flag an address for:
- being written in Hindi, Hinglish or any Indian language, or transliterated spelling
- unusual capitalisation, missing punctuation, or abbreviations (Vill, Po, Ps, Dist, Opp, Nr, H.No, S/o)
- being long, repetitive, or naming several landmarks
- a missing state or city when the pincode already supplies it
- a PO Box, care-of address, hostel, office or shop address
- anything you are merely unsure about

The default answer is "ok". Only return "suspect" when you can name the concrete reason a courier would fail.

Return ONLY JSON: {"results":[{"i":<number>,"verdict":"ok"|"suspect","reason":"<max 15 words>"}]}
Include an entry for every i you were given.`;

async function aiBatch(batch, model, timeoutMs = 45000) {
  const lines = batch.map(o => {
    const truth = o.pin_city || o.pin_state
      ? `pincode ${o.pincode} is really ${[o.pin_city, o.pin_state].filter(Boolean).join(', ')}`
      : `pincode ${o.pincode || 'missing'}, true location unknown`;
    return `${o._i}. address: "${clean(o.address, 300)}" | ${truth}`;
  }).join('\n');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: AI_SYSTEM_PROMPT },
          // Fenced so a customer-typed address containing instruction-shaped
          // text is read as data, not as a new rule.
          { role: 'user', content: `Audit these addresses.\n"""\n${lines}\n"""` },
        ],
        response_format: { type: 'json_object' },
        temperature: 0,           // an audit must give the same answer twice
        max_tokens: 1400,
      }),
      signal: controller.signal,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`OpenAI ${res.status}: ${body.error?.message || 'request failed'}`);
    let parsed;
    try { parsed = JSON.parse(body.choices?.[0]?.message?.content || '{}'); }
    catch { throw new Error('model returned invalid JSON'); }
    return Array.isArray(parsed.results) ? parsed.results : [];
  } finally {
    clearTimeout(timer);
  }
}

/* -- handler ------------------------------------------------------------- */

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: 'Method Not Allowed' };

  const block = requireAdmin(event, CORS); if (block) return block;

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }

  const limit   = Math.min(500, Math.max(1, Number(body.limit) || 250));
  const aiLimit = Math.min(300, Math.max(0, Number(body.ai_limit ?? 120) || 0));
  const wantAi  = body.use_ai !== false;

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return json(500, { error: 'Supabase is not configured on this deploy.' });
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  let query = supabase.from('orders')
    .select('id, razorpay_order_id, status, customer_name, customer_phone, customer_address, created_at, awb, nimbus_pushed_at, cart_items')
    .or('source.is.null,source.neq.paperbound');

  if (Array.isArray(body.order_ids) && body.order_ids.length) {
    query = query.in('razorpay_order_id', body.order_ids.slice(0, 500));
  } else {
    query = query.in('status', UNSHIPPED_STATUSES).order('created_at', { ascending: false }).limit(limit);
  }

  const { data: rows, error } = await query;
  if (error) return json(500, { error: `Could not load orders: ${error.message}` });

  // An order with an AWB is already on its way; its address is the courier's
  // problem now, and flagging it would only add noise to a list meant for action.
  const orders = (rows || []).filter(o => !o.awb);

  /* 1 -- shape checks, no network */
  const scanned = orders.map(o => {
    const orderId = String(o.razorpay_order_id || o.id);
    const address = clean(o.customer_address, 400);
    const pincode = extractPincode({ address });
    const issues = [];

    if (!pincode) {
      issues.push({ code: 'no_pincode', severity: 'critical', label: 'No 6-digit pincode in the address', detail: 'NimbusPost rejects the push outright, so this order cannot ship until a pincode is added.' });
    } else if (isFakePincode(pincode)) {
      issues.push({ code: 'fake_pincode', severity: 'critical', label: `Pincode ${pincode} is not a real pincode`, detail: 'Matches a junk pattern (repeated, sequential or blacklisted digits).' });
    }
    issues.push(...addressShapeIssues(address, pincode));
    issues.push(...phoneIssues(o.customer_phone));

    const created = o.created_at ? new Date(o.created_at).getTime() : NaN;
    return {
      id: orderId,
      // The admin's Edit-details modal is keyed on the DB uuid, not the display
      // id, so the audit has to hand back both or its "fix this" link is dead.
      db_id: String(o.id || ''),
      status: o.status || '',
      name: clean(o.customer_name, 120),
      phone: clean(o.customer_phone, 40),
      address,
      pincode,
      created_at: o.created_at || null,
      age_days: Number.isFinite(created) ? Math.floor((Date.now() - created) / 86400000) : null,
      items: parseItems(o.cart_items).length,
      pushed: !!o.nimbus_pushed_at,
      pin_city: '', pin_state: '',
      issues,
    };
  });

  /* 2 -- one India Post lookup per unique pincode; escalate misses to the courier */
  const uniquePins = [...new Set(scanned.map(o => o.pincode).filter(p => p && !isFakePincode(p)))];
  const pinInfo = new Map();
  await mapLimit(uniquePins, 8, async (pin) => {
    const info = await lookupPincode(pin);
    // India Post's dataset is INCOMPLETE -- measured on 8,274 orders, 87 pincodes
    // came back "no records found" and NimbusPost still showed 22-37 couriers for
    // most of them, 34 of those orders having already been DELIVERED. So a miss
    // here is never the verdict; only a confirmed zero-courier answer is.
    if (info.found === false) {
      info.deliverable = await pincodeDeliverable(pin);
    }
    pinInfo.set(pin, info);
  });

  let pinCheckDegraded = 0;
  for (const o of scanned) {
    const info = o.pincode ? pinInfo.get(o.pincode) : null;
    if (!info) continue;
    o.pin_city = info.city || '';
    o.pin_state = info.state || '';

    if (info.found === null) {
      pinCheckDegraded++;                       // lookup failed: say nothing about this pincode
    } else if (info.found === false) {
      if (info.deliverable === false) {
        o.issues.push({ code: 'undeliverable_pincode', severity: 'critical', label: `No courier serves ${o.pincode}`, detail: 'Not in the India Post directory and NimbusPost returns zero couriers. This is the pattern behind the two parcels that shipped and could not be delivered.' });
      } else if (info.deliverable === true) {
        o.issues.push({ code: 'pincode_not_in_directory', severity: 'warn', label: `${o.pincode} is missing from the India Post directory`, detail: 'Couriers do serve it, so it is very likely genuine. Worth an eyeball, not a hold.' });
      } else {
        o.issues.push({ code: 'pincode_unverified', severity: 'warn', label: `Could not verify pincode ${o.pincode}`, detail: 'India Post has no record and the courier serviceability check was unreachable.' });
      }
    } else if (info.state) {
      // Only a clear contradiction counts: the address names exactly one state
      // and it is not the pincode's. Two states named usually means a landmark
      // or a former address line, which is not evidence of an error.
      const named = statesMentioned(o.address);
      const truth = canonicalState(info.state);
      if (named.length === 1 && truth && named[0] !== truth) {
        o.issues.push({
          code: 'state_mismatch', severity: 'critical',
          label: `Pincode is in ${info.state}, address says ${named[0].replace(/\b\w/g, c => c.toUpperCase())}`,
          detail: `${o.pincode} is ${[info.city, info.state].filter(Boolean).join(', ')}. One of the two is wrong, most often an old pincode left in the form.`,
        });
      }
    }
  }

  /* 3 -- AI pass on everything the rules did NOT already condemn */
  const ai = { used: false, model: null, considered: 0, flagged: 0, error: null };
  const hasCritical = o => o.issues.some(i => i.severity === 'critical');

  if (wantAi && aiLimit > 0) {
    if (!process.env.OPENAI_API_KEY) {
      ai.error = 'OPENAI_API_KEY is not readable on this deploy, so the AI pass was skipped. The rule-based checks still ran. Set it with: npx wrangler secret put OPENAI_API_KEY';
    } else {
      // Sending an order that already fails a hard rule buys nothing -- it is
      // going on the list either way, and it is the cheapest thing to cut.
      const candidates = scanned.filter(o => !hasCritical(o) && o.address).slice(0, aiLimit);
      candidates.forEach((o, i) => { o._i = i; });
      ai.considered = candidates.length;

      if (candidates.length) {
        const model = process.env.OPENAI_ADDRESS_MODEL || process.env.OPENAI_MODEL || 'gpt-4o-mini';
        ai.model = model;
        const batches = [];
        for (let i = 0; i < candidates.length; i += 20) batches.push(candidates.slice(i, i + 20));

        const errors = [];
        const results = await mapLimit(batches, 3, async (batch) => {
          try { return await aiBatch(batch, model); }
          catch (e) { errors.push(String(e.message || e)); return []; }
        });

        const byIndex = new Map(candidates.map(o => [o._i, o]));
        for (const row of results.flat()) {
          const target = byIndex.get(Number(row && row.i));
          if (!target || String(row && row.verdict).toLowerCase() !== 'suspect') continue;
          target.issues.push({
            code: 'ai_suspect', severity: 'warn', source: 'ai',
            label: 'AI thinks this address may not be deliverable',
            detail: clean(row.reason, 160) || 'No reason given.',
          });
          ai.flagged++;
        }
        ai.used = errors.length < batches.length;
        if (errors.length) {
          ai.error = `${errors.length} of ${batches.length} AI batches failed: ${clean(errors[0], 200)}`;
        }
      } else {
        ai.used = true;
      }
    }
  }

  for (const o of scanned) delete o._i;

  const flagged = scanned.filter(o => o.issues.length);
  const rank = o => (hasCritical(o) ? 0 : 1);
  flagged.sort((a, b) => rank(a) - rank(b) || (b.age_days == null ? -1 : b.age_days) - (a.age_days == null ? -1 : a.age_days));

  const criticalCount = flagged.filter(hasCritical).length;
  const byCode = {};
  for (const o of flagged) for (const i of o.issues) byCode[i.code] = (byCode[i.code] || 0) + 1;

  console.log(`[address-audit] scanned ${scanned.length} unshipped, flagged ${flagged.length}`
    + ` (${criticalCount} blocking), pincodes checked ${uniquePins.length}`
    + (pinCheckDegraded ? `, ${pinCheckDegraded} lookups unreachable` : '')
    + (ai.used ? `, AI reviewed ${ai.considered} and flagged ${ai.flagged}` : ', AI skipped'));

  return json(200, {
    scanned: scanned.length,
    flagged_count: flagged.length,
    critical_count: criticalCount,
    clean_count: scanned.length - flagged.length,
    pincodes_checked: uniquePins.length,
    pincode_lookups_unreachable: pinCheckDegraded,
    by_code: byCode,
    ai,
    flagged,
  });
};

// Exported for tests. The handler is the product; these are the parts worth
// pinning down independently.
module.exports._internals = { statesMentioned, canonicalState, addressShapeIssues, phoneIssues, lookupPincode, mapLimit };
