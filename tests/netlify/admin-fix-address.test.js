const {test}=require('node:test');const assert=require('node:assert/strict');const vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
function fixture({blocked=false,changed=false}={}){
 const calls=[];const order={id:'row-1',status:'paid',customer_address:changed?'new manual edit':'corrected'};
 const module={exports:{}};const req=id=>{
  if(id==='@supabase/supabase-js')return {createClient:()=>({from:()=>({select:()=>({eq:()=>({maybeSingle:async()=>({data:order})})})})})};
  if(id==='./utils/admin-auth')return {requireAdmin:()=>blocked?{statusCode:401,body:'Unauthorized'}:null};
  if(id==='./utils/address-fixer')return {fixOrderAddress:async()=>{calls.push('fix');return {status:'fixed',corrected:'fixed value'}},saveAddress:async(db,o,a)=>{calls.push(['save',a])}};
  if(id==='@netlify/blobs')return {getStore:()=>({get:async()=>({order_id:'row-1',original:'original',corrected:'corrected'})})};
  throw Error(id);
 };
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../../netlify/functions/admin-fix-address.js'),'utf8'),{module,exports:module.exports,require:req,process:{env:{}}});
 return {handler:module.exports.handler,calls};
}
test('requires admin access before order lookup or AI call',async()=>{const f=fixture({blocked:true});assert.equal((await f.handler({httpMethod:'POST',body:'{"id":"row-1"}'})).statusCode,401);assert.deepEqual(f.calls,[])});
test('validates body and action',async()=>{const f=fixture();for(const body of ['{','{}','{"id":"row-1","action":"erase"}'])assert.equal((await f.handler({httpMethod:'POST',body})).statusCode,400);assert.deepEqual(f.calls,[])});
test('fix saves through guarded helper and returns private no-store response',async()=>{const f=fixture(),r=await f.handler({httpMethod:'POST',body:'{"id":"row-1"}'});assert.equal(r.statusCode,200);assert.equal(r.headers['Cache-Control'],'no-store');assert.deepEqual(f.calls,['fix'])});
test('undo requires this order and unchanged corrected address',async()=>{
 let f=fixture();let r=await f.handler({httpMethod:'POST',body:JSON.stringify({id:'row-1',action:'undo',audit_id:'row-2/wrong'})});assert.equal(r.statusCode,400);assert.deepEqual(f.calls,[]);
 f=fixture({changed:true});r=await f.handler({httpMethod:'POST',body:JSON.stringify({id:'row-1',action:'undo',audit_id:'row-1/audit'})});assert.equal(r.statusCode,409);assert.deepEqual(f.calls,[]);
 f=fixture();r=await f.handler({httpMethod:'POST',body:JSON.stringify({id:'row-1',action:'undo',audit_id:'row-1/audit'})});assert.equal(r.statusCode,200);assert.deepEqual(f.calls,[['save','original']]);
});
