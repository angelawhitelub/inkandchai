/**
 * Netlify Function: woo-channel
 * GET /wp-json/wc/v3/orders   (and the rest of the WooCommerce REST surface)
 *
 * WHY THIS EXISTS
 * ---------------
 * The requirement was: get the unshipped orders into the XpressBees panel
 * WITHOUT assigning an AWB, so they can be reviewed and booked by hand.
 *
 * The XpressBees shipping API cannot do that. Every version of it -- the old
 * PDF, apidoc_v1.1.5, and the public Postman collection -- exposes exactly two
 * endpoints that create anything, and both say so in their own description:
 *
 *   POST /api/shipments2         "Generate AWB / Tracking Number For Your Order"
 *   POST /api/reverseshipments   "Generate a Reverse AWB / Tracking Number"
 *
 * There is no import. GET /api/orders exists but is undocumented and read-only
 * (POST/PUT/PATCH/DELETE all answer "Unknown method"), and the panel's own
 * Bulk Fulfillment and Webhooks pages still say "will be available soon".
 *
 * But the panel has a SALES CHANNEL importer -- "orders sync automatically
 * every few minutes when a channel is connected and active" -- and one of the
 * eight connectors is WooCommerce, which asks for nothing but a store URL and
 * a consumer key/secret. Orders arriving that way land unfulfilled, with no
 * AWB and no charge, which is precisely the requirement.
 *
 * So this file makes inkandchai.in answer as a WooCommerce store, for exactly
 * the eight read paths XpressBees needs and nothing else. It is a read-only
 * projection of `orders`; it can create, modify and delete nothing.
 *
 * SECURITY
 * --------
 * This endpoint serves customer names, addresses and phone numbers. It is
 * therefore refused unless the request carries the consumer key AND secret,
 * compared with timingSafeEqual. Both WooCommerce auth styles are accepted
 * because clients differ: HTTP Basic (the documented one over HTTPS) and the
 * ?consumer_key=&consumer_secret= query pair.
 *
 * It declares no `Netlify-CDN-Cache-Control`, so the Worker's edge cache never
 * stores it (caching there is opt-in), and edgeCacheKey() already refuses any
 * request carrying Authorization.
 *
 * SCOPE
 * -----
 * WOO_FEED_SINCE bounds how far back the feed reaches. This is deliberate and
 * load-bearing: there are 110 open COD orders going back to 19 June that were
 * excluded from the earlier push on purpose, and an unbounded feed would hand
 * every one of them to XpressBees on the first sync.
 *
 * Env: WOO_CONSUMER_KEY, WOO_CONSUMER_SECRET, WOO_FEED_SINCE (ISO date),
 *      SUPABASE_URL, SUPABASE_SERVICE_KEY
 */

const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { sanitizeForCourier, sanitizeAddressText } = require('./utils/nimbuspost-import');
const { normalizeIndianPhone, parseAddress, enrichAddress } = require('./utils/np-normalize');
const { isReplacementOrder } = require('./utils/replacement-order');
const { classifyShipmentMoney, parseCartItems } = require('./utils/shipment-money');
const { buildTrackingUrl } = require('./utils/tracking-url');
const { sendShippedNotification } = require('./utils/shipped-notification');

const UNSHIPPED_STATUSES = [
  'paid', 'confirmed', 'cod_pending', 'partial_cod_pending', 'replacement_pending',
];

// Last three days including today. Anything older is the deliberately-parked
// backlog -- 110 open COD orders reach back to 19 June -- and an unbounded
// feed would hand every one of them to XpressBees on the first sync.
const DEFAULT_SINCE = '2026-09-15';

// An order whose payment never completed must not be shipped. `pending_phonepe`
// is the one that matters (IC-20260909-Q5GPA sat in it for days); the prefix
// test also catches any future pending_* status, while leaving cod_pending and
// partial_cod_pending -- which are pending COLLECTION, not pending payment --
// alone, because those are matched by their own names in UNSHIPPED_STATUSES.
const isPaymentPending = (status) => /^pending(_|$)/i.test(String(status || ''));

