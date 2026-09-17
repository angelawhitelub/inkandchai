/**
 * The one place that decides which tracking link a customer is sent.
 *
 * WHY THIS EXISTS
 * ---------------
 * There were three implementations and they disagreed:
 *
 *   update-order-status.js  buildTrackingUrl(courier, trackingId)
 *   order-tracking.js       buildTrackingUrl(awb, courierName)   <- ARGS SWAPPED
 *   bulk-update-orders.js   ignored its own courier table and always
 *                           returned NimbusPost, on the comment "All orders
 *                           ship via NimbusPost"
 *
 * That last one stopped being true when shipping moved off NimbusPost, so
 * every customer notification sent through the bulk path carried a NimbusPost
 * link for a shipment NimbusPost never carried. The two survivors also
 * disagreed about XpressBees' own URL (/track?awbNo= vs /shipment/tracking?awb=).
 *
 * The arguments are an OBJECT, not positional, because the swapped-argument
 * bug above is invisible at the call site when both parameters are strings.
 *
 * WHICH XPRESSBEES URL
 * --------------------
 * Not the ones on xpressbees.com. Checked live, BOTH of those
 * (/track?awbNo= and /shipment/tracking?awb=) drop the AWB, redirect to the
 * site root, and put a CAPTCHA in front of an empty form -- the customer has
 * to retype their tracking number and prove they are human.
 *
 * The working one is on the shipping platform:
 *
 *     https://shipmentv2.xpressbees.com/orders/tracking/{awb}
 *
 * Verified in a browser with no XpressBees session: it renders the order
 * number, courier, status and full scan history, with no login and no CAPTCHA.
 *
 * It takes the AWB ONLY. The page's own form says "AWB number or Order ID",
 * but putting our order number in the path returns "Invalid Awb no", so an
 * order with no AWB yet cannot be linked this way and falls back to our own
 * /track/ page.
 *
 * Couriers whose own pages DO accept an AWB keep their direct links.
 */

const SITE = 'https://inkandchai.in';

// Couriers whose public tracking page genuinely deep-links to an AWB.
const DIRECT = {
  amazon:       'https://track.amazon.in/tracking/{id}?trackingId={id}',
  bluedart:     'https://www.bluedart.com/tracking?trackingNumber={id}',
  dtdc:         'https://www.dtdc.in/tracking/tracking_results.asp?action=track&Type=awb&strCnno={id}',
  delhivery:    'https://www.delhivery.com/track-v2/package/{id}',
  indiapost:    'https://www.indiapost.gov.in/_layouts/15/dop.portal.tracking/trackconsignment.aspx?id={id}',
  ecomexpress:  'https://ecomexpress.in/tracking/?awb_field={id}',
  shadowfax:    'https://shadowfax.in/tracking/?awb={id}',
  shiprocket:   'https://shiprocket.co/tracking/{id}',
  professional: 'https://www.tpcindia.com/Tracking2/Tracking2.aspx?cnno={id}',
};

const xpressbeesPage = (awb) =>
  `https://shipmentv2.xpressbees.com/orders/tracking/${encodeURIComponent(String(awb))}`;

const ownPage = (orderNumber) =>
  `${SITE}/track/?id=${encodeURIComponent(String(orderNumber))}`;

const nimbusPage = (awb) =>
  `https://ship.nimbuspost.com/shipping/tracking/${encodeURIComponent(String(awb))}`;

/**
 * @param {object}  o
 * @param {string}  o.courier      courier_name as stored on the order
 * @param {string}  o.awb          tracking_id
 * @param {string}  o.orderNumber  razorpay_order_id, for the self-hosted page
 * @param {string} [o.stored]      an existing tracking_url, if any
 * @returns {string} '' when there is nothing trackable yet
 */
function buildTrackingUrl({ courier = '', awb = '', orderNumber = '', stored = '' } = {}) {
  // Whoever booked the shipment knew which carrier it went to, and wrote the
  // link at that moment. That beats anything re-derived later from a courier
  // name that may be blank, renamed, or reused.
  if (stored) return String(stored);

  const id = String(awb || '').trim();
  const key = String(courier || '').toLowerCase().replace(/[\s._-]+/g, '');

  // Nothing to track by AWB yet. The order page still works, and is the only
  // honest thing to send: it shows the order whether or not it has shipped.
  if (!id) return orderNumber ? ownPage(orderNumber) : '';

  // Legacy NimbusPost shipments. Their AWBs are only resolvable on the
  // NimbusPost portal, so those orders keep their working links. This is
  // matched EXPLICITLY and is never the fallback, which is how every order
  // ended up with a NimbusPost link in the first place.
  if (key.includes('nimbus') || key.includes('ekart')) return nimbusPage(id);

  for (const name of Object.keys(DIRECT)) {
    if (key.includes(name)) return DIRECT[name].split('{id}').join(encodeURIComponent(id));
  }

  // XpressBees: the shipping-platform page, which deep-links and needs no login.
  if (key.includes('xpressbees') || key.includes('xbees')) return xpressbeesPage(id);

  // An unrecognised courier. We know there is an AWB but not whose it is, so
  // our own order page is the only honest link -- and NEVER NimbusPost, which
  // is exactly the fallback that put dead links on XpressBees parcels.
  if (orderNumber) return ownPage(orderNumber);
  return '';
}

module.exports = { buildTrackingUrl, DIRECT, ownPage, nimbusPage, xpressbeesPage };
