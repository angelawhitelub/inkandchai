const search = require('../../../public/js/book-search');
const FIELDS = 'slug,title,author,price_inr,original_price_inr,image_url,tags';
// Only normalised letters/numbers enter PostgREST filters, never raw user syntax.
function termsFor(raw) {
  return search.tokens(raw).filter(w=>w.length>=2).slice(0,8);
}
function pattern(term) {
  return ({cant:'can%t',dont:'don%t',wont:'won%t',its:'it%s',mans:'man%s'})[term] || term;
}
async function findCandidates(client, raw, catalogOnly=false) {
  const terms=termsFor(raw);if(!terms.length)return [];
  function base() {
    let q=client.from('custom_products').select(FIELDS).eq('is_active',true);
    if(catalogOnly)q=q.or('tags.ilike.%crossword-catalog%,tags.ilike.%99bookstores-catalog%');
    return q;
  }
  let exact=base();
  for(const term of terms)exact=exact.or(`title.ilike.%${pattern(term)}%,author.ilike.%${pattern(term)}%`);
  const first=await exact.limit(240);if(first.error)throw first.error;
  const rows=first.data||[];
  if(rows.length>=24)return rows;
  // Broader candidates support partial titles and misspellings. Relevance is
  // checked in JS, so matching a short fragment alone never becomes a result.
  const fragments=[...new Set(terms.filter(w=>w.length>=3).flatMap(w=>[pattern(w),...(w.length>=5?[w.slice(0,3),w.slice(-3)]:[])]))];
  if(!fragments.length)return rows;
  const extra=await base().or(fragments.flatMap(w=>[`title.ilike.%${w}%`,`author.ilike.%${w}%`]).join(',')).limit(240);
  if(extra.error)throw extra.error;
  const seen=new Set(rows.map(r=>r.slug));
  for(const row of extra.data||[])if(!seen.has(row.slug)){seen.add(row.slug);rows.push(row);}
  return rows;
}
module.exports={findCandidates,termsFor};