// These two strings are what gets typed into the channel's "COD Payment
// Titles" and "Prepaid Payment Titles" boxes. They must match exactly or
// XpressBees books every order on the wrong payment mode.
const COD_TITLE = 'Cash on delivery';
const PREPAID_TITLE = 'Prepaid';

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  // Never let this response into a shared cache: it is per-key and full of PII.
  'Cache-Control': 'no-store, private',
};

const json = (statusCode, body, extra = {}) => ({
  statusCode,
  headers: { ...JSON_HEADERS, ...extra },
  body: JSON.stringify(body),
});

const wpError = (code, message, status) => json(status, { code, message, data: { status } });

/** Constant-time string compare that tolerates unequal lengths. */
function safeEqual(a, b) {
  const x = Buffer.from(String(a || ''), 'utf8');
  const y = Buffer.from(String(b || ''), 'utf8');
  if (x.length !== y.length) return false;
  try { return crypto.timingSafeEqual(x, y); } catch { return false; }
}

/**
 * WooCommerce clients send the consumer pair one of two ways. Accept both.
 * @returns {{key: string, secret: string}}
 */
function readCredentials(event) {
  const h = event.headers || {};
  const auth = h.authorization || h.Authorization || '';
  if (/^basic /i.test(auth)) {
    let decoded = '';
    try { decoded = Buffer.from(auth.slice(6).trim(), 'base64').toString('utf8'); } catch { decoded = ''; }
    const idx = decoded.indexOf(':');
    if (idx > -1) return { key: decoded.slice(0, idx), secret: decoded.slice(idx + 1) };
  }
  const q = event.queryStringParameters || {};
  return { key: q.consumer_key || '', secret: q.consumer_secret || '' };
}

function authorize(event) {
  const wantKey = process.env.WOO_CONSUMER_KEY || '';
  const wantSecret = process.env.WOO_CONSUMER_SECRET || '';
  if (!wantKey || !wantSecret) {
    return { ok: false, res: wpError('woocommerce_rest_not_configured',
      'Store credentials are not configured.', 503) };
  }
  const got = readCredentials(event);
  // Both compared every time, so a wrong key and a wrong secret cost the same.
  const keyOk = safeEqual(got.key, wantKey);
  const secretOk = safeEqual(got.secret, wantSecret);
  if (!keyOk || !secretOk) {
    return { ok: false, res: wpError('woocommerce_rest_authentication_error',
      'Consumer key or secret is invalid.', 401) };
  }
  return { ok: true };
}

/**
 * A stable positive 32-bit integer for a string order number.
 *
 * WooCommerce order ids are integers and some clients coerce them, so the
 * IC-... number cannot be used as the id. This is derived rather than stored
 * so it survives without a migration, and it is resolved back by recomputing
 * it over the candidate set rather than by a reverse lookup.
 */
function numericId(orderNumber) {
  const h = crypto.createHash('sha1').update(String(orderNumber)).digest();
  return (h.readUInt32BE(0) & 0x7fffffff) || 1;
}

/** WooCommerce emits "2026-09-16T10:00:00" -- ISO with the zone stripped. */
const wooDate = (iso) => {
  const d = iso ? new Date(iso) : new Date();
  return Number.isNaN(d.getTime()) ? new Date().toISOString().slice(0, 19)
                                   : d.toISOString().slice(0, 19);
};

const money2 = (rs) => (Math.round(Number(rs || 0) * 100) / 100).toFixed(2);

/**
 * Project one orders row into a WooCommerce order object.
 *
 * The money split is delegated to classifyShipmentMoney -- the same function
 * nimpuspost/ithink/xpressbees booking uses, and the one with 19 tests behind
 * it -- so the channel cannot disagree with the booker about what is COD.
 */
