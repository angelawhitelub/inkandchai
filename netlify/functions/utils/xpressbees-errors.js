'use strict';

/**
 * What an XpressBees booking failure means and what to do about it.
 *
 * The API's own words are short and some of them mislead: "Order number
 * already in use" reads like a bug, but it means the panel already holds the
 * order (imported by the Sales Channel) and it should be shipped from there.
 * The admin "Book on XpressBees" screen groups failures by `kind` and shows the
 * title and action, with XpressBees' exact text one click away.
 *
 * Order matters: the first pattern that matches wins.
 */
const KINDS = [
  {
    kind: 'wallet',
    test: /wallet|insufficient|balance|recharge|low fund|not enough/i,
    title: 'XpressBees wallet is out of money',
    action: 'Recharge the XpressBees wallet, then book again. Orders not yet sent are untouched.',
  },
  {
    kind: 'auth',
    test: /login failed|unauthori[sz]ed|invalid token|token expired|XPRESSBEES_EMAIL|XPRESSBEES_PASSWORD/i,
    title: 'Could not sign in to XpressBees',
    action: 'Check the XPRESSBEES_EMAIL / XPRESSBEES_PASSWORD Worker secrets match the XpressBees API login. Nothing was booked.',
  },
  {
    kind: 'in_panel',
    test: /order number already in use|already exists|duplicate order/i,
    title: 'Already in the XpressBees panel',
    action: 'The Sales Channel already imported these. Ship them from the panel (Orders → Pending → Ship) so they are not booked twice.',
  },
  {
    kind: 'no_service',
    test: /^Courier \S+ is not serviceable for this pincode/i,
    title: 'The chosen service is not offered at this pincode',
    action: 'Pick "Cheapest available XpressBees service" to book them on what is offered (shown below), or use another courier.',
  },
  {
    kind: 'pincode',
    test: /not servic|non[- ]?servic|pincode not|no xpressbees service|drop pincode/i,
    title: 'XpressBees does not deliver to this pincode',
    action: 'Ship these with another courier (NimbusPost, iThink or Delhivery).',
  },
  {
    kind: 'address',
    test: /pincode|address|6-digit/i,
    title: 'The address needs fixing',
    action: 'Correct the address on the order (one clear 6-digit pincode), then book again.',
  },
  {
    kind: 'phone',
    test: /phone|mobile/i,
    title: 'The phone number needs fixing',
    action: 'Correct the customer phone to a 10-digit Indian mobile number, then book again.',
  },
  {
    kind: 'network',
    test: /timed? ?out|timeout|ECONN|fetch failed|network|socket|\b5\d\d\b|bad gateway|unavailable/i,
    title: 'XpressBees did not answer',
    action: 'Usually temporary. Book again in a few minutes; an order that did get an AWB will be skipped, not booked twice.',
  },
];

const OTHER = {
  kind: 'other',
  title: 'XpressBees refused the order',
  action: 'Read XpressBees’ exact response below. Fix the order or ship it another way.',
};

function classifyXbError(message) {
  const text = String(message || '');
  const hit = KINDS.find((k) => k.test.test(text)) || OTHER;
  return { kind: hit.kind, title: hit.title, action: hit.action };
}

/** "Available: 4=Xpressbees 10 K.G, 6=Air ..." -> [{id, name}] */
function availableServices(message) {
  const m = String(message || '').match(/Available:\s*(.+)$/);
  if (!m) return [];
  return m[1].split(/,\s*/).map((s) => {
    const [id, ...rest] = s.split('=');
    return { id: id.trim(), name: rest.join('=').trim() };
  }).filter((x) => x.id && x.name);
}

module.exports = { classifyXbError, availableServices, KINDS };
