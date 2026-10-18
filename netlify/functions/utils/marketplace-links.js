'use strict';

/**
 * "You can also buy from our Amazon / Flipkart store" links for one book.
 *
 * Set per title from the admin product editor; product pages show a button for
 * each link that is set. Shared by admin-marketplace-links (save) and
 * get-marketplace-links (the storefront read), so the URL rules cannot drift.
 *
 * Only links to the two marketplaces are accepted. The button is ours and sits
 * next to Buy Now, so a typo or a pasted link to anywhere else must be refused
 * at save time rather than sending customers off-site to an arbitrary page.
 */

const TABLE = 'product_marketplace_links';
const MAX_URL = 1000;

const STORES = {
  amazon: { label: 'Amazon', hosts: ['amazon.in', 'amazon.com', 'amzn.in', 'amzn.to', 'amzn.eu'] },
  flipkart: { label: 'Flipkart', hosts: ['flipkart.com', 'fkrt.it', 'fkrt.co'] },
};

function cleanSlug(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 160);
}

const hostMatches = (host, allowed) => allowed.some((h) => host === h || host.endsWith('.' + h));

/**
 * A pasted link → { url } (https, trimmed), { url: null } when blank, or
 * { error } when it is not a link to that store.
 */
function cleanStoreUrl(store, value) {
  const spec = STORES[store];
  const raw = String(value == null ? '' : value).trim();
  if (!raw) return { url: null };
  if (raw.length > MAX_URL) return { error: `${spec.label} link is too long.` };
  let u;
  try { u = new URL(/^https?:\/\//i.test(raw) ? raw : 'https://' + raw); } catch { return { error: `${spec.label} link is not a valid URL.` }; }
  if (!/^https?:$/.test(u.protocol)) return { error: `${spec.label} link must start with https://` };
  const host = u.hostname.toLowerCase();
  if (!hostMatches(host, spec.hosts)) return { error: `${spec.label} link must point to ${spec.hosts[0]} (got ${host}).` };
  u.protocol = 'https:';
  u.username = '';
  u.password = '';
  return { url: u.toString() };
}

/** What the storefront is told: only the links that are set, or null. */
function publicLinks(row) {
  if (!row || !row.slug) return null;
  const out = {};
  for (const store of Object.keys(STORES)) {
    const { url } = cleanStoreUrl(store, row[`${store}_url`]);
    if (url) out[`${store}_url`] = url;
  }
  if (!Object.keys(out).length) return null;
  return { slug: row.slug, ...out, updated_at: row.updated_at || null };
}

/** The table not existing yet reads as "no links", never as a broken page. */
function isMissingTable(error) {
  const msg = String((error && error.message) || '');
  const code = String((error && error.code) || '');
  return code === '42P01' || (/product_marketplace_links/.test(msg) && /(does not exist|schema cache|not find)/i.test(msg));
}

module.exports = { TABLE, STORES, MAX_URL, cleanSlug, cleanStoreUrl, publicLinks, isMissingTable };