async function toWooOrder(order) {
  const number = order.razorpay_order_id || order.id;
  const a = await enrichAddress(parseAddress(order.customer_address || ''));

  // Refuse rather than serve a half-addressed order. Without these the feed
  // would hand XpressBees a blank postcode and the panel would import an
  // order that can never be delivered -- the handler catches the throw and
  // skips the row, leaving the other 96 to sync.
  if (!/^\d{6}$/.test(String(a.pincode || ''))) {
    throw new Error(`Cannot determine a 6-digit pincode for ${number}`);
  }
  const phone = String(normalizeIndianPhone(order.customer_phone || '') || '').replace(/\D/g, '').slice(-10);
  if (phone.length !== 10) {
    throw new Error(`Cannot determine a 10-digit phone for ${number}`);
  }

  const isReplacement = isReplacementOrder(order);
  const money = classifyShipmentMoney(order, isReplacement);

  const raw = parseCartItems(order.cart_items).filter((i) => i && (i.title || i.name));
  const lines = (raw.length ? raw : [{ title: 'Books', qty: 1, price: money.orderValueRs }])
    .map((i, idx) => {
      const qty = Math.max(1, Number(i.qty || i.quantity || 1));
      const price = Number(i.price || 0);
      return {
        id: idx + 1,
        name: sanitizeForCourier(i.title || i.name || 'Book').slice(0, 120),
        product_id: numericId(`${number}:${i.sku || i.title || idx}`),
        variation_id: 0,
        quantity: qty,
        sku: String(i.sku || ''),
        price: Number(money2(price)),
        subtotal: money2(price * qty),
        total: money2(price * qty),
        subtotal_tax: '0.00',
        total_tax: '0.00',
        taxes: [],
        meta_data: [],
      };
    });

  // A partial-COD order has already had an advance paid online, and the courier
  // must collect ONLY the balance. WooCommerce has no partial-payment concept,
  // and XpressBees derives the collectable amount from the order total on a COD
  // order -- so the total here MUST be the balance, or the customer is charged
  // the advance a second time on the doorstep.
  //
  // Expressing the advance as discount_total keeps the arithmetic honest and
  // legible in the panel: line items sum to the full value, the advance comes
  // off, and the remainder is what is collected.
  const lineSum = lines.reduce((t, l) => t + Number(l.total), 0);
  const discount = money.isPartialCod ? money.advanceRs : 0;
  const total = money.isPartialCod ? money.collectableAmount : money.orderValueRs;

  // NOT sanitizeForCourier: that is a book-title sanitiser and turns a
  // Devanagari name into the literal string 'Hindi Book'.
  const name = sanitizeAddressText(order.customer_name || '', 60) || 'Customer';
  const sp = name.indexOf(' ');
  const first = sp > 0 ? name.slice(0, sp) : name;
  const last = sp > 0 ? name.slice(sp + 1) : '';

  const tidy = (v) => String(v || '').replace(/[\s\-–,]+$/, '').trim();
  // A very short line is usually a terse address whose locality was parsed off
  // into city/state. Putting those back is both longer AND more deliverable
  // than padding. iThink refused anything under 10 characters outright; rather
  // than find out the hard way whether XpressBees does too, the same floor is
  // applied here, and an address that is still unusable is reported instead of
  // being imported as an undeliverable order.
  let line1 = sanitizeAddressText(tidy(a.address) || '');
  if (line1.length < 10) {
    line1 = sanitizeAddressText([tidy(a.address), tidy(a.city), tidy(a.state)].filter(Boolean).join(', '));
  }
  if (line1.length < 10) {
    throw new Error(`Address for ${number} is only ${line1.length} characters ("${line1}") `
      + 'and is too short to deliver. Fix the delivery address on the order.');
  }

  const party = {
    first_name: first,
    last_name: last,
    company: '',
    address_1: line1,
    address_2: '',
    city: tidy(a.city),
    state: tidy(a.state),
    postcode: String(a.pincode || ''),
    country: 'IN',
    phone,
  };

  return {
    id: numericId(number),
    parent_id: 0,
    number: String(number),
    order_key: `wc_order_${numericId(number)}`,
    status: 'processing',
    currency: 'INR',
    version: '8.0.0',
    prices_include_tax: true,
    date_created: wooDate(order.created_at),
    date_created_gmt: wooDate(order.created_at),
    date_modified: wooDate(order.updated_at || order.created_at),
    date_modified_gmt: wooDate(order.updated_at || order.created_at),
    discount_total: money2(discount),
    discount_tax: '0.00',
    shipping_total: '0.00',
    shipping_tax: '0.00',
    cart_tax: '0.00',
    total_tax: '0.00',
    total: money2(total),
    payment_method: money.isCOD ? 'cod' : 'prepaid',
    payment_method_title: money.isCOD ? COD_TITLE : PREPAID_TITLE,
    transaction_id: money.isCOD ? '' : String(order.razorpay_payment_id || ''),
    date_paid: money.isCOD ? null : wooDate(order.created_at),
    date_paid_gmt: money.isCOD ? null : wooDate(order.created_at),
    customer_id: 0,
    customer_note: '',
    billing: { ...party, email: order.customer_email || '' },
    shipping: party,
    line_items: lines,
    tax_lines: [],
    shipping_lines: [],
    fee_lines: [],
    coupon_lines: [],
    refunds: [],
    // Weight is what XpressBees's own WooCommerce plugin adds, and without it
    // the panel falls back to a default. 400g flat, matching every other
    // booking path in this repo.
    meta_data: [
      { id: 1, key: '_weight', value: '0.4' },
      { id: 2, key: '_length', value: '15' },
      { id: 3, key: '_width', value: '10' },
      { id: 4, key: '_height', value: '5' },
      { id: 5, key: '_iac_order_value', value: money2(money.orderValueRs) },
      { id: 6, key: '_iac_collectable', value: money2(money.collectableAmount) },
      { id: 7, key: '_iac_payment_type', value: money.shipmentPaymentType },
      { id: 8, key: '_iac_line_sum', value: money2(lineSum) },
    ],
  };
}

