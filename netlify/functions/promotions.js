const { loadPromotions, publicPromotion } = require('./utils/promotions');
const headers = { 'Access-Control-Allow-Origin':'*', 'Content-Type':'application/json', 'Cache-Control':'no-store' };
exports.handler = async event => {
  if (event.httpMethod === 'OPTIONS') return { statusCode:204, headers, body:'' };
  if (event.httpMethod !== 'GET') return { statusCode:405, headers, body:JSON.stringify({ error:'Method Not Allowed' }) };
  try {
    const requested = String(event.queryStringParameters?.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const rows = (await loadPromotions()).filter(p => requested ? p.code === requested : !p.private).map(publicPromotion);
    return { statusCode:200, headers, body:JSON.stringify({ promotions:rows }) };
  } catch (err) { return { statusCode:500, headers, body:JSON.stringify({ error:err.message }) }; }
};
