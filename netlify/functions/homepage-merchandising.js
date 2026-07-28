const { createClient } = require('@supabase/supabase-js');
const { proxifySupabaseImage } = require('./utils/supabase-img');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json',
};

// Mirrors the order set used by Admin → Reports → Top Books This Month.
const REPORT_STATUSES = [
  'paid', 'delivered', 'shipped', 'out_for_delivery', 'confirmed',
  'cod_pending', 'partial_cod_pending', 'partial_cod',
  'pending_phonepe', 'pending_partial_phonepe',
];

function indiaMonthStart() {
  const offsetMinutes = 330;
  const indiaNow = new Date(Date.now() + offsetMinutes * 60 * 1000);
  return new Date(Date.UTC(indiaNow.getUTCFullYear(), indiaNow.getUTCMonth(), 1)
    - offsetMinutes * 60 * 1000).toISOString();
}

function slugFromItem(item) {
  const direct = String(item?.slug || '').trim();
  if (direct) return direct;
  const match = String(item?.url || item?.id || '').match(/\/product\/([^/?#]+)/i);
  return match ? match[1] : '';
}

function titleKey(value) {
  return String(value || '').toLowerCase().normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

async function monthOrders(supabase) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from('orders')
      .select('cart_items')
      .in('status', REPORT_STATUSES)
      .gte('created_at', indiaMonthStart())
      .range(from, from + 999);
    if (error) throw error;
    rows.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return rows;
}

function aggregateBestsellers(orders) {
  const sold = new Map();
  for (const order of orders) {
    for (const item of Array.isArray(order.cart_items) ? order.cart_items : []) {
      const title = String(item.title || item.name || '').trim();
      if (!title) continue;
      const slug = slugFromItem(item);
      const key = slug ? `s:${slug.toLowerCase()}` : `t:${titleKey(title)}`;
      const qty = Math.max(1, Number(item.qty) || 1);
      const current = sold.get(key) || {
        slug,
        title,
        author: String(item.author || ''),
        url: String(item.url || (slug ? `/product/${slug}/` : '')),
        img: proxifySupabaseImage(String(item.img || '')),
        price: Number(item.price) || 0,
        qty: 0,
      };
      current.qty += qty;
      sold.set(key, current);
    }
  }
  return [...sold.values()].sort((a, b) => b.qty - a.qty || a.title.localeCompare(b.title)).slice(0, 24);
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'GET') return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method Not Allowed' }) };

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ new_arrivals: [], bestsellers: [] }) };
  }

  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const [orders, productsResult] = await Promise.all([
      monthOrders(supabase),
      supabase
        .from('custom_products')
        .select('slug,title,author,category,description,price_inr,original_price_inr,image_url,publisher,isbn,tags,is_active,created_at,updated_at')
        .eq('is_active', true)
        .not('tags', 'ilike', '%crossword-catalog%')
        .not('tags', 'ilike', '%99bookstores-catalog%')
        .order('created_at', { ascending: false })
        .limit(24),
    ]);
    if (productsResult.error) throw productsResult.error;

    const newArrivals = (productsResult.data || []).map(product => ({
      ...product,
      description: String(product.description || '').slice(0, 160),
      image_url: proxifySupabaseImage(product.image_url),
      tags: '',
    }));

    const headers = {
      ...CORS,
      'Cache-Control': 'public, max-age=300, stale-while-revalidate=300',
      'Netlify-CDN-Cache-Control': 'public, durable, s-maxage=900, stale-while-revalidate=3600',
    };
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        generated_at: new Date().toISOString(),
        period: 'this_month',
        new_arrivals: newArrivals,
        bestsellers: aggregateBestsellers(orders),
      }),
    };
  } catch (error) {
    console.error('[homepage-merchandising]', error.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: error.message }) };
  }
};

exports._test = { indiaMonthStart, slugFromItem, titleKey, aggregateBestsellers };