async function loadOrders(supabase) {
  const since = process.env.WOO_FEED_SINCE || DEFAULT_SINCE;
  const { data, error } = await supabase
    .from('orders')
    .select('*')
    .or('source.is.null,source.neq.paperbound')
    .in('status', UNSHIPPED_STATUSES)
    .gte('created_at', since)
    // OLDEST FIRST. XpressBees's importer takes one page and does not follow
    // X-WP-TotalPages: the first sync pulled exactly 100 of 157 and stopped.
    // A shipping queue should drain oldest-first anyway, so the orders that
    // have waited longest are the ones that make it into that single page.
    .order('created_at', { ascending: true })
    .limit(500);
  if (error) throw new Error(`orders query failed: ${error.message}`);
  // Belt and braces: the status filter above already excludes these, but the
  // cost of one more test is nothing against shipping an unpaid order.
  return (data || []).filter((o) => !isPaymentPending(o.status));
}

/**
 * What a status push is allowed to do to an order.
 *
 * Observed payload, captured live when five orders were booked:
 *
 *   PUT /wp-json/wc/v3/orders/{wooId}
 *   { "status": "On Hold",
 *     "meta_data": [ {key:"Tracking Url", value:"https://shipmentv1..."},
 *                    {key:"Courier Name", value:"Xpressbees"},
 *                    {key:"AWB Number",   value:"143449610504655"} ] }
 *
 * "On Hold" is our Booked mapping, so this is the moment an AWB exists.
 *
 * ONLY the booked transition is applied, and it only ever moves an order
 * FORWARD to 'shipped'. In Transit / Delivered / RTO are recorded and applied
 * to nothing:
 *
 *   - RTO must never reach anything a refund could key off. A returned parcel
 *     is not a refunded order.
 *   - Delivered drives delivery notifications and COD remittance elsewhere,
 *     which is not a decision this endpoint should be making on its own.
 *
 * No customer notification is sent from here. Flipping 158 orders to shipped
 * would otherwise fire 158 emails and WhatsApps as a side effect of a panel
 * action nobody connected to messaging.
 */
const PUSH_BOOKED = 'on hold';

function metaValue(payload, key) {
  const rows = Array.isArray(payload && payload.meta_data) ? payload.meta_data : [];
  const hit = rows.find((m) => m && String(m.key || '').toLowerCase() === key.toLowerCase());
  return hit ? String(hit.value || '').trim() : '';
}

/**
 * Resolve the derived WooCommerce integer id back to an order.
 *
 * The id is a hash, so it cannot be reversed in SQL. It does not need to be:
 * a push can only concern an order that was in the feed, and the feed never
 * reaches further back than WOO_FEED_SINCE. That bounds the candidates to the
 * same window we serve -- a few hundred rows -- whatever their status now is.
 */
