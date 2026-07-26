/** Runtime cover/gallery overrides for generated catalogue product pages. */
(function () {
  if (!/^\/product\/[^/]+\/?$/.test(location.pathname)) return;

  function addStyles() {
    if (document.getElementById('iac-runtime-gallery-style')) return;
    var style = document.createElement('style');
    style.id = 'iac-runtime-gallery-style';
    style.textContent = [
      '.iac-runtime-gallery{position:relative;width:100%}',
      '.iac-runtime-gallery-track{display:flex;overflow-x:auto;scroll-snap-type:x mandatory;scrollbar-width:none;-webkit-overflow-scrolling:touch}',
      '.iac-runtime-gallery-track::-webkit-scrollbar{display:none}',
      '.iac-runtime-gallery-slide{flex:0 0 100%;scroll-snap-align:center;display:flex;align-items:center;justify-content:center}',
      '.iac-runtime-gallery-slide img{max-width:100%;max-height:600px;object-fit:contain;cursor:zoom-in}',
      '.iac-runtime-gallery-arrow{position:absolute;top:50%;transform:translateY(-50%);z-index:2;width:42px;height:42px;border-radius:50%;border:1px solid rgba(201,168,76,.35);background:rgba(13,11,8,.78);color:#d8bb68;font-size:1.5rem;cursor:pointer}',
      '.iac-runtime-gallery-prev{left:6px}.iac-runtime-gallery-next{right:6px}',
      '.iac-runtime-gallery-dots{display:flex;justify-content:center;gap:.45rem;margin-top:.8rem}',
      '.iac-runtime-gallery-dot{width:9px;height:9px;min-height:9px;padding:0;border:0;border-radius:50%;background:rgba(201,168,76,.3);cursor:pointer}',
      '.iac-runtime-gallery-dot.active{background:#c9a84c;transform:scale(1.15)}',
      '@media(max-width:760px){.iac-runtime-gallery-arrow{display:none}}'
    ].join('');
    document.head.appendChild(style);
  }

  function render(images) {
    var cover = document.querySelector('main .cover');
    if (!cover || !images.length) return;
    var title = (typeof currentItem !== 'undefined' && currentItem.title) || document.querySelector('h1')?.textContent || 'Book';
    if (typeof currentItem !== 'undefined') currentItem.img = images[0];
    if (images.length === 1) {
      var current = cover.querySelector('img');
      if (current) current.src = images[0];
      return;
    }
    addStyles();
    cover.textContent = '';
    var gallery = document.createElement('div');
    gallery.className = 'iac-runtime-gallery';
    var track = document.createElement('div');
    track.className = 'iac-runtime-gallery-track';
    var dots = [];
    images.forEach(function (url, index) {
      var slide = document.createElement('div');
      slide.className = 'iac-runtime-gallery-slide';
      var image = document.createElement('img');
      image.src = url;
      image.alt = title + (index === 0 ? ' book cover' : ' image ' + (index + 1));
      image.loading = index === 0 ? 'eager' : 'lazy';
      image.addEventListener('click', function () { if (window.openLB) window.openLB(image.src, image.alt); });
      slide.appendChild(image);
      track.appendChild(slide);
    });
    gallery.appendChild(track);
    function button(label, className, delta) {
      var b = document.createElement('button');
      b.type = 'button'; b.className = 'iac-runtime-gallery-arrow ' + className;
      b.setAttribute('aria-label', label); b.textContent = delta < 0 ? '‹' : '›';
      b.addEventListener('click', function () { go(current() + delta); });
      gallery.appendChild(b);
    }
    button('Previous image', 'iac-runtime-gallery-prev', -1);
    button('Next image', 'iac-runtime-gallery-next', 1);
    var dotsHost = document.createElement('div');
    dotsHost.className = 'iac-runtime-gallery-dots';
    images.forEach(function (_, index) {
      var dot = document.createElement('button');
      dot.type = 'button'; dot.className = 'iac-runtime-gallery-dot' + (index === 0 ? ' active' : '');
      dot.setAttribute('aria-label', 'Show image ' + (index + 1));
      dot.addEventListener('click', function () { go(index); });
      dots.push(dot); dotsHost.appendChild(dot);
    });
    gallery.appendChild(dotsHost);
    cover.appendChild(gallery);
    function current() { return track.clientWidth ? Math.round(track.scrollLeft / track.clientWidth) : 0; }
    function update() { var n = current(); dots.forEach(function (dot, i) { dot.classList.toggle('active', i === n); }); }
    function go(index) {
      var n = Math.max(0, Math.min(images.length - 1, index));
      track.scrollTo({ left: n * track.clientWidth, behavior: 'smooth' });
    }
    track.addEventListener('scroll', update, { passive: true });
  }

  async function init() {
    try {
      var slug = location.pathname.split('/').filter(Boolean)[1] || '';
      var response = await fetch('/.netlify/functions/get-product-overrides?slug=' + encodeURIComponent(slug), { cache: 'no-store' });
      if (!response.ok) return;
      var data = await response.json();
      var override = data.overrides && data.overrides[0];
      if (!override) return;
      var images = [override.image_url].concat(Array.isArray(override.gallery_images) ? override.gallery_images : [])
        .filter(function (url, index, list) { return url && list.indexOf(url) === index; });
      render(images);
    } catch (error) {
      console.warn('Product gallery override unavailable:', error.message);
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
