const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { makeSlug } = require('./utils/pricing');
const { proxifySupabaseImage } = require('./utils/supabase-img');
const { deletedSlugSet } = require('./utils/deleted-products');
const { MAX_AGE_MS, STATUSES, slugOf, eligible, project } = require('./utils/recent-purchases');
let catalog;
function getCatalog() {
  if (catalog) return catalog;
  const rows = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data/ALL_BOOKS.json'), 'utf8'));
  catalog = new Map(rows.map(b => [makeSlug(b.title,b.shopify_id).toLowerCase(), {title:b.title,img:proxifySupabaseImage(b.image_url)}]));
  return catalog;
}
const headers = { 'Content-Type':'application/json', 'Cache-Control':'no-store' };
exports.handler = async event => {
  if (event.httpMethod !== 'GET') return {statusCode:405,headers:{...headers,Allow:'GET'},body:'{"error":"GET only"}'};
  try {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) throw new Error('Unavailable');
    const db = createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
    const now = Date.now();
    // Same orders table and store boundary as the admin; no contact/address or
    // payment credentials are selected, and identifiers never leave the server.
    const {data,error} = await db.from('orders')
      .select('id,customer_name,created_at,status,source,cart_items,amount_paise')
      .or('source.is.null,source.neq.paperbound').in('status',STATUSES)
      .gte('created_at',new Date(now-MAX_AGE_MS).toISOString())
      .order('created_at',{ascending:false}).limit(100);
    if(error) throw error;
    const orders = (data||[]).filter(o => eligible(o,now));
    const slugs = [...new Set(orders.flatMap(o => o.cart_items.map(slugOf)).filter(Boolean))].slice(0,200);
    const products = new Map(getCatalog());
    if(slugs.length) {
      const result = await db.from('custom_products').select('slug,title,image_url,is_active')
        .or(slugs.map(s => `slug.ilike.${s}`).join(','));
      if(result.error) throw result.error;
      for(const p of result.data||[]) {
        const slug = p.slug.toLowerCase();
        if(p.is_active === true) products.set(slug,{title:p.title,img:proxifySupabaseImage(p.image_url)});
        else products.delete(slug);
      }
    }
    const purchases = project(orders,products,await deletedSlugSet(),now,process.env.SUPABASE_SERVICE_KEY);
    return {statusCode:200,headers:{...headers,'Netlify-CDN-Cache-Control':'public, s-maxage=15'},body:JSON.stringify({generated_at:new Date(now).toISOString(),purchases})};
  } catch(error) {
    console.warn('[recent-purchases] Feed unavailable');
    return {statusCode:503,headers,body:JSON.stringify({purchases:[],error:'Recent purchases unavailable'})};
  }
};
