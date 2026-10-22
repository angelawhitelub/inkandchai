const {test,beforeEach}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const bindings=require('../../worker/shims/runtime-bindings');
const {evidence,beginClaim}=require('../../netlify/functions/utils/customer-claim');
const photo='data:image/png;base64,'+Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),Buffer.alloc(210)]).toString('base64');
const original={id:'row-1',razorpay_order_id:'IC-1',source:'web'};
let states;
beforeEach(async()=>{
 states=new Map();
 const {ClaimGuard}=await import('data:text/javascript;base64,'+Buffer.from(fs.readFileSync('worker/claim-guard.js','utf8')).toString('base64'));
 bindings.bindEnv({CUSTOMER_CLAIMS:{idFromName:name=>name,get(name){
   if(!states.has(name)) {
     const data=new Map();let pending=Promise.resolve();
     const ctx={storage:{get:async k=>data.get(k),put:async(k,v)=>data.set(k,v),delete:async k=>data.delete(k)},
       blockConcurrencyWhile(fn){const result=pending.then(fn);pending=result.catch(()=>{});return result;}};
     states.set(name,new ClaimGuard(ctx));
   }
   return {fetch:(url,init)=>states.get(name).fetch(new Request(url,init))};
 }}});
});
function database({prior=[],missing=false,queryError=false,uploadError=false}={}) {
 const metrics={uploads:0};
 return {metrics,from(){const q={select(){return q},eq(){return q},single:async()=>({data:{cart_items:missing?[{_missing:true}]:[]},error:queryError?new Error('db'):null}),limit:async()=>({data:prior,error:queryError?new Error('db'):null})};return q;},storage:{from(){return {upload:async()=>{metrics.uploads++;return {error:uploadError?new Error('offline'):null}},getPublicUrl:path=>({data:{publicUrl:'https://example.test/'+path}})};}}};
}
test('evidence is mandatory, bounded and checked beyond the MIME label',()=>{
 for(const input of [undefined,[],[photo,photo,photo,photo],['https://example.test/image.png'],['data:image/png;base64,'+Buffer.alloc(250).toString('base64')]])assert.throws(()=>evidence(input),e=>e.statusCode===400);
 assert.equal(evidence([photo]).length,1);
});
test('same-order concurrent requests reserve exactly once; other orders remain eligible',async()=>{
 const db=database();const results=await Promise.allSettled([beginClaim(db,original,[photo]),beginClaim(db,original,[photo])]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.find(r=>r.status==='rejected').reason.statusCode,409);
 const claim=results.find(r=>r.status==='fulfilled').value;await claim.complete();
 await assert.rejects(beginClaim(db,original,[photo]),e=>e.statusCode===409);
 const other=await beginClaim(db,{...original,id:'row-2',razorpay_order_id:'IC-2'},[photo]);assert.equal(other.photos.length,1);
});
test('existing replacement and missing reports block both claim types before upload',async()=>{
 for(const options of [{prior:[{razorpay_order_id:'IC-R-1'}]},{missing:true}]) {
 const db=database(options);await assert.rejects(beginClaim(db,original,[photo]),e=>e.statusCode===409);assert.equal(db.metrics.uploads,0);
 }
});
test('database and upload failures fail closed and permit a safe retry',async()=>{
 for(const options of [{queryError:true},{uploadError:true}])await assert.rejects(beginClaim(database(options),original,[photo]),e=>e.statusCode===503);
 const claim=await beginClaim(database(),original,[photo]);assert.match(claim.photos[0],/replacement-photos/);await claim.release();
 assert.equal((await beginClaim(database(),original,[photo])).photos.length,1);
});
test('replacement-of-replacement is rejected; admin may fulfil a recorded report but not duplicate an order',async()=>{
 await assert.rejects(beginClaim(database(),{...original,source:'replacement'},[photo]),e=>e.statusCode===409);
 const claim=await beginClaim(database({missing:true}),original,[photo],{allowRecordedReport:true});await claim.complete();
 await assert.rejects(beginClaim(database(),original,[photo],{allowRecordedReport:true}),e=>e.statusCode===409);
});
test('missing durable binding cannot silently disable duplicate protection',async()=>{
 bindings.bindEnv({});await assert.rejects(beginClaim(database(),original,[photo]),e=>e.statusCode===503);
});
test('missing-book path saves evidence with the report and replacement, and refuses a second report',async()=>{
 const {fileMissingBookReport}=require('../../netlify/functions/utils/missing-book-report');
 const order={...original,cart_items:[{title:'Book A',qty:1,price:199}]};
 const db=database();let inserted,stamped;
 db.from=()=>{let mode;const q={select(){return q},eq(){return q},limit(){return q},single:async()=>({data:order}),maybeSingle:async()=>({data:inserted||null}),
 update(value){stamped=value;mode='update';return q},insert(value){inserted=value;mode='insert';return q},
 then(resolve){resolve({data:mode?null:inserted?[inserted]:[],error:null})}};return q;};
 const opts={valid:[{title:'Book A',qty:1,item:order.cart_items[0]}],comment:'One book was missing',photos:[photo]};
 await assert.rejects(fileMissingBookReport(db,order,{...opts,photos:[]}),e=>e.statusCode===400);assert.equal(stamped,undefined);assert.equal(inserted,undefined);
 const result=await fileMissingBookReport(db,order,opts,{sendEmail:async()=>({ok:true}),sendWhatsApp:async()=>({ok:true}),sendText:async()=>({ok:true})});
 assert(result.replacement_order_id);assert.equal(inserted.cart_items[0]._replacement.photos.length,1);assert.equal(stamped.cart_items[0]._missing_photos.length,1);
 await assert.rejects(fileMissingBookReport(db,order,opts),e=>e.statusCode===409);
});
test('replacement endpoint enforces evidence and retains uploaded photo URLs',async()=>{
 const vm=require('node:vm');const {createRequire}=require('node:module');
 const path=require('node:path').resolve('netlify/functions/request-replacement.js');const realRequire=createRequire(path);
 const order={...original,customer_email:'test@example.test',status:'delivered',delivered_at:new Date().toISOString(),cart_items:[{title:'Book A',qty:1}]};
 const db=database();let inserted;
 db.auth={getUser:async()=>({data:{user:{id:'user-1',email:order.customer_email}}})};
 db.from=()=>{let insert=false;const q={select(){return q},eq(){return q},limit(){return q},maybeSingle:async()=>({data:order}),single:async()=>({data:insert?inserted:order}),insert(value){inserted=value;insert=true;return q},then(resolve){resolve({data:inserted?[inserted]:[],error:null})}};return q;};
 const sandbox={exports:{},require(name){if(name==='@supabase/supabase-js')return {createClient:()=>db};if(name==='./utils/email')return {sendEmail:async()=>({ok:true})};if(name==='./utils/whatsapp')return {sendWhatsApp:async()=>({ok:true})};return realRequire(name);},process:{env:{}},console};
 vm.runInNewContext(fs.readFileSync(path,'utf8'),sandbox);
 const event={httpMethod:'POST',headers:{authorization:'Bearer valid'},body:JSON.stringify({original_order_id:order.razorpay_order_id,reason:'damaged',note:'The cover arrived damaged'})};
 assert.equal((await sandbox.exports.handler(event)).statusCode,400);assert.equal(inserted,undefined);
 event.body=JSON.stringify({...JSON.parse(event.body),photos:[photo]});assert.equal((await sandbox.exports.handler(event)).statusCode,200);assert.equal(inserted.cart_items[0]._replacement.photos.length,1);
 assert.equal((await sandbox.exports.handler(event)).statusCode,409);
});
