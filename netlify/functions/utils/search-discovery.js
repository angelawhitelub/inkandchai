const { createClient } = require('@supabase/supabase-js');
const search = require('../../../public/js/book-search');
const { findCandidates } = require('./search-candidates');
const { proxifySupabaseImage } = require('./supabase-img');
// `cached` is plain data and safe to share between requests. An in-flight
// promise is not: on Workers it belongs to the request that started it, and if
// that request is cancelled the promise never settles -- every later search in
// the isolate awaited it forever ("Finding your next read..." on 7 Oct 2026).
let cached;
const POPULAR_MS = 4000;
const withTimeout = (promise, ms, fallback) => {
  let timer;
  return Promise.race([promise, new Promise((resolve) => { timer = setTimeout(() => resolve(fallback), ms); })])
    .finally(() => clearTimeout(timer));
};
const slugOf = value => String(value || '').replace(/^\/product\//,'').replace(/\/$/,'').toLowerCase();
const validSlug = value => /^[a-z0-9][a-z0-9-]{0,199}$/.test(value);
function preferences(qp) {
  let terms=[];try{terms=JSON.parse(String(qp.interests||'[]').slice(0,1000));}catch{}
  return {viewed:String(qp.viewed||'').split(',').map(slugOf).filter(validSlug).slice(0,3),
    interests:Array.isArray(terms)?terms.filter(t=>typeof t==='string').map(t=>t.trim().slice(0,80)).filter(t=>t.length>=2).slice(0,2):[]};
}
function custom(row) {return {slug:row.slug,title:row.title,author:row.author||'',category:row.category||'',price:Number(row.price_inr)||0,mrp:Number(row.original_price_inr)||0,img:proxifySupabaseImage(row.image_url||''),url:`/product/${row.slug}/`};}
function distinct(rows, excluded=new Set()) {
  const urls=new Set(excluded),titles=new Set();
  return rows.filter(r=>{const key=search.normalize(r.title);if(!r.title||r.price<=0||!validSlug(slugOf(r.url))||urls.has(r.url)||titles.has(key))return false;urls.add(r.url);titles.add(key);return true;});
}
async function popular(catalog, db) {
  if(cached&&Date.now()-cached.at<300000)return cached;
  return withTimeout((async()=>{
    let sold=[];
    try {
      const res=await fetch(`${process.env.URL||'https://inkandchai.in'}/.netlify/functions/homepage-merchandising`,{signal:AbortSignal.timeout(6000)});
      if(res.ok)sold=(await res.json()).bestsellers||[];
    }catch{}
    const bySlug=new Map(catalog.map(r=>[r.slug,r])),byTitle=new Map(catalog.map(r=>[search.normalize(r.title),r]));
    const slugs=sold.map(r=>slugOf(r.slug||r.url)).filter(validSlug);
    if(db&&slugs.length){
      const {data,error}=await db.from('custom_products').select('slug,title,author,category,price_inr,original_price_inr,image_url,is_active').in('slug',slugs);
      if(!error)for(const row of data||[])bySlug.set(row.slug,row.is_active?custom(row):null);
    }
    const best=sold.map(r=>{const slug=slugOf(r.slug||r.url);const book=bySlug.has(slug)?bySlug.get(slug):byTitle.get(search.normalize(r.title));return book?{...book,sold:Number(r.qty)||0}:null;}).filter(Boolean);
    const result={at:Date.now(),bestsellers:distinct(best)};
    if(best.length)cached=result;
    return result;
  })(),POPULAR_MS,cached||{at:0,bestsellers:[]});
}
function choose(catalog,bestsellers,prefs,gone=new Set()) {
  const available=distinct([...bestsellers,...catalog]).filter(r=>!gone.has(r.slug));
  const viewed=new Set(prefs.viewed),seeds=available.filter(b=>viewed.has(b.slug));
  const score=b=>{
    let n=0;
    for(const seed of seeds){if(seed.author&&search.normalize(seed.author)===search.normalize(b.author))n+=70;if(seed.category&&search.normalize(seed.category)===search.normalize(b.category))n+=25;}
    for(const term of prefs.interests)n+=Math.min(60,search.score(b,term)/10);
    return n;
  };
  const forYou=available.filter(b=>!viewed.has(b.slug)).map(b=>({b,n:score(b)})).filter(r=>r.n>0).sort((a,b)=>b.n-a.n||(b.b.sold||0)-(a.b.sold||0)).slice(0,4).map(r=>r.b);
  const exclude=new Set(forYou.map(b=>b.url));
  const best=distinct(bestsellers,exclude).filter(b=>!gone.has(b.slug)).slice(0,6);
  const featured=best.length?[]:available.filter(b=>!exclude.has(b.url)).slice(0,4);
  return {for_you:forYou,bestsellers:best,featured};
}
async function discover(catalog,prefs,gone) {
  const db=process.env.SUPABASE_URL&&process.env.SUPABASE_SERVICE_KEY?createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_KEY):null;
  const {bestsellers}=await popular(catalog,db);
  let extra=[];
  if(db){
    try{
      const unknown=prefs.viewed.filter(slug=>!catalog.some(b=>b.slug===slug));
      if(unknown.length){const {data}=await db.from('custom_products').select('slug,title,author,category,price_inr,original_price_inr,image_url').eq('is_active',true).in('slug',unknown);extra.push(...(data||[]).map(custom));}
      if(prefs.interests.length)extra.push(...(await findCandidates(db,prefs.interests[0])).map(custom));
    }catch{}
  }
  return choose([...extra,...catalog],bestsellers,prefs,gone);
}
module.exports={preferences,choose,discover,distinct,slugOf,withTimeout};
