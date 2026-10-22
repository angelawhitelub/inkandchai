/**
 * Scheduled: xpressbees-labels-send-scheduled -- 09:00 and 14:00 IST (jobs.toml)
 *
 * WhatsApps the packing team the sorted XpressBees label PDF
 * (admin-xpressbees-labels.js + utils/label-sort.js): every shipment in the
 * panel's Ready to Pickup tab that has NOT been sent to them before. The send,
 * its config (LABEL_PHONES, LABEL_TEMPLATE) and the owner POST
 * ({ dry_run?, all? }) are in utils/labels-whatsapp.js.
 *
 * READ-ONLY at XpressBees.
 */

const { makeLabelSender, deliver } = require('./utils/labels-whatsapp');
const { _test: labels } = require('./admin-xpressbees-labels');

const sender = makeLabelSender({
  name: 'XpressBees', slug: 'xpressbees', sentKey: 'xb-labels-sent:v1',
  adminButton: 'XpressBees Labels (sorted)', labels,
});

exports.handler = sender.handler;
exports._test = { sendLabels: sender.sendLabels, readSent: sender.readSent, markSent: sender.markSent, deliver, SENT_KEY: sender.SENT_KEY };
