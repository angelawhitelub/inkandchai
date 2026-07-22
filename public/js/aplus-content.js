/* Ink & Chai A+ product content. The host placeholder is inserted before the
 * reels strip by cart.js, preserving: A+ → reels → frequently bought together. */
(function () {
  'use strict';

  function productSlug() {
    var parts = location.pathname.split('/').filter(Boolean);
    return parts[0] === 'product' && parts[1] ? parts[1].toLowerCase() : '';
  }

  function addStyles() {
    if (document.getElementById('iac-aplus-css')) return;
    var style = document.createElement('style');
    style.id = 'iac-aplus-css';
    style.textContent = ''
      + '.iac-aplus{max-width:1260px;margin:2rem auto 0;padding:0 1rem;color:var(--cream,#f0e8d8)}'
      + '.iac-aplus-inner{border-top:1px solid var(--border,rgba(201,168,76,.18));padding-top:1.8rem}'
      + '.iac-aplus-kicker{font:600 .62rem Montserrat,Inter,sans-serif;letter-spacing:.24em;text-transform:uppercase;color:var(--gold,#c9a84c);margin-bottom:.55rem}'
      + '.iac-aplus-title{font-family:"Cormorant Garamond",Georgia,serif;font-size:clamp(1.8rem,4vw,2.8rem);line-height:1.08;font-weight:500;margin:0;color:var(--cream,#f0e8d8)}'
      + '.iac-aplus-intro{max-width:860px;margin:.8rem 0 0;color:var(--muted,#a09080);font-size:.92rem;line-height:1.8;white-space:pre-line}'
      + '.iac-aplus-modules{display:grid;gap:1rem;margin-top:1.35rem}'
      + '.iac-aplus-module{overflow:hidden;border:1px solid var(--border,rgba(201,168,76,.18));background:var(--panel,#1c1916)}'
      + '.iac-aplus-module.wide{display:flex;flex-direction:column}'
      + '.iac-aplus-module.image-left,.iac-aplus-module.image-right{display:grid;grid-template-columns:minmax(0,1.18fr) minmax(280px,.82fr);align-items:stretch}'
      + '.iac-aplus-module.image-right .iac-aplus-media{order:2}.iac-aplus-module.image-right .iac-aplus-copy{order:1}'
      + '.iac-aplus-media{min-height:260px;background:#100c08;display:flex;align-items:center;justify-content:center}'
      + '.iac-aplus-media img{display:block;width:100%;height:100%;max-height:680px;object-fit:cover}'
      + '.iac-aplus-module.wide .iac-aplus-media img{height:auto;max-height:none;object-fit:contain}'
      + '.iac-aplus-copy{padding:clamp(1.1rem,3vw,2.4rem);display:flex;flex-direction:column;justify-content:center}'
      + '.iac-aplus-copy h3{font-family:"Cormorant Garamond",Georgia,serif;font-size:clamp(1.35rem,2.6vw,2rem);font-weight:500;line-height:1.15;margin:0;color:var(--cream,#f0e8d8)}'
      + '.iac-aplus-copy p{margin:.65rem 0 0;color:var(--muted,#a09080);font-size:.88rem;line-height:1.8;white-space:pre-line}'
      + '.iac-aplus-copy:empty{display:none}'
      + '@media(max-width:760px){.iac-aplus{margin-top:1.35rem;padding:0 .75rem}.iac-aplus-module.image-left,.iac-aplus-module.image-right{display:flex;flex-direction:column}.iac-aplus-module.image-right .iac-aplus-media{order:1}.iac-aplus-module.image-right .iac-aplus-copy{order:2}.iac-aplus-media{min-height:0}.iac-aplus-media img{height:auto;max-height:none;object-fit:contain}.iac-aplus-copy{padding:1rem 1.05rem 1.2rem}}';
    document.head.appendChild(style);
  }

  function text(tag, className, value) {
    if (!value) return null;
    var el = document.createElement(tag);
    el.className = className;
    el.textContent = value;
    return el;
  }

  function render(host, content) {
    var blocks = Array.isArray(content && content.blocks) ? content.blocks : [];
    if (!content || content.is_active === false || (!content.heading && !content.intro && !blocks.length)) {
      host.hidden = true;
      return;
    }
    addStyles();
    host.hidden = false;
    host.className = 'iac-aplus';
    host.setAttribute('aria-label', 'From the publisher');
    host.textContent = '';

    var inner = document.createElement('div');
    inner.className = 'iac-aplus-inner';
    inner.appendChild(text('div', 'iac-aplus-kicker', 'A+ Book Content'));
    var title = text('h2', 'iac-aplus-title', content.heading || 'Discover more about this book');
    if (title) inner.appendChild(title);
    var intro = text('p', 'iac-aplus-intro', content.intro);
    if (intro) inner.appendChild(intro);

    var modules = document.createElement('div');
    modules.className = 'iac-aplus-modules';
    blocks.slice(0, 8).forEach(function (block) {
      if (!block || (!block.image_url && !block.heading && !block.body)) return;
      var module = document.createElement('article');
      module.className = 'iac-aplus-module ' + (['wide', 'image-left', 'image-right'].indexOf(block.layout) >= 0 ? block.layout : 'wide');
      if (block.image_url) {
        var media = document.createElement('div');
        media.className = 'iac-aplus-media';
        var img = document.createElement('img');
        img.src = block.image_url;
        img.alt = block.image_alt || block.heading || 'Book feature';
        img.loading = 'lazy';
        img.decoding = 'async';
        media.appendChild(img);
        module.appendChild(media);
      }
      if (block.heading || block.body) {
        var copy = document.createElement('div');
        copy.className = 'iac-aplus-copy';
        var heading = text('h3', '', block.heading);
        var body = text('p', '', block.body);
        if (heading) copy.appendChild(heading);
        if (body) copy.appendChild(body);
        module.appendChild(copy);
      }
      modules.appendChild(module);
    });
    if (modules.children.length) inner.appendChild(modules);
    host.appendChild(inner);
  }

  async function init() {
    var host = document.querySelector('[data-iac-aplus]');
    var slug = productSlug();
    if (!host || !slug || host.dataset.iacAplusLoaded) return;
    host.dataset.iacAplusLoaded = '1';
    try {
      var response = await fetch('/.netlify/functions/get-aplus-content?slug=' + encodeURIComponent(slug), { cache: 'no-cache' });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      var data = await response.json();
      render(host, data.content);
    } catch (err) {
      host.hidden = true;
      console.warn('A+ content unavailable:', err.message);
    }
  }

  window.IACAplus = { init: init };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
