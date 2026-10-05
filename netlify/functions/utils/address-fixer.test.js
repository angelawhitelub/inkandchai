const {test}=require('node:test');
const assert=require('node:assert/strict');
const {evaluate,analyse,postal,canFix,saveAddress,fixOrderAddress}=require('./address-fixer');
const address='Ahmed sailor bldg no.1. room no 29, 1st floor, govindji keni rd, hindmata, dadar(E). 400014, Mumbai, Maharashtra, 400010';
const candidates=[{pincode:'400014',offices:[{name:'Dadar',district:'Mumbai',state:'Maharashtra'}]},{pincode:'400010',offices:[{name:'Mazgaon',district:'Mumbai',state:'Maharashtra'}]}];
const yes={pincode:'400014',confidence:'high',needs_review:false};
test('screenshot conflict selects verified Dadar PIN and preserves room/street details',()=>{
 const r=evaluate(address,candidates,yes);assert.equal(r.status,'fixed');assert(r.corrected.includes('room no 29'));assert(r.corrected.includes('govindji keni rd'));assert(r.corrected.endsWith(', 400014'));assert(!r.corrected.includes('400010'));assert.equal((r.corrected.match(/400014/g)||[]).length,1);assert.equal(r.original,address);
});
test('AI confidence alone cannot override conflicting or missing locality evidence',()=>{
 for(const text of ['Flat 29, Mumbai, Maharashtra, 400014, 400010','Dadar, near Mazgaon, Mumbai, Maharashtra, 400014, 400010'])assert.equal(evaluate(text,candidates,yes).status,'review');
 assert.equal(evaluate(address,candidates,{...yes,pincode:'400010'}).status,'review');
 assert.equal(evaluate(address,candidates,{...yes,pincode:'999999'}).status,'review');
 assert.equal(evaluate(address,candidates,{...yes,confidence:'low'}).status,'review');
 assert.equal(evaluate(address,candidates,{...yes,needs_review:true}).status,'review');
});
test('never deletes six-digit house/room numbers or changes destination state',()=>{
 assert.equal(evaluate('room no 400010, '+address,candidates,yes).status,'review');
 assert.equal(evaluate(address.replace('Maharashtra','Karnataka'),candidates,yes).status,'review');
});
test('locks all exported/shipped/closed orders',()=>{
 assert(canFix({status:'paid'}));
 for(const f of ['tracking_id','shipped_at','nimbus_pushed_at','ithink_pushed_at','xpressbees_feed_at'])assert(!canFix({status:'paid',[f]:'set'}));
 for(const status of ['shipped','cancelled','delivered','refunded','refund_pending'])assert(!canFix({status}));
});
test('save is conditional on original address, status and every courier marker',async()=>{
 const calls=[];let resolveData=[{id:'id'}];const q={};
 for(const m of ['update','eq','is'])q[m]=(...a)=>{calls.push([m,...a]);return q};q.select=async()=>({data:resolveData});
 const db={from:()=>q},order={id:'id',status:'paid',customer_address:address,tracking_id:null,nimbus_pushed_at:null};
 await saveAddress(db,order,'corrected');assert.equal(order.customer_address,'corrected');
 assert(calls.some(c=>c[0]==='eq'&&c[1]==='customer_address'&&c[2]===address));assert(calls.some(c=>c[0]==='is'&&c[1]==='tracking_id'));
 resolveData=[];await assert.rejects(saveAddress(db,order,'other'),/Order changed/);assert.equal(order.customer_address,'corrected');
});
test('single PIN does not call AI; missing PIN requires review',async()=>{
 const opts={fetchImpl:()=>{throw new Error('must not call')}};
 assert.equal((await analyse('29, Dadar, Mumbai, Maharashtra, 400014',opts)).status,'unchanged');
 assert.equal((await analyse('29, Dadar, Mumbai, Maharashtra',opts)).status,'review');
});
test('postal outage/invalid record never becomes evidence',async()=>{
 await assert.rejects(postal('400014',async()=>({ok:false})),/Postal lookup/);
 await assert.rejects(postal('400014',async()=>({ok:true,json:async()=>[{Status:'Success',PostOffice:[{Pincode:'400010',Name:'Dadar'}]}]})),/No matching/);
});
test('structured AI response is independently verified; phone/order data is not supplied',async()=>{
 const previous=process.env.OPENAI_API_KEY;process.env.OPENAI_API_KEY='test';let body;
 const fetchImpl=async(url,opts)=>{
  if(url.includes('postalpincode')){const pin=url.split('/').pop(),c=candidates.find(c=>c.pincode===pin);return {ok:true,json:async()=>[{Status:'Success',PostOffice:c.offices.map(o=>({Pincode:pin,Name:o.name,District:o.district,State:o.state}))}]};}
  body=JSON.parse(opts.body);return {ok:true,json:async()=>({choices:[{finish_reason:'stop',message:{content:JSON.stringify(yes)}}]})};
 };
 try{const r=await analyse(address,{fetchImpl});assert.equal(r.status,'fixed');assert.equal(body.store,false);assert.equal(body.response_format.json_schema.strict,true);assert.deepEqual(Object.keys(JSON.parse(body.messages[1].content)),['address','postal_records']);}
 finally{if(previous===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=previous;}
});
test('audit failure prevents any address mutation',async()=>{
 const previous=process.env.OPENAI_API_KEY;process.env.OPENAI_API_KEY='test';
 try {await assert.rejects(fixOrderAddress({from(){throw Error('must not write')}},{id:'id',status:'paid',customer_address:address},{force:true,store:{setJSON:async()=>{throw Error('audit unavailable')}}}),/audit unavailable/)}
 finally{if(previous===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=previous;}
});
