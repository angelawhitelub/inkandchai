const { requireAdmin } = require('./utils/admin-auth');
const { loadPromotions, savePromotions, normalizePromotion, cleanCode } = require('./utils/promotions');
const headers = { 'Access-Control-Allow-Origin':'*', 'Access-Control-Allow-Headers':'Content-Type, X-Admin-Key, X-Admin-Token', 'Content-Type':'application/json', 'Cache-Control':'no-store' };
const json = (statusCode, body) => ({ statusCode, headers, body:JSON.stringify(body) });
exports.handler = async event => {
  if (event.httpMethod === 'OPTIONS') return { statusCode:204, headers, body:'' };
  const block = requireAdmin(event, headers); if (block) return block;
  try {
    let rows = await loadPromotions({ fresh:true });
    if (event.httpMethod === 'GET') return json(200, { promotions:rows });
    if (event.httpMethod === 'POST') {
      const body = JSON.parse(event.body || '{}');
      if (body.action === 'end' || body.action === 'pause' || body.action === 'activate') {
        const index = rows.findIndex(p => p.id === body.id);
        if (index < 0) return json(404, { error:'Promotion not found.' });
        rows[index] = { ...rows[index], status:body.action === 'activate' ? 'active' : body.action === 'pause' ? 'paused' : 'ended', ended_at:body.action === 'end' ? new Date().toISOString() : rows[index].ended_at, updated_at:new Date().toISOString() };
      } else {
        const promotion = normalizePromotion({ ...body, updated_at:new Date().toISOString() });
        if (promotion.code.length < 3) return json(400, { error:'Coupon code must contain at least 3 letters or numbers.' });
        if (!(promotion.discount_value > 0) || (promotion.discount_type === 'percent' && promotion.discount_value > 100)) return json(400, { error:'Enter a valid discount.' });
        if (!promotion.payment_methods.length) return json(400, { error:'Select at least one payment method.' });
        if (promotion.scope === 'selected' && !promotion.product_slugs.length) return json(400, { error:'Add at least one product slug.' });
        const index = rows.findIndex(p => p.id === promotion.id || cleanCode(p.code) === promotion.code);
        if (index >= 0) rows[index] = { ...promotion, id:rows[index].id, created_at:rows[index].created_at };
        else rows.unshift(promotion);
      }
      rows = await savePromotions(rows);
      return json(200, { promotions:rows });
    }
    if (event.httpMethod === 'DELETE') {
      const id = String(event.queryStringParameters?.id || '');
      rows = rows.filter(p => p.id !== id);
      rows = await savePromotions(rows);
      return json(200, { promotions:rows });
    }
    return json(405, { error:'Method Not Allowed' });
  } catch (err) { console.error('admin-promotions:', err); return json(500, { error:err.message }); }
};
