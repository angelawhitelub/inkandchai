/**
 * The site theme for pages a function renders per request.
 *
 * site_theme.py writes a fenced IAC-THEME block (fonts, the content-hashed
 * /css/theme-*.css, site-feedback.js, ad-click.js) into every baked page, and
 * puts html.iac-light on pages that have no light/dark switch. Function-rendered
 * pages never went through it, so a book added from the admin rendered in the
 * old look (5 Oct 2026). This is the same step, in JS. The block itself comes
 * from a baked page via scripts/build-worker-routes.js, so it cannot drift.
 */
const { block } = require('./site-theme.generated.json');

const FENCE_RE = /<!--IAC-THEME-->[\s\S]*?<!--\/IAC-THEME-->\n?/g;
const THEME_SWITCH_MARK = 'iac_theme';

/** html with the theme applied, last thing in <head>. Idempotent. */
function applySiteTheme(html) {
  let s = String(html || '');
  const head = s.indexOf('</head>');
  if (head < 0) return s;
  s = s.replace(FENCE_RE, '');
  if (!s.includes(THEME_SWITCH_MARK)) {
    s = s.replace(/<html\b[^>]*>/i, (tag) => {
      if (/iac-light/.test(tag)) return tag;
      return /\bclass="/.test(tag) ? tag.replace(/\bclass="/, 'class="iac-light ') : tag.replace(/\s*>$/, ' class="iac-light">');
    });
  }
  const at = s.indexOf('</head>');
  return s.slice(0, at) + block + '\n' + s.slice(at);
}

module.exports = { applySiteTheme, THEME_BLOCK: block };
