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
:root{--bg:#090807;--panel:#15110e;--gold:#d6b85e;--gold-light:#f0d889;--copper:#b8754c;--cream:#f4ecdc;--muted:#b9ab96;--border:rgba(214,184,94,.24);--ink-blue:#182d3b;--glass-bg:rgba(17,15,13,.74);--glass-border:rgba(214,184,94,.28);--glass-shadow:0 18px 60px rgba(0,0,0,.46);--glass-highlight:inset 0 1px rgba(255,255,255,.1)}
html[data-theme="light"]{--bg:#faf7f2;--panel:#fff;--gold:#8a6a1f;--gold-light:#b8902c;--copper:#9b653d;--cream:#2a2018;--muted:#5a4a38;--border:rgba(138,106,31,.28);--ink-blue:#e8edf0;--glass-bg:rgba(250,247,242,.78);--glass-border:rgba(138,106,31,.28);--glass-shadow:0 18px 55px rgba(70,52,24,.12);--glass-highlight:inset 0 1px rgba(255,255,255,.62)}
html:not([data-theme="light"]){color-scheme:dark}
*{box-sizing:border-box} body{margin:0;background:linear-gradient(115deg,rgba(24,45,59,.34) 0%,transparent 30%,transparent 70%,rgba(75,32,38,.24) 100%),linear-gradient(180deg,rgba(214,184,94,.08),transparent 34%,rgba(36,54,47,.14)),repeating-linear-gradient(90deg,rgba(214,184,94,.034) 0 1px,transparent 1px 86px),var(--bg);color:var(--cream);font-family:Montserrat,sans-serif;font-weight:300} a{color:inherit}
html[data-theme="light"] body{background:linear-gradient(115deg,rgba(138,106,31,.08) 0%,transparent 32%,transparent 72%,rgba(138,106,31,.06) 100%),repeating-linear-gradient(90deg,rgba(138,106,31,.03) 0 1px,transparent 1px 86px),var(--bg)}
.promo{width:min(920px,calc(100% - 24px));margin:.7rem auto .2rem;padding:.62rem 1rem;text-align:center;border:1px solid var(--glass-border);border-radius:999px;background:var(--glass-bg);box-shadow:0 10px 28px rgba(0,0,0,.18),var(--glass-highlight);backdrop-filter:blur(18px) saturate(1.2);font-size:.68rem;letter-spacing:.12em;text-transform:uppercase;color:var(--muted)} .promo strong{color:var(--gold-light)}
html[data-theme="light"] .promo{box-shadow:0 10px 28px rgba(70,52,24,.08),var(--glass-highlight)}
nav{width:min(1180px,calc(100% - 28px));margin:.75rem auto 0;display:flex;align-items:center;justify-content:space-between;padding:1rem clamp(1rem,4vw,4rem);border:1px solid var(--glass-border);border-radius:999px;background:var(--glass-bg);box-shadow:var(--glass-shadow),var(--glass-highlight);backdrop-filter:blur(24px) saturate(1.25);position:sticky;top:12px;z-index:5}.logo{font-family:"Cormorant Garamond",serif;font-size:1.5rem;color:var(--gold-light);text-decoration:none}.back{font-size:.62rem;letter-spacing:.2em;text-transform:uppercase;color:var(--muted);text-decoration:none}
.wrap{max-width:1260px;margin:0 auto;padding:clamp(1.2rem,4vw,4rem) 1rem 4rem;display:grid;grid-template-columns:minmax(320px,.95fr) 1.05fr;gap:clamp(1.4rem,4vw,4rem);align-items:start}.cover{background:rgba(255,255,255,.055);border:1px solid var(--glass-border);border-radius:28px;padding:clamp(1rem,2.5vw,1.8rem);display:flex;align-items:center;justify-content:center;box-shadow:0 24px 70px rgba(0,0,0,.3),var(--glass-highlight);backdrop-filter:blur(18px) saturate(1.12)}html[data-theme="light"] .cover{background:rgba(255,255,255,.58);box-shadow:0 24px 70px rgba(70,52,24,.1),var(--glass-highlight)}.cover img{max-width:100%;max-height:600px;object-fit:contain;box-shadow:0 24px 64px rgba(0,0,0,.35)}
.crumb{font-size:.58rem;letter-spacing:.24em;text-transform:uppercase;color:var(--gold);margin-bottom:1rem}h1{font-family:"Cormorant Garamond",serif;font-size:clamp(2rem,5vw,3.4rem);font-weight:400;line-height:1.05;margin:.2rem 0 .6rem}.author{color:var(--muted);letter-spacing:.08em;margin-bottom:1rem}.price{font-family:"Cormorant Garamond",serif;font-size:2.7rem;color:var(--gold);font-weight:600}.orig{color:var(--muted);text-decoration:line-through;margin-left:.8rem}.stock{display:inline-block;margin:1rem 0;color:#237a3b;border:1px solid rgba(35,122,59,.25);padding:.35rem .65rem;font-size:.7rem;letter-spacing:.14em;text-transform:uppercase}
.trust{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:.7rem;margin:1.2rem 0}.trust span{border:1px solid var(--border);border-radius:999px;background:rgba(214,184,94,.075);padding:.75rem;color:var(--cream);font-size:.78rem;box-shadow:var(--glass-highlight)}html[data-theme="light"] .trust span{background:rgba(138,106,31,.06);box-shadow:inset 0 1px rgba(255,255,255,.5)}.actions{display:grid;grid-template-columns:1fr 1fr;gap:.8rem;margin:1.3rem 0}button{font:700 .68rem Montserrat,sans-serif;letter-spacing:.2em;text-transform:uppercase;padding:1rem;border:1px solid var(--gold);border-radius:999px;cursor:pointer;min-height:52px;transition:transform .2s ease,filter .2s ease,box-shadow .2s ease}button:hover{transform:translateY(-1px);filter:brightness(1.05)}.primary{background:linear-gradient(135deg,var(--gold),var(--copper));color:#100c08;box-shadow:0 14px 30px rgba(214,184,94,.18),var(--glass-highlight)}.secondary{background:rgba(214,184,94,.075);color:var(--gold-light)}
.desc,.details{border-top:1px solid var(--border);border-radius:24px;padding-top:1.2rem;margin-top:1.2rem;color:var(--muted);font-size:.9rem;line-height:1.8;white-space:pre-line}.label{font-size:.58rem;letter-spacing:.26em;text-transform:uppercase;color:var(--gold);margin-bottom:.5rem}.details dl{display:grid;grid-template-columns:120px 1fr;gap:.5rem 1rem}.details dt{color:var(--gold)}.details dd{margin:0;color:var(--cream)}
@media(max-width:760px){.promo{width:calc(100% - 20px);margin:.45rem auto .1rem;border-radius:999px;white-space:normal;line-height:1.45}nav{width:calc(100% - 18px);margin:.45rem auto 0;border-radius:28px;padding:.7rem .85rem;top:8px}.wrap{display:block;padding:.9rem 1rem 7.6rem}.cover{margin-bottom:1.2rem;border-radius:24px}.trust{grid-template-columns:1fr}.actions{position:fixed;left:12px;right:12px;bottom:10px;z-index:9;margin:0;display:grid;grid-template-columns:1fr 1fr;gap:.6rem;background:rgba(13,11,8,.72);padding:.6rem .6rem calc(.6rem + env(safe-area-inset-bottom));border:1px solid var(--glass-border);border-radius:30px;box-shadow:0 -16px 42px rgba(0,0,0,.45),var(--glass-highlight);backdrop-filter:blur(24px) saturate(1.35)}html[data-theme="light"] .actions{background:rgba(250,247,242,.76);box-shadow:0 -12px 38px rgba(70,52,24,.16),var(--glass-highlight)}.actions button{min-height:52px;padding:.9rem .45rem;font-size:.6rem;letter-spacing:.14em}}
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
  // Slug comes from the /product/* rewrite (?slug=:splat). Fall back to the
  // request path if the splat wasn't passed, and guard against an empty result
  // (filter(Boolean)[0] was undefined -> crashed on .toLowerCase()).
  let raw = event.queryStringParameters?.slug || '';
  if (!raw) {
    const path = event.path || (event.rawUrl || '').split('?')[0] || '';
    raw = path.replace(/.*\/product\//, '');
  }
  const slug = (String(raw).split('/').filter(Boolean).pop() || '').toLowerCase();

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
