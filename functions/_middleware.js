// Interim Cloudflare Pages middleware for the static-only storefront.
//
// The Worker port is not done yet, so none of the ~149 backend handlers exist.
// This does two jobs until they do:
//   1. Answer /.netlify/functions/* with a predictable JSON 503 instead of the
//      HTML 404 Pages would otherwise serve, so client code that expects JSON
//      fails cleanly rather than throwing on a parse error.
//   2. Inject a banner into every HTML page telling customers ordering is
//      paused, so nobody fills a cart they cannot check out.
//
// Delete this file once the Worker handles the function routes.

const BANNER = `<div id="iac-paused" role="status" style="position:sticky;top:0;z-index:2147483647;background:#7c2d12;color:#fff;font:500 14px/1.45 system-ui,-apple-system,'Segoe UI',sans-serif;padding:10px 16px;text-align:center;box-shadow:0 1px 3px rgba(0,0,0,.25)">
Ordering is temporarily paused while we move to new infrastructure. You can browse the full catalogue — checkout will be back shortly.
</div>`;

class BannerInjector {
  element(el) { el.prepend(BANNER, { html: true }); }
}

export async function onRequest(context) {
  const { request, next } = context;
  const url = new URL(request.url);

  if (url.pathname.startsWith('/.netlify/functions/')) {
    return new Response(
      JSON.stringify({ error: 'service_unavailable', message: 'Backend is being migrated. Try again shortly.' }),
      { status: 503, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } }
    );
  }

  const response = await next();
  const type = response.headers.get('content-type') || '';
  if (!type.includes('text/html')) return response;

  const out = new HTMLRewriter().on('body', new BannerInjector()).transform(response);

  // *.pages.dev is world-readable and would be indexed as a duplicate of the
  // real storefront. Keep crawlers on the custom domain only.
  if (url.hostname.endsWith('.pages.dev')) {
    const headers = new Headers(out.headers);
    headers.set('x-robots-tag', 'noindex, nofollow');
    return new Response(out.body, { status: out.status, headers });
  }
  return out;
}