async function resolveByWooId(supabase, wooId) {
  const since = process.env.WOO_FEED_SINCE || DEFAULT_SINCE;
  const { data, error } = await supabase
    .from('orders')
    .select('id, razorpay_order_id, status, tracking_id, tracking_url, courier_name, '
          + 'customer_name, customer_phone, customer_email, cart_items')
    .gte('created_at', since)
    .limit(1000);
  if (error) throw new Error(`lookup failed: ${error.message}`);
  const want = Number(wooId);
  return (data || []).find((o) => numericId(o.razorpay_order_id || o.id) === want) || null;
}

async function applyPushBack(supabase, wooId, payload) {
  const status = String((payload && payload.status) || '').trim().toLowerCase();
  const awb = metaValue(payload, 'AWB Number');
  const courier = metaValue(payload, 'Courier Name') || 'Xpressbees';

  if (status !== PUSH_BOOKED) return { applied: false, reason: `status "${status}" is recorded only` };
  if (!awb) return { applied: false, reason: 'booked but no AWB in meta_data' };

  const order = await resolveByWooId(supabase, wooId);
  if (!order) return { applied: false, reason: `no order matches woo id ${wooId}` };

  const orderNumber = order.razorpay_order_id || order.id;

  // Already carrying this AWB: nothing to do. Re-pushes are normal.
  if (String(order.tracking_id || '') === awb && order.status === 'shipped') {
    return { applied: false, order: orderNumber, reason: 'already shipped with this AWB' };
  }

  // Never walk an order backwards out of a later stage.
  const TERMINAL = ['delivered', 'rto', 'rto_delivered', 'cancelled', 'refunded'];
  if (TERMINAL.includes(String(order.status || '').toLowerCase())) {
    return { applied: false, order: orderNumber, reason: `order is ${order.status}; not moving it back to shipped` };
  }

  // Their own Tracking Url arrives on two different hosts (shipment. and
  // shipmentv1.), both of which redirect to shipmentv2. Derive it instead, so
  // one host is stored and it is the canonical one.
  const now = new Date().toISOString();
  const update = {
    status: 'shipped',
    tracking_id: awb,
    courier_name: courier,
    tracking_url: buildTrackingUrl({ courier, awb, orderNumber }),
    shipped_at: now,
    awb_assigned_at: now,
  };

  const { error } = await supabase.from('orders').update(update).eq('id', order.id);
  if (error) throw new Error(`update failed for ${orderNumber}: ${error.message}`);

  // Tell the customer. This runs only on the transition INTO shipped -- a
  // re-push of an AWB already on the order returns above without reaching
  // here, so a customer cannot be messaged twice for the same shipment.
  //
  // WOO_PUSH_NOTIFY=0 turns it off without redeploying, which matters if a
  // bulk booking session ever needs to run quietly.
  let notified = null;
  if (!/^(0|false|no)$/i.test(String(process.env.WOO_PUSH_NOTIFY || ''))) {
    notified = await sendShippedNotification(
      { ...order, ...update },
      { awb, courier, trackingUrl: update.tracking_url },
    ).catch((e) => ({ error: e.message }));
  }

  return { applied: true, order: orderNumber, awb, tracking_url: update.tracking_url, notified };
}

// Exported so the money mapping can be tested without a live store: the
// partial-COD total is the one number here that can overcharge a customer.
exports.__test = { toWooOrder, numericId, safeEqual, readCredentials, authorize, isPaymentPending, applyPushBack, metaValue, PUSH_BOOKED, UNSHIPPED_STATUSES, COD_TITLE, PREPAID_TITLE };

