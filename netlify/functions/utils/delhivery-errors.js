/**
 * Turn a Delhivery refusal into something a person can act on.
 *
 * Every refusal from their create API arrives wrapped in the same boilerplate:
 *
 *   Crashing while saving package due to exception '<the actual reason>'.
 *   Package might have been partially saved.
 *
 * Shown raw, a wallet running dry and a pincode they will not serve look
 * identical at a glance -- both "crashing", both "partially saved" -- and the
 * one that matters (recharge, then retry the same orders) is lost in a list of
 * the one that does not. This pulls the real reason out and says what to do.
 *
 * The raw text is always kept alongside: this is a reading aid, not a
 * replacement for what Delhivery said.
 */

const KINDS = {
  wallet: {
    title: 'Delhivery wallet is empty',
    action: 'Recharge the Delhivery wallet, then push again. These orders are fine and will book as-is.',
  },
  pincode: {
    title: 'Delhivery refused the pincode',
    action: 'Retrying will not help. Ship with another courier, or ask your Delhivery account manager to open this pincode — their published serviceability list can include pincodes their booking API still refuses.',
  },
  duplicate: {
    title: 'Delhivery already holds this order number',
    action: 'Check the Delhivery panel for an existing shipment before retrying. If it was cancelled there, push again with a suffix so the number is new.',
  },
  pickup: {
    title: 'Pickup warehouse not recognised',
    action: 'DELHIVERY_PICKUP_NAME must match the warehouse name in the Delhivery panel exactly — case and spaces included.',
  },
  address: {
    title: 'Delhivery rejected the address',
    action: 'Fix the customer\'s address on the order, then push again.',
  },
  phone: {
    title: 'Delhivery rejected the phone number',
    action: 'Correct the customer\'s phone number on the order, then push again.',
  },
  network: {
    title: 'Could not reach Delhivery',
    action: 'Nothing was booked for this batch. Push again in a minute.',
  },
  other: {
    title: 'Delhivery refused the order',
    action: 'Read Delhivery\'s message below. If it is unclear, try this one order again on its own.',
  },
};

/** The reason inside their "Crashing while saving package ..." wrapper, or the text itself. */
function innerReason(raw) {
  const s = String(raw == null ? '' : raw).trim();
  const m = s.match(/due to exception\s+'([\s\S]*?)'\.?\s*(?:Package might have been partially saved\.?)?\s*$/i);
  return (m ? m[1] : s).trim();
}

function kindOf(reason) {
  const r = reason.toLowerCase();
  if (/insufficient balance|wallet|recharge|low balance/.test(r)) return 'wallet';
  if (/non[\s-]?serviceable|not serviceable|pincode.*(not|un)serv/.test(r)) return 'pincode';
  if (/duplicate|already exists|order id.*exists|already been used/.test(r)) return 'duplicate';
  if (/pickup|warehouse|client[\s-]?warehouse/.test(r)) return 'pickup';
  if (/phone|mobile/.test(r)) return 'phone';
  if (/address|city|state/.test(r)) return 'address';
  if (/timed? ?out|econn|fetch failed|network|socket|5\d\d/.test(r)) return 'network';
  return 'other';
}

/**
 * { kind, title, reason, action, raw }
 *   kind    one of the KINDS keys -- stable, safe to group on
 *   title   one line a person can read
 *   reason  Delhivery's own words, without the wrapper
 *   action  what to do next
 *   raw     exactly what came back
 */
function explain(raw) {
  const reason = innerReason(raw) || 'no reason given';
  const kind = kindOf(reason);
  return { kind, title: KINDS[kind].title, reason, action: KINDS[kind].action, raw: String(raw == null ? '' : raw) };
}

module.exports = { explain, innerReason, KINDS };
