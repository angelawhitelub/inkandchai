/**
 * Background worker for scheduled recommendation broadcasts. The `-background`
 * suffix gives this campaign the longer Netlify background-function runtime.
 * Authentication is still enforced by the normal broadcast handler.
 */
const { handler: broadcastHandler } = require('./whatsapp-broadcast');

exports.handler = event => broadcastHandler({
  ...event,
  path:'/.netlify/functions/whatsapp-broadcast',
});
