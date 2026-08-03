const { requireAdmin, getAdminPayload, signAdminToken } = require('./utils/admin-auth');
const { requireConfig, oauthUrl } = require('./utils/gmail');
const CORS = {'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'Content-Type, X-Admin-Key, X-Admin-Token','Content-Type':'application/json'};
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return {statusCode:204,headers:CORS,body:''};
  const block = requireAdmin(event, CORS); if (block) return block;
  const p = getAdminPayload(event); if (p?.role && p.role !== 'owner') return {statusCode:403,headers:CORS,body:JSON.stringify({error:'Owner access required'})};
  try { requireConfig(); const state = signAdminToken({sub:'gmail-oauth',role:'owner',ttlMs:10*60*1000}); return {statusCode:200,headers:CORS,body:JSON.stringify({url:oauthUrl(state)})}; }
  catch (e) { return {statusCode:503,headers:CORS,body:JSON.stringify({error:e.message})}; }
};