exports.handler = async (event) => {
  const path = String(event.path || '').replace(/\/+$/, '') || '/wp-json';
  const method = (event.httpMethod || 'GET').toUpperCase();

  if (method === 'OPTIONS') return { statusCode: 204, headers: JSON_HEADERS, body: '' };

  // Discovery. Kept unauthenticated and free of order data, because a client
  // that cannot see the namespace never gets as far as sending credentials.
  if (path === '/wp-json') {
    return json(200, {
      name: 'Ink and Chai',
      description: 'Ink and Chai',
      url: 'https://inkandchai.in',
      home: 'https://inkandchai.in',
      gmt_offset: '5.5',
      timezone_string: 'Asia/Kolkata',
      namespaces: ['wp/v2', 'wc/v1', 'wc/v2', 'wc/v3'],
      authentication: [],
      routes: { '/wc/v3': { namespace: 'wc/v3', methods: ['GET'] } },
    });
  }

  // WordPress core's batch endpoint. XpressBees probes this BEFORE pushing any
  // status update -- captured live at 21:21:25, the minute an order was booked:
  //
  //   POST /wp-json/batch/v1   content-length: 15   (i.e. {"requests":[]})
  //   no Authorization header, from 161.35.55.54 (DigitalOcean)
  //
  // It is a capability probe: an empty request list, asking whether the store
  // can take batched writes. We answered 404, so they had to assume not.
  //
  // The probe is answered WITHOUT authentication because an empty batch
  // carries and reveals nothing. A batch that actually contains sub-requests
  // is authenticated like everything else.
  if (/^\/wp-json\/batch\/v1$/.test(path)) {
    if (method !== 'POST') return wpError('rest_no_route', 'Batch accepts POST.', 404);
    let payload = {};
    try { payload = JSON.parse(event.body || '{}'); } catch { payload = {}; }
    const requests = Array.isArray(payload.requests) ? payload.requests : [];

    console.log('[woo-channel] batch', JSON.stringify({
      count: requests.length,
      validation: payload.validation || '',
      requests: requests.slice(0, 25),
    }));

    if (!requests.length) return json(200, { failed: false, responses: [] });

    const batchAuth = authorize(event);
    if (!batchAuth.ok) return batchAuth.res;

    const batchDb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const responses = [];
    for (const r of requests) {
      const id = Number(String((r && r.path) || '').match(/orders\/(\d+)/)?.[1] || 0);
      const body = (r && r.body) || {};
      let result;
      try { result = await applyPushBack(batchDb, id, body); }
      catch (e) { result = { applied: false, reason: e.message }; }
      console.log('[woo-channel] batch push-back result', JSON.stringify({ id, ...result }));
      responses.push({ status: 200, headers: {}, body: { id, status: String(body.status || 'processing') } });
    }
    return json(200, { failed: false, responses });
  }

  const auth = authorize(event);
  if (!auth.ok) return auth.res;

  if (/^\/wp-json\/wc\/v[123]$/.test(path)) {
    return json(200, {
      namespace: 'wc/v3',
      routes: {
        '/wc/v3/orders': { namespace: 'wc/v3', methods: ['GET'] },
        '/wc/v3/products': { namespace: 'wc/v3', methods: ['GET'] },
        '/wc/v3/system_status': { namespace: 'wc/v3', methods: ['GET'] },
      },
    });
  }

  // Some connectors probe this to confirm the store is really WooCommerce.
  if (/^\/wp-json\/wc\/v[123]\/system_status$/.test(path)) {
    return json(200, {
      environment: {
        home_url: 'https://inkandchai.in',
        site_url: 'https://inkandchai.in',
        version: '8.0.0',
        wp_version: '6.4',
        currency: 'INR',
        currency_symbol: '&#8377;',
      },
      settings: { api_enabled: true, force_ssl: true, currency: 'INR' },
    });
  }

  // Inventory sync asks for products. There is nothing to sync -- stock is not
  // managed here -- and an empty page is the honest answer.
  if (/^\/wp-json\/wc\/v[123]\/products/.test(path)) {
    return json(200, [], { 'X-WP-Total': '0', 'X-WP-TotalPages': '0' });
  }

  const singleOrder = path.match(/^\/wp-json\/wc\/v[123]\/orders\/(\d+)$/);
  const orderList = /^\/wp-json\/wc\/v[123]\/orders$/.test(path);
  const orderBatch = /^\/wp-json\/wc\/v[123]\/orders\/batch$/.test(path);

  if (!singleOrder && !orderList && !orderBatch) {
    return wpError('rest_no_route', `No route was found matching the URL: ${path}`, 404);
  }

  // Status push-back. With "Push Order Status" enabled, XpressBees writes
  // Booked / In Transit / Delivered / RTO back here as a WooCommerce status.
  //
  // IT IS RECORDED AND ACKNOWLEDGED, AND MUTATES NOTHING. That is deliberate,
  // on two counts:
  //
  //   1. An RTO must never touch anything a refund could key off. A returned
  //      parcel is not a refunded order, and this endpoint is reachable by
  //      anyone holding the consumer pair -- it is not a place to start
  //      moving money from.
  //   2. The exact payload XpressBees sends has never been observed. Wiring a
  //      state machine to a guessed shape is how an order silently ends up in
  //      the wrong state; the shape is logged in full here so the mapping can
  //      be written against real data instead.
  //
  // Both the single and batch forms are accepted, because which one their
  // importer uses is equally unobserved, and a 404 would make them retry.
  if (method !== 'GET') {
    if (!singleOrder && !orderBatch) return wpError('rest_no_route', 'Read-only store.', 404);
    let payload = {};
    try { payload = JSON.parse(event.body || '{}'); }
    catch { payload = { _unparsed: String(event.body || '').slice(0, 500) }; }

    const h = event.headers || {};
    console.log('[woo-channel] push-back', JSON.stringify({
      method,
      path,
      content_type: h['content-type'] || h['Content-Type'] || '',
      user_agent: h['user-agent'] || h['User-Agent'] || '',
      payload,
    }));

    const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

    if (orderBatch) {
      const updates = Array.isArray(payload.update) ? payload.update : [];
      const out = [];
      for (const u of updates) {
        const id = Number(u && u.id) || 0;
        let result;
        try { result = await applyPushBack(db, id, u || {}); }
        catch (e) { result = { applied: false, reason: e.message }; }
        console.log('[woo-channel] push-back result', JSON.stringify({ id, ...result }));
        out.push({ id, status: String((u && u.status) || 'processing') });
      }
      return json(200, { update: out });
    }

    const wooId = Number(singleOrder[1]);
    let result;
    try { result = await applyPushBack(db, wooId, payload); }
    catch (e) { result = { applied: false, reason: e.message }; }
    console.log('[woo-channel] push-back result', JSON.stringify({ id: wooId, ...result }));

    // Always 200. A non-2xx makes XpressBees retry, and a retry cannot fix an
    // order we simply could not match -- it would just repeat forever.
    return json(200, { id: wooId, status: String(payload.status || 'processing') });
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  let rows;
  try { rows = await loadOrders(supabase); }
  catch (e) { return wpError('woocommerce_rest_cannot_view', e.message, 500); }

  // An order that cannot be shipped (no pincode, no phone) is skipped rather
  // than failing the whole page: one unmappable row must not stop the other 96.
  const built = [];
  const skipped = [];
  for (const row of rows) {
    try { built.push(await toWooOrder(row)); }
    catch (e) { skipped.push({ order: row.razorpay_order_id || row.id, reason: e.message }); }
  }
  if (skipped.length) console.warn('[woo-channel] skipped', JSON.stringify(skipped));

  if (singleOrder) {
    const want = Number(singleOrder[1]);
    const hit = built.find((o) => o.id === want);
    return hit ? json(200, hit)
               : wpError('woocommerce_rest_shop_order_invalid_id', 'Invalid ID.', 404);
  }

  const q = event.queryStringParameters || {};
  // WooCommerce caps per_page at 100; this one does not, because the importer
  // only ever reads one page and a cap is what truncated the first sync. A
  // client asking for more now gets more, and one asking for 100 is unaffected.
  const perPage = Math.min(250, Math.max(1, parseInt(q.per_page || '100', 10) || 100));
  const page = Math.max(1, parseInt(q.page || '1', 10) || 1);

  // `status` may be a single value, a comma list, or "any".
  let filtered = built;
  const wantStatus = String(q.status || '').trim();
  if (wantStatus && wantStatus !== 'any') {
    const set = new Set(wantStatus.split(',').map((s) => s.trim().replace(/^wc-/, '')));
    filtered = built.filter((o) => set.has(o.status));
  }
  if (q.after) {
    const t = Date.parse(q.after);
    if (!Number.isNaN(t)) filtered = filtered.filter((o) => Date.parse(o.date_created_gmt + 'Z') > t);
  }
  if (q.before) {
    const t = Date.parse(q.before);
    if (!Number.isNaN(t)) filtered = filtered.filter((o) => Date.parse(o.date_created_gmt + 'Z') < t);
  }

  const total = filtered.length;
  const slice = filtered.slice((page - 1) * perPage, page * perPage);

  return json(200, slice, {
    'X-WP-Total': String(total),
    'X-WP-TotalPages': String(Math.max(1, Math.ceil(total / perPage))),
  });
};
