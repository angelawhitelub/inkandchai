const { verifyAdminToken } = require('./utils/admin-auth');
const { requireConfig, exchangeCode, encrypt, gmailFetch, saveIntegration } = require('./utils/gmail');
exports.handler = async (event) => {
  const q = event.queryStringParameters || {};
  const state = verifyAdminToken(q.state || '');
  if (!state || state.sub !== 'gmail-oauth' || state.role !== 'owner') return {statusCode:400,headers:{'Content-Type':'text/html'},body:'Invalid or expired Gmail authorization state.'};
  if (q.error) return {statusCode:400,headers:{'Content-Type':'text/html'},body:`Gmail authorization was cancelled: ${q.error}`};
  try {
    requireConfig();
    const token = await exchangeCode(q.code || '');
    const profile = await gmailFetch('/profile', token.access_token);
    await saveIntegration({ email: profile.emailAddress, refresh_token_encrypted: encrypt(token.refresh_token), history_id: profile.historyId || null, enabled: true });
    const site = String(process.env.URL || process.env.SITE_URL || 'https://inkandchai.in').replace(/\/$/,'');
    return {statusCode:302,headers:{Location:`${site}/admin/#adminaccess?gmail=connected`},body:''};
  } catch (e) { console.error('[gmail-oauth-callback]',e.message); return {statusCode:500,headers:{'Content-Type':'text/html'},body:`Gmail setup failed: ${e.message}`}; }
};
