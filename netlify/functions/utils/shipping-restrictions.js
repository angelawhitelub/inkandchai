const { extractPincode } = require('./pincode-valid');

const STATE_TAG = 'shipping-exclude-state:';
const PIN_TAG = 'shipping-exclude-pin:';

function normalizeState(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function displayState(value) {
  return String(value || '').split('-').filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1)).join(' ');
}

function parseShippingRestrictionTags(tags) {
  const states = [];
  const pins = [];
  for (const raw of String(tags || '').split(',')) {
    const tag = raw.trim().toLowerCase();
    if (tag.startsWith(STATE_TAG)) {
      const state = normalizeState(tag.slice(STATE_TAG.length));
      if (state && !states.includes(state)) states.push(state);
    } else if (tag.startsWith(PIN_TAG)) {
      const pin = tag.slice(PIN_TAG.length).replace(/[^0-9*]/g, '');
      if (/^(?:[1-9]\d{5}|[1-9]\d{1,4}\*)$/.test(pin) && !pins.includes(pin)) pins.push(pin);
    }
  }
  return { states, pins };
}

function normalizeShippingRule(rule) {
  const states = [];
  const pins = [];
  for (const value of (Array.isArray(rule?.excluded_states) ? rule.excluded_states : (rule?.states || []))) {
    const state = normalizeState(value);
    if (state && !states.includes(state)) states.push(state);
  }
  for (const value of (Array.isArray(rule?.excluded_pincodes) ? rule.excluded_pincodes : (rule?.pins || []))) {
    const pin = String(value || '').replace(/[^0-9*]/g, '');
    if (/^(?:[1-9]\d{5}|[1-9]\d{1,4}\*)$/.test(pin) && !pins.includes(pin)) pins.push(pin);
  }
  return { states, pins };
}

// PIN prefix truth is used for the two state-wide restrictions requested by
// the store. It cannot be bypassed by changing the free-text city/state.
function stateFromPincode(pin) {
  const value = String(pin || '');
  if (/^11\d{4}$/.test(value)) return 'delhi';
  if (/^(?:12|13)\d{4}$/.test(value)) return 'haryana';
  return '';
}

function pinMatches(rule, pin) {
  const value = String(rule || '');
  if (value.endsWith('*')) return String(pin || '').startsWith(value.slice(0, -1));
  return value === String(pin || '');
}

function findShippingRestriction(cart, customer) {
  const pin = extractPincode(customer);
  const pinState = stateFromPincode(pin);
  const address = `-${normalizeState(`${customer?.state || ''} ${customer?.address || ''}`)}-`;

  for (const item of (Array.isArray(cart) ? cart : [])) {
    const rules = item?._shipping_restrictions || { states: [], pins: [] };
    const blockedPin = rules.pins?.find(rule => pinMatches(rule, pin));
    const blockedState = rules.states?.find(state =>
      state === pinState || (state && address.includes(`-${state}-`))
    );
    if (blockedPin || blockedState) {
      const region = blockedState ? displayState(blockedState) : `PIN ${pin}`;
      return {
        blocked: true,
        code: 'product_shipping_restricted',
        title: item.title || 'A product in your cart',
        region,
        pin,
        error: `${item.title || 'A product in your cart'} cannot be delivered to ${region}. Please remove it or use a different delivery address.`,
      };
    }
  }
  return { blocked: false };
}

module.exports = {
  parseShippingRestrictionTags,
  normalizeShippingRule,
  findShippingRestriction,
  normalizeState,
  stateFromPincode,
};
