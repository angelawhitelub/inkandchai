const { createHash } = require('crypto');
const bindings = require('../../../worker/shims/runtime-bindings');
const PREFIX='search-events:v1:', RETENTION=30*86400;
function safeQuery(value) {
  if(typeof value!=='string')return '';
  const q=value.normalize('NFKC').replace(/[\u0000-\u001f\u007f]/g,' ').replace(/\s+/g,' ').trim().slice(0,120).toLowerCase();
  // Searches are product demand signals, never a place to store contact/order details.
  if(q.length<2||/@|https?:|www\.|\bIC[-\s]?(?:CW[-\s]?)?\d{6,}/i.test(q))return '';
  const digits=q.replace(/[\s-]/g,'');
  const isbn13=/^97[89]\d{10}$/.test(digits)&&[...digits].reduce((sum,c,i)=>sum+Number(c)*(i%2?3:1),0)%10===0;
  const isbn10=/^\d{9}[\dX]$/i.test(digits)&&[...digits].reduce((sum,c,i)=>sum+(c.toUpperCase()==='X'?10:Number(c))*(10-i),0)%11===0;
  if(/(?:\d[\s()+-]*){7,}/.test(q)&&!isbn13&&!isbn10)return '';
  return q;
}
function normalise(body) {
  const q=safeQuery(body.q);
  if(!q||!['search','click'].includes(body.kind)||!/^[a-zA-Z0-9_-]{12,80}$/.test(body.id||''))return null;
  const source=['home','overlay','product','books'].includes(body.source)?body.source:'home';
  const result_count=Number.isInteger(body.result_count)&&body.result_count>=0?Math.min(100000,body.result_count):null;
  const product=body.kind==='click'&&/^\/product\/[a-z0-9-]{1,200}\/$/.test(body.product||'')?body.product:null;
  if(body.kind==='click'&&!product)return null;
  return {q,kind:body.kind,source,result_count,product,at:new Date().toISOString()};
}
async function record(event,body) {
  const item=normalise(body);if(!item)return {statusCode:204};
  const kv=bindings.get('ORDER_FALLBACK'),limiter=bindings.get('INK_AI_LIMIT');
  if(!kv||!limiter)return {statusCode:503};
  const ip=event.headers?.['cf-connecting-ip']||event.headers?.['x-nf-client-connection-ip']||'unknown';
  const key='search-events:'+createHash('sha256').update(ip).digest('hex');
  const gate=await limiter.get(limiter.idFromName(key)).fetch('https://limit/?limit=30&window=60');
  if(!(await gate.json()).allowed)return {statusCode:429};
  const id=createHash('sha256').update(body.id+':'+body.kind).digest('hex');
  await kv.put(PREFIX+item.at.slice(0,10)+':'+id,'1',{metadata:item,expirationTtl:RETENTION});
  return {statusCode:204};
}
function aggregate(events) {
  const groups=new Map();let searches=0,clicks=0,unmatched=0;
  for(const e of events){
    if(!safeQuery(e.q)||!['search','click'].includes(e.kind))continue;
    const r=groups.get(e.q)||{query:e.q,searches:0,clicks:0,unmatched:0,last_seen:e.at};
    if(e.kind==='search'){r.searches++;searches++;if(e.result_count===0){r.unmatched++;unmatched++;}}
    else {r.clicks++;clicks++;}
    if(e.at>r.last_seen)r.last_seen=e.at;
    groups.set(e.q,r);
  }
  return {searches,clicks,unmatched,queries:[...groups.values()].sort((a,b)=>b.searches-a.searches||b.clicks-a.clicks||a.query.localeCompare(b.query))};
}
async function report(days) {
  const kv=bindings.get('ORDER_FALLBACK');if(!kv)throw Error('Search recording is unavailable.');
  const since=Date.now()-days*86400000,events=[];let truncated=false;
  outer:for(let d=0;d<=days;d++){
    const day=new Date(Date.now()-d*86400000).toISOString().slice(0,10);let cursor;
    do {
      const page=await kv.list({prefix:PREFIX+day+':',limit:1000,...(cursor?{cursor}:{})});
      for(const k of page.keys||[])if(k.metadata&&Date.parse(k.metadata.at)>=since)events.push(k.metadata);
      cursor=page.list_complete?undefined:page.cursor;
      if(events.length>=20000){truncated=true;break outer;}
    }while(cursor);
  }
  return {...aggregate(events),days,truncated,retention_days:30,generated_at:new Date().toISOString()};
}
module.exports={safeQuery,normalise,record,report,aggregate};
