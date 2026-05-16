const { createClient } = require('@supabase/supabase-js');

function esc(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function moneyText(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? `₹ ${n.toLocaleString('en-IN', { maximumFractionDigits: 0 })}` : '';
}

function shortDescription(product) {
  const fallback = `Buy ${product.title} online at Ink & Chai. Fast pan-India delivery, secure checkout, COD and prepaid payment available.`;
  return String(product.meta_description || product.description || fallback).replace(/\s+/g, ' ').slice(0, 160);
}

function absoluteImage(url) {
  const image = String(url || '/images/og-default.jpg');
  if (image.startsWith('http') || image.startsWith('data:')) return image;
  return `https://inkandchai.in${image.startsWith('/') ? image : `/${image}`}`;
}

function applyOverride(product, override) {
  if (!product || !override || override.is_active === false) return product;
  return {
    ...product,
    title: override.title || product.title,
    author: override.author || product.author,
    category: override.category || product.category,
    price_inr: override.price_inr ?? product.price_inr,
    original_price_inr: override.original_price_inr ?? product.original_price_inr,
  };
}

function productHtml(product) {
  const slug = esc(product.slug);
  const title = esc(product.title);
  const author = esc(product.author || 'Ink & Chai');
  const category = esc(product.category || 'Books');
  const desc = esc(product.description || '');
  const metaDesc = esc(shortDescription(product));
  const canonical = `https://inkandchai.in/product/${slug}/`;
  const image = absoluteImage(product.image_url);
  const price = moneyText(product.price_inr);
  const mrp = moneyText(product.original_price_inr);
  const plainDesc = String(product.description || metaDesc).replace(/\s+/g, ' ');
  const schema = {
    '@context': 'https://schema.org',
    '@type': 'Book',
    name: product.title,
    author: { '@type': 'Person', name: product.author || 'Various' },
    image,
    description: plainDesc,
    isbn: product.isbn || undefined,
    publisher: product.publisher || 'Ink & Chai',
    bookFormat: 'https://schema.org/Paperback',
    url: canonical,
    offers: {
      '@type': 'Offer',
      url: canonical,
      priceCurrency: 'INR',
      price: Number(product.price_inr),
      availability: 'https://schema.org/InStock',
      itemCondition: 'https://schema.org/NewCondition',
      seller: { '@type': 'Organization', name: 'Ink & Chai' },
    },
  };

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${esc(product.seo_title || `${product.title} | Buy Online in India | Ink & Chai`)}</title>
<meta name="description" content="${metaDesc}"/>
<meta name="robots" content="index,follow"/>
<link rel="canonical" href="${canonical}"/>
<meta property="og:type" content="product"/>
<meta property="og:title" content="${title} | Ink & Chai"/>
<meta property="og:description" content="${metaDesc}"/>
<meta property="og:image" content="${esc(image)}"/>
<meta property="og:url" content="${canonical}"/>
<script type="application/ld+json">${JSON.stringify(schema).replace(/</g, '\\u003c')}</script>
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@400;600&family=Montserrat:wght@300;400;600;700&display=swap" rel="stylesheet"/>
<style>
:root{--bg:#faf7f2;--panel:#fff;--gold:#8a6a1f;--cream:#2a2018;--muted:#5a4a38;--border:rgba(138,106,31,.28)}
*{box-sizing:border-box} body{margin:0;background:var(--bg);color:var(--cream);font-family:Montserrat,sans-serif;font-weight:300} a{color:inherit}
.promo{padding:.62rem 1rem;text-align:center;border-bottom:1px solid var(--border);font-size:.68rem;letter-spacing:.12em;text-transform:uppercase;color:var(--muted)} .promo strong{color:var(--gold)}
nav{display:flex;align-items:center;justify-content:space-between;padding:1rem clamp(1rem,4vw,4rem);border-bottom:1px solid var(--border);background:rgba(250,247,242,.96);position:sticky;top:0;z-index:5}.logo{font-family:"Cormorant Garamond",serif;font-size:1.5rem;color:var(--gold);text-decoration:none}.back{font-size:.62rem;letter-spacing:.2em;text-transform:uppercase;color:var(--muted);text-decoration:none}
.wrap{max-width:1260px;margin:0 auto;padding:clamp(1.2rem,4vw,4rem) 1rem 4rem;display:grid;grid-template-columns:minmax(320px,.95fr) 1.05fr;gap:clamp(1.4rem,4vw,4rem);align-items:start}.cover{background:var(--panel);border:1px solid var(--border);padding:clamp(1rem,2.5vw,1.8rem);display:flex;align-items:center;justify-content:center}.cover img{max-width:100%;max-height:600px;object-fit:contain;box-shadow:0 24px 64px rgba(70,52,24,.2)}
.crumb{font-size:.58rem;letter-spacing:.24em;text-transform:uppercase;color:var(--gold);margin-bottom:1rem}h1{font-family:"Cormorant Garamond",serif;font-size:clamp(2rem,5vw,3.4rem);font-weight:400;line-height:1.05;margin:.2rem 0 .6rem}.author{color:var(--muted);letter-spacing:.08em;margin-bottom:1rem}.price{font-family:"Cormorant Garamond",serif;font-size:2.7rem;color:var(--gold);font-weight:600}.orig{color:var(--muted);text-decoration:line-through;margin-left:.8rem}.stock{display:inline-block;margin:1rem 0;color:#237a3b;border:1px solid rgba(35,122,59,.25);padding:.35rem .65rem;font-size:.7rem;letter-spacing:.14em;text-transform:uppercase}
.trust{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:.7rem;margin:1.2rem 0}.trust span{border:1px solid var(--border);background:rgba(138,106,31,.06);padding:.75rem;color:var(--cream);font-size:.78rem}.actions{display:grid;grid-template-columns:1fr 1fr;gap:.8rem;margin:1.3rem 0}button{font:700 .68rem Montserrat,sans-serif;letter-spacing:.2em;text-transform:uppercase;padding:1rem;border:1px solid var(--gold);cursor:pointer}.primary{background:var(--gold);color:#fff}.secondary{background:transparent;color:var(--gold)}
.desc,.details{border-top:1px solid var(--border);padding-top:1.2rem;margin-top:1.2rem;color:var(--muted);font-size:.9rem;line-height:1.8;white-space:pre-line}.label{font-size:.58rem;letter-spacing:.26em;text-transform:uppercase;color:var(--gold);margin-bottom:.5rem}.details dl{display:grid;grid-template-columns:120px 1fr;gap:.5rem 1rem}.details dt{color:var(--gold)}.details dd{margin:0;color:var(--cream)}
@media(max-width:760px){.wrap{display:block;padding-bottom:8rem}.cover{margin-bottom:1.2rem}.trust{grid-template-columns:1fr}.actions{position:fixed;left:0;right:0;bottom:0;z-index:9;background:rgba(250,247,242,.98);padding:.75rem 1rem calc(.75rem + env(safe-area-inset-bottom));border-top:1px solid var(--border);box-shadow:0 -10px 26px rgba(60,40,10,.12)}}
</style>
</head>
<body>
<div class="promo"><strong>Free delivery on ₹499+</strong> · Prepaid offers available · COD available</div>
<nav><a class="logo" href="/">Ink &amp; Chai</a><a class="back" href="/product/">← Catalogue</a></nav>
<main class="wrap">
  <section class="cover"><img src="${esc(image)}" alt="${title} book cover" loading="eager" fetchpriority="high"/></section>
  <section>
    <div class="crumb"><a href="/">Home</a> / <a href="/category/?name=${encodeURIComponent(product.category || 'Books')}">${category}</a></div>
    <h1>${title}</h1>
    <div class="author">by ${author}</div>
    <div><span class="price">${esc(price)}</span>${mrp ? `<span class="orig">${esc(mrp)}</span>` : ''}</div>
    <span class="stock">In Stock</span>
    <div class="trust"><span>🚚 Delivery in 2-5 days</span><span>💵 Cash on delivery available</span><span>💳 UPI, cards, net banking</span><span>🛡 7-day replacement support</span></div>
    <div class="actions">
      <button class="secondary" onclick="addProductToCart(false)">Add to Cart</button>
      <button class="primary" onclick="addProductToCart(true)">Buy Now</button>
    </div>
    <div class="desc"><div class="label">About this book</div>${desc}</div>
    <div class="details"><div class="label">Details</div><dl><dt>Category</dt><dd>${category}</dd><dt>Publisher</dt><dd>${esc(product.publisher || 'Ink & Chai')}</dd><dt>ISBN</dt><dd>${esc(product.isbn || 'Available on request')}</dd><dt>Sold by</dt><dd>Ink &amp; Chai</dd></dl></div>
  </section>
</main>
<script src="/js/cart.js"></script>
<script>
const currentItem = ${JSON.stringify({
    id: `/product/${product.slug}/`,
    url: `/product/${product.slug}/`,
    title: product.title,
    author: product.author || '',
    price: Number(product.price_inr),
    img: product.image_url || '',
    qty: 1,
  }).replace(/</g, '\\u003c')};
function addProductToCart(buyNow) {
  localStorage.removeItem('iac_buy_now_cart');
  if (buyNow) {
    localStorage.setItem('iac_buy_now_cart', JSON.stringify([{ ...currentItem, qty: 1 }]));
    location.href = '/checkout/';
    return;
  }
  if (window.addToCart) window.addToCart(currentItem);
}
</script>
</body>
</html>`;
}

exports.handler = async (event) => {
  const slug = String(event.queryStringParameters?.slug || '')
    .split('/')
    .filter(Boolean)[0]
    .toLowerCase();

  if (!slug) {
    return { statusCode: 404, headers: { 'Content-Type': 'text/html' }, body: 'Product not found' };
  }
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return { statusCode: 404, headers: { 'Content-Type': 'text/html' }, body: 'Product not found' };
  }

  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const { data, error } = await supabase
      .from('custom_products')
      .select('*')
      .eq('slug', slug)
      .eq('is_active', true)
      .single();
    if (error || !data) throw error || new Error('Not found');

    const { data: override } = await supabase
      .from('product_overrides')
      .select('title,author,category,price_inr,original_price_inr,is_active')
      .eq('slug', slug)
      .maybeSingle();
    const product = applyOverride(data, override);

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'public, max-age=60, s-maxage=300',
      },
      body: productHtml(product),
    };
  } catch (err) {
    return {
      statusCode: 404,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
      body: '<!doctype html><title>Product not found</title><h1>Product not found</h1><p>This product is not available.</p>',
    };
  }
};
