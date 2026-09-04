# Cloudflare migration

Interim state: the storefront is served statically by Cloudflare Pages (project
`inkandchai`) while the ~149 Netlify functions are ported to a Worker.

## Deploying

    node scripts/build-catalog-index.js
    node scripts/build-fbt-signals.js
    python3 generate_site.py
    cp cloudflare/_redirects cloudflare/_headers public/
    npx wrangler pages deploy public --project-name inkandchai --branch main

`_redirects` and `_headers` live here rather than in `public/` because
`generate_site.py` owns `public/` and a rebuild would not recreate them.

`functions/_middleware.js` answers `/.netlify/functions/*` with a JSON 503 and
injects the "ordering paused" banner into every HTML page. **Delete it once the
Worker serves the real function routes.**

## DNS

`dns/inkandchai.in.zone` is a BIND export of all 25 records, taken off Netlify
managed DNS before the account suspension. The zone now lives on Cloudflare
(`angelina`/`garret.ns.cloudflare.com`). Nothing is proxied; do not orange-cloud
`email.inkandchai.in` or any `_domainkey` record.
