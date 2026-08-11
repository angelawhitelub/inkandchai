/*
 * #InkAndChaiBookstagram reels — shared module.
 *
 * Renders the horizontal social-proof strip and an Instagram-style vertical
 * reels viewer (up/down arrows + swipe/scroll-snap). Reads reel data from
 * window.__IAC_REELS__ = [{ src, poster, caption, instagram, type }].
 *
 * BANDWIDTH-SAFE BY DESIGN:
 *   - The strip loads NO video bytes — only small poster images (or a CSS tile).
 *   - The viewer loads ONLY the one reel currently on screen; neighbours have
 *     their <video> src cleared, so at most one video streams at a time.
 *   - Videos are served from Supabase's CDN (absolute https URLs), never from
 *     Netlify, so this adds zero Netlify bandwidth.
 */
(function () {
  'use strict';
  if (window.__IAC_REELS_INIT__) return;
  window.__IAC_REELS_INIT__ = true;

  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  var isVideo = function (it) {
    return (it.type || '').toLowerCase() === 'video' || /\.(mp4|webm|mov)(\?|$)/i.test(it.src || '');
  };

  // ── One-time styles ────────────────────────────────────────────────────────
  function injectCss() {
    if (document.getElementById('iac-reels-css')) return;
    var css = ''
      + '.iac-reels-sec{max-width:1260px;margin:2rem auto 0;padding:0 1rem}'
      + '.iac-reels-sec .iac-reels-hd{border-top:1px solid rgba(201,168,76,.15);padding-top:1.6rem;margin-bottom:1rem}'
      + '.iac-reels-hd h2{font-family:"Cormorant Garamond",Georgia,serif;font-size:1.4rem;font-weight:500;color:#faf7f2;margin:0}'
      + '.iac-reels-hd h2 span{color:#a09080;font-size:.7rem;letter-spacing:.18em;text-transform:uppercase;font-family:Inter,system-ui,sans-serif;margin-left:.4rem}'
      + '.iac-reels-strip{display:flex;gap:.85rem;overflow-x:auto;scroll-snap-type:x mandatory;padding-bottom:.5rem;-webkit-overflow-scrolling:touch}'
      + '.iac-reels-strip::-webkit-scrollbar{height:0}'
      + '.iac-tile{flex:0 0 150px;aspect-ratio:9/16;position:relative;overflow:hidden;border-radius:12px;border:1px solid rgba(201,168,76,.25);'
      + 'background:linear-gradient(150deg,#241a0c,#120d06);cursor:pointer;scroll-snap-align:start;-webkit-tap-highlight-color:transparent}'
      + '.iac-tile img{width:100%;height:100%;object-fit:cover;display:block}'
      + '.iac-tile .iac-play{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:42px;height:42px;border-radius:50%;'
      + 'background:rgba(0,0,0,.5);backdrop-filter:blur(2px);display:flex;align-items:center;justify-content:center;color:#fff;font-size:15px;padding-left:3px;transition:transform .15s}'
      + '.iac-tile:hover .iac-play{transform:translate(-50%,-50%) scale(1.1)}'
      + '.iac-tile .iac-cap{position:absolute;left:0;right:0;bottom:0;padding:.55rem;font-size:.66rem;line-height:1.3;color:#f0e8d8;'
      + 'background:linear-gradient(to top,rgba(0,0,0,.9),transparent)}'
      // viewer overlay
      + '.iac-viewer{position:fixed;inset:0;z-index:99999;background:rgba(8,6,4,.97);display:none;justify-content:center;align-items:center}'
      + '.iac-viewer.open{display:flex}'
      + 'body.iac-viewer-open{overflow:hidden}'
      + '.iac-scroller{position:relative;height:100dvh;width:min(460px,100vw);overflow-y:scroll;scroll-snap-type:y mandatory;-webkit-overflow-scrolling:touch;scrollbar-width:none}'
      + '.iac-scroller::-webkit-scrollbar{width:0}'
      + '.iac-slide{height:100dvh;scroll-snap-align:start;scroll-snap-stop:always;display:flex;align-items:center;justify-content:center;position:relative}'
      + '.iac-slide video{width:100%;height:100%;object-fit:contain;background:#000;display:block}'
      + '.iac-slide .iac-poster{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;background:#000}'
      + '.iac-slide .iac-spin{position:absolute;top:50%;left:50%;width:34px;height:34px;margin:-17px 0 0 -17px;border:3px solid rgba(255,255,255,.25);border-top-color:#fff;border-radius:50%;animation:iacspin .8s linear infinite}'
      + '@keyframes iacspin{to{transform:rotate(360deg)}}'
      + '.iac-slide .iac-scap{position:absolute;left:0;right:0;bottom:0;padding:1.4rem 1rem 1.8rem;font-size:.9rem;line-height:1.4;color:#fff;'
      + 'background:linear-gradient(to top,rgba(0,0,0,.85),transparent);pointer-events:none}'
      + '.iac-slide .iac-ig{position:absolute;left:1rem;bottom:1rem;pointer-events:auto;font-size:.72rem;color:#fff;text-decoration:none;'
      + 'background:rgba(255,255,255,.16);padding:.35rem .6rem;border-radius:999px;backdrop-filter:blur(4px)}'
      + '.iac-mute{position:absolute;top:1rem;left:1rem;width:38px;height:38px;border:none;border-radius:50%;background:rgba(0,0,0,.5);'
      + 'color:#fff;font-size:16px;cursor:pointer;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(3px)}'
      + '.iac-close{position:absolute;top:1rem;right:1rem;width:40px;height:40px;border:none;border-radius:50%;background:rgba(0,0,0,.5);'
      + 'color:#fff;font-size:22px;line-height:1;cursor:pointer;z-index:3;backdrop-filter:blur(3px)}'
      + '.iac-nav{position:absolute;right:calc(50% - min(230px,50vw) - 58px);border:none;width:46px;height:46px;border-radius:50%;'
      + 'background:rgba(255,255,255,.12);color:#fff;font-size:20px;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:background .15s}'
      + '.iac-nav:hover{background:rgba(255,255,255,.24)}.iac-nav[disabled]{opacity:.3;cursor:default}'
      + '.iac-nav.up{top:calc(50% - 54px)}.iac-nav.down{top:calc(50% + 8px)}'
      + '@media(max-width:900px){.iac-nav{display:none}}'   // mobile uses swipe/scroll, not arrows
      + '@media(max-width:520px){.iac-tile{flex-basis:132px}}';
    var el = document.createElement('style');
    el.id = 'iac-reels-css';
    el.textContent = css;
    document.head.appendChild(el);
  }

  var reels = [];   // normalised video reels only
  var fixedReels = [];
  var viewer = null, scroller = null, upBtn = null, downBtn = null;
  var slides = [];
  var muted = true;
  var activeIdx = 0;

  // ── Viewer ─────────────────────────────────────────────────────────────────
  function buildViewer() {
    if (viewer) return;
    viewer = document.createElement('div');
    viewer.className = 'iac-viewer';
    viewer.setAttribute('role', 'dialog');
    viewer.setAttribute('aria-label', 'Customer reels');

    scroller = document.createElement('div');
    scroller.className = 'iac-scroller';
    reels.forEach(function (it, i) {
      var slide = document.createElement('div');
      slide.className = 'iac-slide';
      slide.dataset.idx = i;
      var poster = it.poster ? '<img class="iac-poster" src="' + esc(it.poster) + '" alt=""/>' : '';
      var spin = '<div class="iac-spin" hidden></div>';
      var cap = it.caption ? '<div class="iac-scap">' + esc(it.caption) + '</div>' : '';
      var ig = it.instagram ? '<a class="iac-ig" href="' + esc(it.instagram) + '" target="_blank" rel="noopener">↗ View on Instagram</a>' : '';
      slide.innerHTML = poster + spin
        + '<video data-src="' + esc(it.src) + '" playsinline loop muted preload="none"></video>'
        + cap + ig;
      slides.push(slide);
      scroller.appendChild(slide);
    });

    var close = document.createElement('button');
    close.className = 'iac-close'; close.innerHTML = '&times;';
    close.setAttribute('aria-label', 'Close'); close.onclick = closeViewer;

    var mute = document.createElement('button');
    mute.className = 'iac-mute'; mute.innerHTML = '🔇';
    mute.setAttribute('aria-label', 'Toggle sound');
    mute.onclick = function (e) { e.stopPropagation(); toggleMute(mute); };

    upBtn = document.createElement('button');
    upBtn.className = 'iac-nav up'; upBtn.innerHTML = '↑';
    upBtn.setAttribute('aria-label', 'Previous reel');
    upBtn.onclick = function () { goTo(activeIdx - 1); };

    downBtn = document.createElement('button');
    downBtn.className = 'iac-nav down'; downBtn.innerHTML = '↓';
    downBtn.setAttribute('aria-label', 'Next reel');
    downBtn.onclick = function () { goTo(activeIdx + 1); };

    viewer.appendChild(scroller);
    viewer.appendChild(close);
    viewer.appendChild(mute);
    viewer.appendChild(upBtn);
    viewer.appendChild(downBtn);
    document.body.appendChild(viewer);

    // Tap the video area to play/pause.
    scroller.addEventListener('click', function (e) {
      if (e.target.tagName === 'VIDEO') {
        var v = e.target;
        if (v.paused) v.play().catch(function () {}); else v.pause();
      }
    });

    // Only the reel on screen loads its video; others are unloaded.
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        var idx = +en.target.dataset.idx;
        if (en.isIntersecting && en.intersectionRatio > 0.6) setActive(idx);
      });
    }, { root: scroller, threshold: [0.6] });
    slides.forEach(function (s) { io.observe(s); });

    document.addEventListener('keydown', onKey);
  }

  function loadSlide(i) {
    var v = slides[i] && slides[i].querySelector('video');
    if (!v) return;
    if (!v.getAttribute('src')) {
      var spin = slides[i].querySelector('.iac-spin');
      if (spin) spin.hidden = false;
      v.src = v.dataset.src;
      v.addEventListener('loadeddata', function () {
        if (spin) spin.hidden = true;
        var p = slides[i].querySelector('.iac-poster');
        if (p) p.style.display = 'none';
      }, { once: true });
      v.addEventListener('error', function () { if (spin) spin.hidden = true; }, { once: true });
    }
  }
  function unloadSlide(i) {
    var v = slides[i] && slides[i].querySelector('video');
    if (!v) return;
    v.pause();
    if (v.getAttribute('src')) { v.removeAttribute('src'); v.load(); }
    var p = slides[i] && slides[i].querySelector('.iac-poster');
    if (p) p.style.display = '';
  }

  function setActive(i) {
    if (i === activeIdx && slides[i] && slides[i].querySelector('video').getAttribute('src')) return;
    activeIdx = i;
    slides.forEach(function (s, j) {
      var v = s.querySelector('video');
      if (j === i) {
        loadSlide(j);
        v.muted = muted;
        v.play().catch(function () {});
      } else if (Math.abs(j - i) > 1) {
        unloadSlide(j);       // keep immediate neighbours warm, drop the rest
      } else {
        v.pause();
      }
    });
    if (upBtn) upBtn.disabled = i <= 0;
    if (downBtn) downBtn.disabled = i >= reels.length - 1;
  }

  function goTo(i) {
    if (i < 0 || i >= reels.length) return;
    slides[i].scrollIntoView({ behavior: 'smooth' });
  }

  function toggleMute(btn) {
    muted = !muted;
    var v = slides[activeIdx] && slides[activeIdx].querySelector('video');
    if (v) { v.muted = muted; if (!muted) v.play().catch(function () {}); }
    if (btn) btn.innerHTML = muted ? '🔇' : '🔊';
  }

  function onKey(e) {
    if (!viewer.classList.contains('open')) return;
    if (e.key === 'Escape') closeViewer();
    else if (e.key === 'ArrowDown') { e.preventDefault(); goTo(activeIdx + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); goTo(activeIdx - 1); }
  }

  function openViewer(idx) {
    buildViewer();
    viewer.classList.add('open');
    document.body.classList.add('iac-viewer-open');
    // Jump to the tapped reel without a scroll animation, then activate it.
    slides[idx].scrollIntoView();
    setActive(idx);
  }
  function closeViewer() {
    if (!viewer) return;
    viewer.classList.remove('open');
    document.body.classList.remove('iac-viewer-open');
    slides.forEach(function (_, j) { unloadSlide(j); });
  }

  // ── Strip ──────────────────────────────────────────────────────────────────
  function tileHtml(it, i) {
    var inner = it.poster
      ? '<img src="' + esc(it.poster) + '" alt="' + esc(it.caption || 'Customer reel') + '" loading="lazy"/>'
      : '';
    var cap = it.caption ? '<div class="iac-cap">' + esc(it.caption) + '</div>' : '';
    return '<div class="iac-tile" role="button" tabindex="0" data-idx="' + i + '" aria-label="Play reel">'
      + inner + '<div class="iac-play">▶</div>' + cap + '</div>';
  }

  function mount(container) {
    if (!container || container.dataset.iacMounted) return;
    container.dataset.iacMounted = '1';
    if (!reels.length) {
      container.innerHTML = '<section class="iac-reels-sec"><div class="iac-reels-hd">'
        + '<h2>#InkAndChaiBookstagram <span>Real customer unboxings</span></h2></div>'
        + '<div style="color:#a09080;font-size:.85rem">We’re collecting unboxing reels from our readers. '
        + 'Tag <code>@inkandchai</code> on Instagram and your reel might land here.</div></section>';
      return;
    }
    var strip = reels.map(tileHtml).join('');
    container.innerHTML = '<section class="iac-reels-sec"><div class="iac-reels-hd">'
      + '<h2>#InkAndChaiBookstagram <span>Real customer unboxings</span></h2></div>'
      + '<div class="iac-reels-strip">' + strip + '</div></section>';

    container.querySelectorAll('.iac-tile').forEach(function (t) {
      var open = function () { openViewer(+t.dataset.idx); };
      t.addEventListener('click', open);
      t.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
      });
    });
  }

  function normalise(items) {
    return (Array.isArray(items) ? items : []).filter(function (it) { return it && it.src && isVideo(it); });
  }

  function mergeReels(extra) {
    var seen = Object.create(null);
    return fixedReels.concat(normalise(extra)).filter(function (it) {
      var key = String(it.src || '');
      if (!key || seen[key]) return false;
      seen[key] = true;
      return true;
    });
  }

  function sameReels(a, b) {
    if (a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) {
      if (String(a[i] && a[i].src) !== String(b[i] && b[i].src)) return false;
    }
    return true;
  }

  function remountAll() {
    // Dynamic reels normally arrive before anyone can open the viewer. Resetting
    // here also makes the API safe on a slow connection: stale slide indexes can
    // never point at the wrong newly-appended video.
    if (viewer) viewer.remove();
    viewer = null; scroller = null; upBtn = null; downBtn = null; slides = [];
    document.querySelectorAll('[data-iac-reels], #bookstagramContent').forEach(function (container) {
      delete container.dataset.iacMounted;
      mount(container);
    });
  }

  function loadAdminReels() {
    // No `cache: 'no-store'`: this runs on every page view, and forcing a fresh
    // request bypassed both the browser and the CDN, costing a function
    // invocation per visitor. The endpoint's own Cache-Control governs freshness
    // now (60s browser, 5min edge).
    return fetch('/.netlify/functions/site-reels')
      .then(function (response) { return response.ok ? response.json() : { items: [] }; })
      .then(function (data) {
        var merged = mergeReels(data && data.items);
        // Compare identity, not count: swapping one reel for another leaves the
        // length identical, and the old check treated that as "nothing changed"
        // so the new video never appeared until a hard reload.
        if (sameReels(merged, reels)) return;
        reels = merged;
        window.__IAC_REELS__ = reels.slice();
        remountAll();
      })
      .catch(function () { /* fixed reels remain available when storage is down */ });
  }

  function init() {
    injectCss();
    fixedReels = normalise(window.__IAC_REELS__ || []);
    reels = fixedReels.slice();
    document.querySelectorAll('[data-iac-reels], #bookstagramContent').forEach(mount);
    loadAdminReels();
  }

  // Public API (lets the JS-rendered page mount a late container).
  window.IACReels = {
    mount: function (elOrData) {
      injectCss();
      if (Array.isArray(elOrData)) {
        window.__IAC_REELS__ = elOrData;
        fixedReels = normalise(elOrData);
        reels = fixedReels.slice();
        loadAdminReels();
        return;
      }
      if (!reels.length) {
        fixedReels = normalise(window.__IAC_REELS__ || []);
        reels = fixedReels.slice();
      }
      mount(elOrData);
    },
    open: openViewer,
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
