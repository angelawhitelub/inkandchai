const { r2Configured, r2Config, r2PutObject } = require('./r2-put');

const OBJECT_KEY = 'site-config/promotions.json';

const DEFAULT_PROMOTIONS = [
  { id:'inklove10', name:'10% prepaid discount', code:'INKLOVE10', discount_type:'percent', discount_value:10, min_subtotal_inr:499, scope:'all', product_slugs:[], payment_methods:['prepaid'], auto_apply:false, status:'active' },
  { id:'499hit', name:'10% prepaid discount', code:'499HIT', discount_type:'percent', discount_value:10, min_subtotal_inr:499, scope:'all', product_slugs:[], payment_methods:['prepaid'], auto_apply:false, status:'active' },
  { id:'save12', name:'12% prepaid discount', code:'SAVE12', discount_type:'percent', discount_value:12, min_subtotal_inr:999, scope:'all', product_slugs:[], payment_methods:['prepaid'], auto_apply:false, status:'active' },
  { id:'save15', name:'15% prepaid discount', code:'SAVE15', discount_type:'percent', discount_value:15, min_subtotal_inr:1499, scope:'all', product_slugs:[], payment_methods:['prepaid'], auto_apply:false, status:'active' },
  { id:'chai10back', name:'Private 10% recovery discount', code:'CHAI10BACK', discount_type:'percent', discount_value:10, min_subtotal_inr:299, scope:'all', product_slugs:[], payment_methods:['prepaid'], auto_apply:false, status:'active', private:true },
  { id:'freedom-2026', name:'Freedom Sale 2026', code:'FREEDOM', discount_type:'percent', discount_value:15, min_subtotal_inr:400, scope:'all', product_slugs:[], payment_methods:['prepaid','cod','partial_cod'], auto_apply:true, status:'ended', starts_at:'2026-08-13T00:00:00+05:30', ends_at:'2026-08-15T23:59:59+05:30' },
  { id:'summer10-2026', name:'Summer Sale 2026', code:'SUMMER10', discount_type:'percent', discount_value:10, min_subtotal_inr:299, scope:'all', product_slugs:[], payment_methods:['prepaid','cod','partial_cod'], auto_apply:false, status:'ended', ends_at:'2026-05-20T00:00:00+05:30' },
];

const cleanCode = v => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 32);
const itemSlug = item => String(item?.slug || item?.url || item?.id || '').match(/\/product\/([^/?#]+)/i)?.[1] || String(item?.slug || item?.url || item?.id || '').replace(/^\/+|\/+$/g, '');

function normalizePromotion(raw = {}) {
  const methods = Array.isArray(raw.payment_methods) ? raw.payment_methods : ['prepaid'];
  return {
    id: String(raw.id || cleanCode(raw.code).toLowerCase() || `promo-${Date.now()}`).slice(0, 80),
    name: String(raw.name || raw.label || raw.code || 'Promotion').trim().slice(0, 180),
    code: cleanCode(raw.code),
    discount_type: raw.discount_type === 'fixed' ? 'fixed' : 'percent',
    discount_value: Math.max(0, Number(raw.discount_value) || 0),
    min_subtotal_inr: Math.max(0, Number(raw.min_subtotal_inr) || 0),
    max_discount_inr: Math.max(0, Number(raw.max_discount_inr) || 0) || null,
    scope: raw.scope === 'selected' ? 'selected' : 'all',
    product_slugs: [...new Set((raw.product_slugs || []).map(v => String(v).trim()).filter(Boolean))].slice(0, 300),
    payment_methods: [...new Set(methods.filter(v => ['prepaid','cod','partial_cod'].includes(v)))],
    auto_apply: raw.auto_apply === true,
    private: raw.private === true,
    status: ['active','paused','ended'].includes(raw.status) ? raw.status : 'active',
    starts_at: raw.starts_at || null,
    ends_at: raw.ends_at || raw.expires_at || null,
    created_at: raw.created_at || new Date().toISOString(),
    updated_at: raw.updated_at || new Date().toISOString(),
    ended_at: raw.ended_at || null,
  };
}

let cache = null;
let cacheAt = 0;
async function loadPromotions({ fresh = false } = {}) {
  if (!fresh && cache && Date.now() - cacheAt < 15000) return cache;
  let rows = DEFAULT_PROMOTIONS;
  if (r2Configured()) {
    const cfg = r2Config();
    try {
      const res = await fetch(`${cfg.publicBase}/${OBJECT_KEY}?v=${Date.now()}`, { headers:{ accept:'application/json' } });
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data.promotions)) rows = data.promotions;
      }
    } catch (err) { console.warn('promotions read fallback:', err.message); }
  }
  cache = rows.map(normalizePromotion);
  cacheAt = Date.now();
  return cache;
}

async function savePromotions(rows) {
  if (!r2Configured()) throw new Error('R2 is not configured for promotion storage.');
  const promotions = rows.map(normalizePromotion);
  await r2PutObject(r2Config(), { key:OBJECT_KEY, body:JSON.stringify({ version:1, updated_at:new Date().toISOString(), promotions }, null, 2), contentType:'application/json; charset=utf-8' });
  cache = promotions; cacheAt = Date.now();
  return promotions;
}

function isLive(p, now = new Date()) {
  if (p.status !== 'active') return false;
  const t = now.getTime();
  if (p.starts_at && t < new Date(p.starts_at).getTime()) return false;
  if (p.ends_at && t > new Date(p.ends_at).getTime()) return false;
  return true;
}

function calculatePromotion(p, cart, paymentMethod = 'prepaid', now = new Date()) {
  if (!isLive(p, now) || !p.payment_methods.includes(paymentMethod)) return { code:'', discount:0 };
  const allowed = new Set(p.product_slugs);
  const eligible = (cart || []).reduce((sum, item) => {
    if (p.scope === 'selected' && !allowed.has(itemSlug(item))) return sum;
    return sum + (Number(item.price) || 0) * Math.max(1, Number(item.qty) || 1);
  }, 0);
  if (eligible <= 0 || eligible < p.min_subtotal_inr) return { code:'', discount:0 };
  let discount = p.discount_type === 'percent' ? Math.floor(eligible * p.discount_value / 100) : Math.floor(p.discount_value);
  if (p.max_discount_inr) discount = Math.min(discount, p.max_discount_inr);
  discount = Math.min(Math.floor(eligible), Math.max(0, discount));
  return { code:p.code, discount, source:'managed_promotion', label:p.name, promotion:p };
}

async function resolveManagedPromotion(cart, rawCode, paymentMethod = 'prepaid', now = new Date()) {
  const rows = await loadPromotions();
  const code = cleanCode(rawCode);
  let best = { code:'', discount:0 };
  for (const p of rows.filter(p => p.auto_apply)) {
    const hit = calculatePromotion(p, cart, paymentMethod, now);
    if (hit.discount > best.discount) best = hit;
  }
  if (best.discount > 0) return best;
  for (const p of rows.filter(p => code && p.code === code)) {
    const hit = calculatePromotion(p, cart, paymentMethod, now);
    if (hit.discount > best.discount) best = hit;
  }
  return best;
}

function publicPromotion(p) {
  const n = normalizePromotion(p);
  return { ...n, private: undefined, visible: !n.private, is_live:isLive(n) };
}

module.exports = { DEFAULT_PROMOTIONS, normalizePromotion, loadPromotions, savePromotions, isLive, calculatePromotion, resolveManagedPromotion, publicPromotion, cleanCode };
