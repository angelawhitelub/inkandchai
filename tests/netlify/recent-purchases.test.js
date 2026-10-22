const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname,'../..');
function fixture({failed=false,disabled=false,empty=false}={}) {
 const queries=[];
 const data = empty?[]:[{id:'private-id',customer_name:'Sahil Secret',customer_phone:'private-phone',status:'paid',source:null,created_at:new Date(Date.now()-60000).toISOString(),amount_paise:40000,cart_items:[{slug:'test-hardcover'}]}];
 const db={from(table){const q={};for(const key of ['select','or','in','gte','order','limit'])q[key]=(...args)=>{queries.push([table,key,...args]);return q};q.then=(resolve,reject)=>Promise.resolve(failed?{error:new Error('secret database error')}:{data:table==='orders'?data:[{slug:'test-hardcover',title:'Correct Hardcover',image_url:'/cover.jpg',is_active:!disabled}]}).then(resolve,reject);return q}};
 const module={exports:{}};
 const req=id=>{
  if(id==='@supabase/supabase-js')return {createClient:()=>db};
  if(id==='./utils/deleted-products')return {deletedSlugSet:async()=>new Set()};
  if(id==='./utils/pricing')return {makeSlug:()=>''};
  if(id==='fs')return {readFileSync:()=> '[]'};
  if(id.startsWith('./'))return require(path.join(root,'netlify/functions',id));
  return require(id);
 };
 vm.runInNewContext(fs.readFileSync(path.join(root,'netlify/functions/recent-purchases.js'),'utf8'),{require:req,module,exports:module.exports,process:{env:{SUPABASE_URL:'https://test.invalid',SUPABASE_SERVICE_KEY:'private-key'},cwd:()=>root},Date,console:{warn(){}}});
 return {handler:module.exports.handler,queries};
}
test('public endpoint uses admin order store, bounded query and safe projection',async()=>{
 const {handler,queries}=fixture();const r=await handler({httpMethod:'GET'});assert.equal(r.statusCode,200);
 const p=JSON.parse(r.body).purchases;assert.equal(p.length,1);assert.equal(p[0].title,'Correct Hardcover');
 assert(!r.body.includes('private'));assert(!r.body.includes('Secret'));
 assert(queries.some(q=>q[0]==='orders'&&q[1]==='or'&&q[2]==='source.is.null,source.neq.paperbound'));
 assert(queries.some(q=>q[0]==='orders'&&q[1]==='limit'&&q[2]===100));
 assert.equal(r.headers['Cache-Control'],'no-store');assert.equal(r.headers['Netlify-CDN-Cache-Control'],'public, s-maxage=15');
});
test('empty and disabled products do not invent purchases',async()=>{
 for(const config of [{empty:true},{disabled:true}]){const r=await fixture(config).handler({httpMethod:'GET'});assert.equal(r.statusCode,200);assert.deepEqual(JSON.parse(r.body).purchases,[])}
});
test('database errors fail closed without exposing diagnostics',async()=>{
 const r=await fixture({failed:true}).handler({httpMethod:'GET'});assert.equal(r.statusCode,503);assert.deepEqual(JSON.parse(r.body).purchases,[]);assert(!r.body.includes('secret'));assert.equal(r.headers['Cache-Control'],'no-store');assert.equal(r.headers['Netlify-CDN-Cache-Control'],undefined);
});
test('does not expose writes',async()=>{assert.equal((await fixture().handler({httpMethod:'POST'})).statusCode,405)});
