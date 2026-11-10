/**
 * Stop an XpressBees parcel at XpressBees BEFORE a customer's cancellation
 * changes the order. Used by cancel-order (My Orders) and the WhatsApp bot.
 */
const { cancelCourierShipment } = require('./courier-shipment-cancel');

// XpressBees AWBs are stopped at XpressBees BEFORE the order is cancelled.
// The cancellation used to ask only NimbusPost, whatever the courier: on
// 10 Nov 2026, 38 COD orders cancelled from My Orders were still live with
// XpressBees, 9 of them delivered, because NimbusPost cannot cancel an
// XpressBees AWB. Courier first, so a parcel we cannot stop is never left
// behind a "cancelled" order:
//   stopped / already cancelled  -> go ahead and cancel the order
//   picked up meanwhile          -> refuse, as for any picked-up parcel
//   courier unreachable / error  -> refuse, ask the customer to retry or WhatsApp us
const isXpressbees = (order) => /xpress|xbees/i.test(String(order?.courier_name || ''));

async function stopXpressbeesFirst(order, deps = {}) {
  const r = await (deps.cancelCourierShipment || cancelCourierShipment)(order, deps);
  if (r.action === 'cancelled' || r.action === 'already_cancelled') return { ok: true, result: r };
  if (r.action === 'moving') return { ok: false, moved: true, result: r };
  return { ok: false, moved: false, result: r };
}

module.exports = { stopXpressbeesFirst, isXpressbees };
